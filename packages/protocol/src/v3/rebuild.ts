/**
 * Rebuilds and layout files (docs/protocol-v3.md, Sections 5 and 7).
 *
 * A rebuild merges sorted-record-files into fewer, larger, labeled ones and
 * creates the next layout. It changes where rows sit and nothing else: every
 * retained version reads the same before and after.
 *
 *   mergeFiles   the merge itself: labels, shared lines, thinning, takedown
 *   rebuild      plan, merge, and create the next layout
 *   planTiered   the starting policy: merge neighbouring groups of files by size tier
 *   recreate     write a commit's original files again from rebuilt ones
 *
 * A merged file's id comes from its key entries alone, so the merge reads key
 * blocks first, learns the id, and writes straight to `records/<id>`; a file
 * that is already stored is not written again. Memory per output file: its key
 * blocks compressed, and 48 bytes a line for where each line comes from.
 */
import { putFromParts, type Store } from '../repo/types.js'
import { sha256 } from '../sha256.js'
import {
  type BuildOptions,
  CUT_BYTES,
  DEFAULT_FILE_BYTES,
  type FileTarget,
  keyCut,
  recordKey,
  TYPE_CUT_BYTES,
} from './build.js'
import { MAX_FILE_ENTRIES, RECORD_BLOCK_BYTES } from './constants.js'
import {
  ContentBuilder,
  fileId,
  type FileRef,
  fileRef,
  footerBytes,
  SortedFileWriter,
  trailerBytes,
} from './file.js'
import { concatBytes, gzipMember } from './gz.js'
import { compareKeys, type Kind } from './lines.js'
import {
  type Commit,
  commitFiles,
  createLayout,
  findLayout,
  headNumber,
  type Layout,
  type LayoutFile,
  readLatest,
  readLog,
} from './log.js'
import {
  type Found,
  type MergeHooks,
  mergeGroups,
  type ReadOptions,
  type View,
  type ViewFile,
} from './read.js'
import { SortedFile } from './reader.js'
import { equalParts } from './util.js'

export interface MergeOptions extends ReadOptions {
  /**
   * The versions that stay readable at or below `through`, as ranges of commit
   * numbers. A row that none of them (and no version after `through`) sees is
   * dropped. Absent: every version stays.
   */
  retained?: [number, number][]
  through: number
  /**
   * Drop a removal that would be the oldest row for its key, if its commit is
   * before the oldest retained version. Only right when no file left out of the
   * merge can hold an older row for a key in its range. A removal written by a
   * retained version is never dropped: that version's changes and its original
   * file still need it.
   */
  dropLeadingRemovals?: boolean
  /** Records to withhold: their lines are left out and their entries kept, marked. */
  takedown?: (type: string, id: string, hash: string) => boolean
  /**
   * With a takedown: the keys it is for. A file none of them falls in cannot hold a row to
   * withhold, so it is kept as it is, and only the files that hold one are rewritten.
   * Without this a takedown rewrites every file it is given.
   */
  takedownKeys?: { type: string; id: string }[]
  /** The cap: close an output file once its lines reach this many bytes. Default four times `CUT_BYTES`. */
  maxBytes?: number
  /** Close an output file once it has this many entries. Default 262,144. */
  maxEntries?: number
  /** Close an output file where the type changes, once it holds this many bytes. Default 16 MiB. */
  typeCutBytes?: number
  /** Cut output by key (`keyCut`) toward this many bytes of lines a file, so equal stretches get equal files. Default `CUT_BYTES`, as for an upload. */
  cutBytes?: number
  /**
   * Keep, as it is, any input file whose key range no other input has an entry
   * in: it has no changes, so there is nothing to merge into it. Not with
   * thinning, which may have to rewrite any file, nor with a takedown unless
   * `takedownKeys` says which keys it is for.
   */
  keepUntouched?: boolean
  level?: number
}

export interface MergeResult {
  /** Inputs left as they are (`keepUntouched`). */
  kept: ViewFile[]
  files: LayoutFile[]
  /** Bytes of files written (stored size), and of those skipped because they were already stored. */
  written: number
  skipped: number
  /** Entries read from the inputs, and entries dropped by thinning. */
  entriesIn: number
  dropped: number
}

export const REBUILD_FILE_ENTRIES = 262_144

/** Whether any retained version sees a row written by `commit` and replaced by `next`. */
function seen(
  commit: number,
  next: number | null,
  through: number,
  retained: [number, number][] | undefined,
): boolean {
  // The row is seen by versions commit … next − 1. Versions after `through` are always kept.
  if (next === null || next - 1 > through || !retained) return true
  const last = next - 1
  return retained.some(([lo, hi]) => lo <= last && commit <= hi)
}

/** One output file in the making: its content, and where each of its lines comes from. */
class Draft {
  readonly content = new ContentBuilder(true)
  readonly keyBlocks: Promise<Uint8Array>[] = []
  /** For each line: the input file, the record block, the offset in it, the size. */
  src = new Uint32Array(4 * 4096)
  hashes = new Uint8Array(32 * 4096)
  lines = 0

  constructor(readonly level: number | undefined) {}

  add(f: Found, kind: Kind, input: number): void {
    const e = f.entry
    const placed = this.content.add(kind, e.type, e.id, e.hash, e.size, e.commit)
    for (const kb of this.content.takeKeyBlocks()) this.keyBlocks.push(gzipMember(kb, this.level))
    if (!placed.newLine) return
    if ((this.lines + 1) * 4 > this.src.length) {
      const src = new Uint32Array(this.src.length * 2)
      src.set(this.src)
      this.src = src
      const hashes = new Uint8Array(this.hashes.length * 2)
      hashes.set(this.hashes)
      this.hashes = hashes
    }
    this.src.set([input, e.block!, e.offset!, e.size], this.lines * 4)
    if (kind === 'r') {
      for (let i = 0; i < 32; i++) {
        this.hashes[this.lines * 32 + i] = parseInt(e.hash!.slice(i * 2, i * 2 + 2), 16)
      }
    }
    this.lines++
  }
}

/**
 * Merge files into labeled files. Inputs are files of one collection, each with
 * the commits its rows count as written by. Outputs are cut by key range.
 */
export async function mergeFiles(
  store: Store,
  inputs: ViewFile[],
  opts: MergeOptions,
): Promise<MergeResult> {
  // The same cut as an upload's, so one rule says where every file ends.
  const cutBytes = opts.cutBytes ?? CUT_BYTES
  const maxBytes = opts.maxBytes ?? DEFAULT_FILE_BYTES
  const maxEntries = Math.min(opts.maxEntries ?? REBUILD_FILE_ENTRIES, MAX_FILE_ENTRIES)
  const typeCut = opts.typeCutBytes ?? TYPE_CUT_BYTES
  const result: MergeResult = {
    kept: [],
    files: [],
    written: 0,
    skipped: 0,
    entriesIn: 0,
    dropped: 0,
  }
  const index = new Map(inputs.map((f, i) => [f.id, i]))
  const all: View = {
    collection: '',
    version: Number.MAX_SAFE_INTEGER,
    head: 0,
    layout: 0,
    through: 0,
    files: inputs,
  }
  const read: ReadOptions = {
    ...(opts.cache ? { cache: opts.cache } : {}),
    ...(opts.verify === undefined ? {} : { verify: opts.verify }),
  }

  /** Write a finished draft to `records/<id>`, unless a file with that id is already stored. */
  const close = async (d: Draft) => {
    const content = d.content.finish()
    for (const kb of d.content.takeKeyBlocks()) d.keyBlocks.push(gzipMember(kb, opts.level))
    const id = fileId(content)
    const key = recordKey(id)
    const stored = await store.head(key)
    let size = stored?.size ?? 0
    if (stored) result.skipped += stored.size
    else {
      size = 0
      const stream = (async function* () {
        const recordLengths: number[] = []
        // Each input's lines are wanted in the order they sit in it, so one reader each, reading ahead.
        const readers = new Map<number, ReturnType<SortedFile['reader']>>()
        const used = new Set<number>()
        for (let i = 0; i < d.lines; i++) used.add(d.src[i * 4]!)
        const readAhead = Math.max(
          RECORD_BLOCK_BYTES,
          Math.min(4 * 1024 * 1024, Math.floor((32 * 1024 * 1024) / Math.max(1, used.size))),
        )
        let chunks: Uint8Array[] = []
        let bytes = 0
        const nl = new Uint8Array([0x0a])
        for (let i = 0; i < d.lines; i++) {
          const [input, block, offset, lineSize] = d.src.subarray(i * 4, i * 4 + 4)
          let reader = readers.get(input!)
          if (!reader) {
            const f = inputs[input!]!
            const file = opts.cache
              ? await opts.cache.open(store, f.id)
              : await SortedFile.open(store, recordKey(f.id), { id: f.id })
            reader = file.reader({ readAhead, verify: false })
            readers.set(input!, reader)
          }
          const raw = await reader.recordBlock(block!)
          const line = raw.subarray(offset!, offset! + lineSize!)
          if (raw[offset! + lineSize!] !== 0x0a)
            throw new Error(`${key}: input line has no newline`)
          // A removal's line is fixed by its key; a record's must still hash to its entry.
          const want = d.hashes.subarray(i * 32, i * 32 + 32)
          if (want.some((b) => b !== 0)) {
            const got = sha256(line)
            for (let k = 0; k < 32; k++) {
              if (got[k] !== want[k])
                throw new Error(`${key}: an input line does not match its hash`)
            }
          }
          chunks.push(line.slice(), nl)
          bytes += lineSize! + 1
          if (bytes >= RECORD_BLOCK_BYTES) {
            const gz = await gzipMember(concatBytes(chunks, bytes), opts.level)
            recordLengths.push(gz.byteLength)
            yield gz
            chunks = []
            bytes = 0
          }
        }
        if (bytes > 0) {
          const gz = await gzipMember(concatBytes(chunks, bytes), opts.level)
          recordLengths.push(gz.byteLength)
          yield gz
        }
        const keyLengths: number[] = []
        for (const p of d.keyBlocks) {
          const gz = await p
          keyLengths.push(gz.byteLength)
          yield gz
        }
        const footer = await gzipMember(
          footerBytes(content, { recordBlocks: recordLengths, keyBlocks: keyLengths }),
          opts.level,
        )
        yield footer
        yield trailerBytes(footer.byteLength)
      })()
      const counted = (async function* () {
        for await (const chunk of stream) {
          size += chunk.byteLength
          yield chunk
        }
      })()
      await putFromParts(store, key, equalParts(counted), { ifAbsent: true })
      result.written += size
    }
    result.files.push({
      ...fileRef(id, content),
      labeled: true,
      commits: content.commits ?? [0, 0],
      size,
    })
  }

  // The oldest version that stays readable: 1 unless history has been thinned.
  const oldest = opts.retained ? (opts.retained[0]?.[0] ?? opts.through + 1) : 1
  let draft: Draft | null = null
  let lastType: string | null = null
  /** The key before the one in hand, with the size of its newest row: what decides a cut. */
  let lastKey: { type: string; id: string; size: number } | null = null
  const keys = opts.takedownKeys
  const holdsKey = (file: ViewFile): boolean =>
    !!keys &&
    !!file.first &&
    !!file.last &&
    keys.some(
      (k) =>
        compareKeys(file.first![0], file.first![1], k.type, k.id) <= 0 &&
        compareKeys(k.type, k.id, file.last![0], file.last![1]) <= 0,
    )
  const hooks: MergeHooks =
    !opts.retained && (opts.takedown ? !!keys : opts.keepUntouched)
      ? {
          // A file with its key range to itself: the output so far ends before it, and it stays.
          // In a takedown, not if one of the keys falls in it: that file is rewritten.
          skipFile: async (file) => {
            if (holdsKey(file)) return false
            if (draft) await close(draft)
            draft = null
            result.kept.push(file)
            return true
          },
        }
      : {}
  for await (const group of mergeGroups(
    store,
    all,
    {},
    { ...read, readAhead: 1024 * 1024 },
    inputs,
    hooks,
  )) {
    result.entriesIn += group.length
    // Thin: keep a row only if a retained version sees it.
    let kept: Found[] = []
    for (let i = 0; i < group.length; i++) {
      const f = group[i]!
      const next = group[i + 1]
      if (next && next.entry.commit === f.entry.commit) {
        // The same commit's row in two inputs: the same row, or the inputs are not one collection's.
        if (next.entry.kind !== f.entry.kind || next.entry.hash !== f.entry.hash) {
          throw new Error(
            `Two rows for ${JSON.stringify([f.entry.type, f.entry.id])} at commit ${f.entry.commit}`,
          )
        }
        continue
      }
      if (seen(f.entry.commit, next ? next.entry.commit : null, opts.through, opts.retained)) {
        kept.push(f)
      }
    }
    if (opts.dropLeadingRemovals && oldest > 1) {
      let first = 0
      while (
        first < kept.length &&
        kept[first]!.entry.kind === 'x' &&
        kept[first]!.entry.commit < oldest
      ) {
        first++
      }
      if (first > 0) kept = kept.slice(first)
    }
    result.dropped += group.length - kept.length
    if (kept.length === 0) continue
    const type = kept[0]!.entry.type
    if (draft) {
      const c: ContentBuilder = (draft as Draft).content
      const full = c.bytes >= maxBytes || c.entries + kept.length > maxEntries
      const byKey = lastKey !== null && keyCut(lastKey.type, lastKey.id, lastKey.size, cutBytes)
      if (full || byKey || (type !== lastType && c.bytes >= typeCut)) {
        await close(draft)
        draft = null
      }
    }
    draft ??= new Draft(opts.level)
    lastType = type
    lastKey = { type, id: kept[0]!.entry.id, size: kept[kept.length - 1]!.entry.size }
    for (const f of kept) {
      const e = f.entry
      const withheld =
        e.kind === 'w' || (e.kind === 'r' && opts.takedown?.(e.type, e.id, e.hash!) === true)
      draft.add(f, withheld ? 'w' : e.kind, index.get(f.reader.file.id)!)
    }
  }
  if (draft) await close(draft)
  return result
}

// --- Layouts and the policy ---

/**
 * A group of a layout's files: the sorted-record-files one rebuild wrote, or one
 * commit's own. Their key ranges don't overlap, so a record is in at most one
 * file of a group, and a read checks one file for each group.
 */
export interface FileGroup {
  /** A number shared by the files one merge wrote; 0 for a commit's own files. */
  group: number
  files: LayoutFile[]
  commits: [number, number]
  /** Bytes of lines, uncompressed. */
  bytes: number
}

/** A layout's files in their groups, oldest first. */
export function groupsOf(files: LayoutFile[]): FileGroup[] {
  const by = new Map<string, FileGroup>()
  for (const f of files) {
    const group = f.group ?? 0
    const k = group === 0 ? `c${f.commits[0]}` : `g${group}`
    let r = by.get(k)
    if (!r) by.set(k, (r = { group, files: [], commits: [f.commits[0], f.commits[1]], bytes: 0 }))
    r.files.push(f)
    r.commits[0] = Math.min(r.commits[0], f.commits[0])
    r.commits[1] = Math.max(r.commits[1], f.commits[1])
    r.bytes += f.bytes
  }
  return [...by.values()].sort((a, b) => a.commits[0] - b.commits[0])
}

export interface TierOptions {
  /** Groups of one tier that are merged together. Default 10. */
  ratio?: number
  /** Groups up to this many bytes of lines are tier 0; each tier above is `ratio` times larger. */
  baseBytes?: number
}

export const tierOf = (bytes: number, ratio: number, baseBytes: number): number =>
  bytes <= baseBytes ? 0 : Math.ceil(Math.log(bytes / baseBytes) / Math.log(ratio) - 1e-9)

/**
 * The starting policy. Groups are in commit order. For each size tier, lowest
 * first: where `ratio` or more neighbouring groups are each at or below the tier,
 * merge them, the newest such group first. A group is left alone unless
 * together they are at least twice the largest of them, so one large group is not
 * rewritten again and again to take in small ones (they merge with each other
 * first). Returns the groups to merge, or null if there is nothing to do.
 *
 * Uploads of one size merge in tens, then tens of tens: each byte is rewritten
 * about once a tier. Uploads of uneven size still merge, since a smaller group
 * counts toward its larger neighbours' tier. Merged groups stay in commit order,
 * so a file's commit range still says which versions it can matter to.
 */
export function planTiered(groups: FileGroup[], opts: TierOptions = {}): FileGroup[] | null {
  const ratio = opts.ratio ?? 10
  const base = opts.baseBytes ?? 8 * 1024 * 1024
  const tiers = groups.map((r) => tierOf(r.bytes, ratio, base))
  for (const tier of [...new Set(tiers)].sort((a, b) => a - b)) {
    let end = groups.length
    while (end > 0) {
      if (tiers[end - 1]! > tier) {
        end--
        continue
      }
      let start = end - 1
      while (start > 0 && tiers[start - 1]! <= tier) start--
      const picked = groups.slice(start, end)
      if (picked.length >= ratio) {
        const total = picked.reduce((n, r) => n + r.bytes, 0)
        const largest = picked.reduce((n, r) => Math.max(n, r.bytes), 0)
        if (total >= 2 * largest) return picked
      }
      end = start
    }
  }
  return null
}

/** Merge adjacent or overlapping ranges, in order. */
export function normalizeRanges(ranges: [number, number][]): [number, number][] {
  const sorted = ranges.filter(([lo, hi]) => lo <= hi).sort((a, b) => a[0] - b[0])
  const out: [number, number][] = []
  for (const [lo, hi] of sorted) {
    const last = out[out.length - 1]
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi)
    else out.push([lo, hi])
  }
  return out
}

function intersectRanges(a: [number, number][], b: [number, number][]): [number, number][] {
  const out: [number, number][] = []
  for (const [alo, ahi] of a) {
    for (const [blo, bhi] of b) {
      const lo = Math.max(alo, blo)
      const hi = Math.min(ahi, bhi)
      if (lo <= hi) out.push([lo, hi])
    }
  }
  return normalizeRanges(out)
}

export interface RebuildOptions extends Omit<MergeOptions, 'through' | 'dropLeadingRemovals'> {
  /**
   * Which groups to merge, given the collection's groups oldest first. Each inner
   * list is merged into one group. Default: `planTiered`, one merge. Return an
   * empty list to merge nothing.
   */
  plan?: (groups: FileGroup[]) => FileGroup[][]
  tiers?: TierOptions
  /**
   * With nothing to merge, still write a layout once this many commits have
   * landed since the last one, so a reader opens one object, not that many.
   */
  adoptAfter?: number
  now?: () => Date
}

export interface RebuildResult {
  /** The layout created; null if there was nothing to do, or another rebuild got there first. */
  layout: Layout | null
  /** True if another rebuild took the layout number: this one's files are unlisted. */
  lost: boolean
  merges: number
  filesIn: number
  filesOut: number
  /** Input files a merge left as they were, because nothing had changed in their key range. */
  kept: number
  /** Stored bytes written, and stored bytes of outputs that already existed. */
  written: number
  skipped: number
  /** Bytes of lines read from the merged files. */
  bytesIn: number
  dropped: number
}

/** The collection's current files as a layout would list them: the layout's, then later commits'. */
export async function currentFiles(
  store: Store,
  collection: string,
): Promise<{ layout: Layout | null; head: number; files: LayoutFile[] }> {
  const latest = await readLatest(store, collection)
  const layout = await findLayout(store, collection, latest)
  const head = await headNumber(store, collection, latest)
  const files: LayoutFile[] = layout ? [...layout.files] : []
  const through = layout?.through ?? 0
  if (head > through) {
    for await (const c of readLog(store, collection, through + 1, head)) {
      for (const f of commitFiles(c.commit)) {
        files.push({ ...f, labeled: false, commits: [c.commit.number, c.commit.number], group: 0 })
      }
    }
  }
  return { layout, head, files }
}

const overlaps = (a: LayoutFile, b: LayoutFile): boolean =>
  a.first !== null &&
  a.last !== null &&
  b.first !== null &&
  b.last !== null &&
  compareKeys(a.first[0], a.first[1], b.last[0], b.last[1]) <= 0 &&
  compareKeys(b.first[0], b.first[1], a.last[0], a.last[1]) <= 0

/**
 * One round of rebuilding: plan, merge, and create the next layout. Commits
 * that land meanwhile are untouched; they come after the new layout's
 * `through`. Call again until `layout` comes back null to let merges cascade.
 */
export async function rebuild(
  store: Store,
  collection: string,
  opts: RebuildOptions = {},
): Promise<RebuildResult> {
  const { layout: old, head, files } = await currentFiles(store, collection)
  const result: RebuildResult = {
    layout: null,
    lost: false,
    merges: 0,
    filesIn: 0,
    filesOut: 0,
    kept: 0,
    written: 0,
    skipped: 0,
    bytesIn: 0,
    dropped: 0,
  }
  const groups = groupsOf(files)
  const plan =
    opts.plan?.(groups) ??
    (() => {
      const picked = planTiered(groups, opts.tiers)
      return picked ? [picked] : []
    })()
  const adopt = head - (old?.through ?? 0) >= (opts.adoptAfter ?? 8)
  // A change of what is retained, or a takedown, is only real once a layout states it.
  if (plan.length === 0 && !adopt && !opts.retained) return result

  const number = (old?.number ?? 0) + 1
  const through = head
  // Every version up to the old `through` that was retained, and every one since.
  let retained: [number, number][] | undefined = old?.retained
    ? normalizeRanges([...old.retained, [old.through + 1, through]])
    : undefined
  if (opts.retained) {
    retained = intersectRanges(retained ?? [[1, through]], opts.retained)
    if (retained.length === 1 && retained[0]![0] <= 1 && retained[0]![1] >= through) {
      retained = undefined
    }
  }

  const merged = new Set<string>()
  const outputs: LayoutFile[] = []
  // A group number is only a name for the files one merge wrote: unique within the layout.
  let nextGroup = 1 + files.reduce((n, f) => Math.max(n, f.group ?? 0), 0)
  for (const picked of plan) {
    const inputs = picked.flatMap((r) => r.files)
    for (const f of inputs) {
      if (merged.has(f.id)) throw new Error('A file is in two merges')
      merged.add(f.id)
    }
    const newest = Math.max(...picked.map((r) => r.commits[1]))
    // A removal with nothing older behind it can go only if no file left out could hold an older row.
    const older = files.some(
      (f) => !inputs.includes(f) && f.commits[0] < newest && inputs.some((i) => overlaps(f, i)),
    )
    const m = await mergeFiles(store, inputs, {
      ...opts,
      through,
      dropLeadingRemovals: !older,
      ...(retained ? { retained } : {}),
    })
    // A merge of one group keeps its number, so a takedown does not regroup the layout.
    const group = picked.length === 1 ? picked[0]!.group : nextGroup++
    for (const f of m.files) outputs.push({ ...f, group })
    // Files the merge left as they are stay listed, now as part of the merged group.
    for (const k of m.kept) outputs.push({ ...inputs.find((i) => i.id === k.id)!, group })
    result.kept += m.kept.length
    result.merges++
    result.filesIn += inputs.length
    result.filesOut += m.files.length
    result.written += m.written
    result.skipped += m.skipped
    const keptIds = new Set(m.kept.map((k) => k.id))
    result.bytesIn += inputs.reduce((n, f) => n + (keptIds.has(f.id) ? 0 : f.bytes), 0)
    result.dropped += m.dropped
  }

  const layout: Layout = {
    underlay: 3,
    collection,
    number,
    through,
    createdAt: (opts.now?.() ?? new Date()).toISOString(),
    files: [...files.filter((f) => !merged.has(f.id)), ...outputs].sort(
      (a, b) => a.commits[0] - b.commits[0] || cmpFirst(a, b),
    ),
    ...(retained ? { retained } : {}),
  }
  const won = await createLayout(store, layout)
  if (!won) return { ...result, lost: true }
  return { ...result, layout }
}

const cmpFirst = (a: LayoutFile, b: LayoutFile): number =>
  a.first && b.first ? compareKeys(a.first[0], a.first[1], b.first[0], b.first[1]) : 0

/** A plan that merges everything into one group. */
export const planAll = (groups: FileGroup[]): FileGroup[][] => (groups.length > 0 ? [groups] : [])

/**
 * A plan that rewrites, each on its own, the groups holding rows for some keys:
 * what a takedown needs.
 */
export async function planGroupsHolding(
  store: Store,
  groups: FileGroup[],
  keys: { type: string; id: string }[],
  opts: ReadOptions = {},
): Promise<FileGroup[][]> {
  const out: FileGroup[][] = []
  for (const g of groups) {
    let holds = false
    for (const f of g.files) {
      if (holds) break
      for (const k of keys) {
        if (
          !f.first ||
          !f.last ||
          compareKeys(f.first[0], f.first[1], k.type, k.id) > 0 ||
          compareKeys(k.type, k.id, f.last[0], f.last[1]) > 0
        ) {
          continue
        }
        const file = opts.cache
          ? await opts.cache.open(store, f.id)
          : await SortedFile.open(store, recordKey(f.id), { id: f.id })
        if ((await file.reader().lookup(k.type, k.id)).length > 0) {
          holds = true
          break
        }
      }
    }
    if (holds) out.push([g])
  }
  return out
}

// --- Recreating a commit's files ---

export interface Recreated {
  /** The file as the commit recorded it. */
  want: FileRef
  /** The id of the file made again from the rebuilt rows. */
  id: string
  matches: boolean
}

/**
 * Make a commit's original files again from files that hold its rows (a
 * layout's): take the rows labeled with its number, cut them where the commit's
 * files began, and write each part as an unlabeled file. Because the format
 * leaves a writer no choices, the ids match what the commit recorded.
 *
 * Without a `target` only the ids are worked out, from key entries alone.
 * A commit with a row that was thinned or withheld cannot be recreated in full;
 * its ids then do not match.
 */
export async function recreate(
  store: Store,
  files: ViewFile[],
  commit: Commit,
  opts: ReadOptions & { target?: FileTarget } & Pick<BuildOptions, 'level'> = {},
): Promise<Recreated[]> {
  const number = commit.number
  const wants = commitFiles(commit)
  const ranged = wants
    .filter((f) => f.first)
    .sort((a, b) => compareKeys(a.first![0], a.first![1], b.first![0], b.first![1]))
  const holding = files.filter((f) => f.commits[0] <= number && number <= f.commits[1])
  const view: View = {
    collection: commit.collection,
    version: number,
    head: number,
    layout: 0,
    through: 0,
    files: holding,
  }
  const out: Recreated[] = []
  // An empty file has one id, whatever commit named it.
  const emptyId = fileId(new ContentBuilder(false).finish())
  for (const f of wants) {
    if (!f.first) out.push({ want: f, id: emptyId, matches: f.id === emptyId })
  }
  if (ranged.length === 0) return out

  let part = 0
  let content = new ContentBuilder(false)
  let writer: SortedFileWriter | null = null
  let draft: Awaited<ReturnType<FileTarget['begin']>> | null = null
  const begin = async () => {
    content = new ContentBuilder(false)
    if (opts.target) {
      draft = await opts.target.begin()
      writer = new SortedFileWriter(draft, opts.level === undefined ? {} : { level: opts.level })
    }
  }
  const end = async () => {
    const want = ranged[part]!
    let id: string
    if (writer && draft) {
      id = (await writer.finish()).id
      if (id === want.id) await draft.keep(id)
      else await draft.discard()
    } else {
      id = fileId(content.finish())
    }
    out.push({ want, id, matches: id === want.id })
  }
  await begin()
  const range = {
    from: { type: ranged[0]!.first![0], id: ranged[0]!.first![1] },
  }
  const lastWant = ranged[ranged.length - 1]!.last!
  for await (const group of mergeGroups(store, view, range, { ...opts, readAhead: 1024 * 1024 })) {
    const f = group.find((g) => g.entry.commit === number)
    if (!f) continue
    const e = f.entry
    if (compareKeys(e.type, e.id, lastWant[0], lastWant[1]) > 0) break
    while (
      part + 1 < ranged.length &&
      compareKeys(e.type, e.id, ranged[part + 1]!.first![0], ranged[part + 1]!.first![1]) >= 0
    ) {
      await end()
      part++
      await begin()
    }
    if (e.kind === 'w') continue
    if (writer) {
      await (writer as SortedFileWriter).add({
        kind: e.kind,
        type: e.type,
        id: e.id,
        line: (await f.reader.line(e)).slice(),
        hash: e.hash,
      })
    } else {
      content.add(e.kind, e.type, e.id, e.hash, e.size)
    }
  }
  for (;;) {
    await end()
    if (++part >= ranged.length) break
    await begin()
  }
  return out
}
