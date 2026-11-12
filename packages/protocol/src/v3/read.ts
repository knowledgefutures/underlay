/**
 * Reading a version (docs/protocol-v3.md, Section 6).
 *
 * A version's files are the newest layout's files plus the files of the commits
 * after it. For each key, the entry with the highest commit at or below the
 * version wins. Every read here is that one rule over a merge of key entries:
 *
 *   getRecord   one key: a key block from each file whose range covers it
 *   page        records from a key on, in key order
 *   exportAll   every record, as a stream
 *   changes     what changed between two versions
 *   history     one key's rows across commits
 *   counts      records and bytes per type
 *
 * The merge runs on key entries, and a file is opened only when the merge
 * reaches its key range, so memory is one key block and one record block for
 * each file that overlaps the key in hand, whatever the collection's size.
 */
import { Lru } from '../repo/lru.js'
import type { Store } from '../repo/types.js'
import { recordKey } from './build.js'
import type { KeyPair } from './file.js'
import { compareKeys, type Entry, type Key, type Kind } from './lines.js'
import {
  commitFiles,
  commitKey,
  findVersion,
  type Layout,
  layoutKey,
  type LayoutFile,
  probeUp,
  readCommit,
  readLatest,
  readLayout,
  readLayoutAtHint,
  readLog,
} from './log.js'
import {
  EntryCursor,
  type FileReader,
  lookupEntries,
  MissingFileError,
  SortedFile,
} from './reader.js'
import { Heap, inParallel } from './util.js'

/** A file of a view: what a reader needs to know before opening it. */
export interface ViewFile {
  id: string
  labeled: boolean
  first: KeyPair | null
  last: KeyPair | null
  /** The commits its rows were written by. */
  commits: [number, number]
  entries: number
  bytes: number
}

/** A version of a collection, resolved to the files that hold it. */
export interface View {
  collection: string
  /** The commit number being read. */
  version: number
  /** The newest commit when the view was opened. */
  head: number
  /** The layout it reads through; 0 if none. */
  layout: number
  through: number
  files: ViewFile[]
}

export class VersionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VersionError'
  }
}

/**
 * Open a file by id. If it is not where files are kept, look in `trash/`: the
 * sweep moves a file there before deleting it, and a commit that named it in
 * the same moment still reads until the next pass moves it back.
 */
export async function openFile(store: Store, id: string): Promise<SortedFile> {
  try {
    return await SortedFile.open(store, recordKey(id), { id })
  } catch (err) {
    if (!(err instanceof MissingFileError)) throw err
    return SortedFile.open(store, `trash/${recordKey(id)}`, { id }).catch(() => {
      throw err
    })
  }
}

/** Opened files (their footers), kept by file id. Files never change, so entries never expire. */
export class FileCache {
  readonly #lru: Lru<SortedFile>
  readonly #opening = new Map<string, Promise<SortedFile>>()
  constructor(budgetBytes = 64 * 1024 * 1024) {
    this.#lru = new Lru<SortedFile>(budgetBytes, (f) => f.weight)
  }
  open(store: Store, id: string): Promise<SortedFile> {
    const hit = this.#lru.get(id)
    if (hit) return Promise.resolve(hit)
    let p = this.#opening.get(id)
    if (!p) {
      p = openFile(store, id).then(
        (f) => {
          this.#lru.set(id, f)
          this.#opening.delete(id)
          return f
        },
        (err) => {
          this.#opening.delete(id)
          throw err
        },
      )
      this.#opening.set(id, p)
    }
    return p
  }
}

export interface ReadOptions {
  cache?: FileCache
  /** Check blocks and lines against their hashes as they are read. Default true. */
  verify?: boolean
  /**
   * Readers for point lookups to share, by file id. A reader keeps the last key block and
   * record block it fetched, so one job's lookups of neighboring keys (a collection's
   * schemas) fetch them once. For lookups made one after another, not at once.
   */
  readers?: Map<string, FileReader>
}

const open = (store: Store, id: string, opts: ReadOptions): Promise<SortedFile> =>
  opts.cache ? opts.cache.open(store, id) : openFile(store, id)

const viewFile = (f: LayoutFile): ViewFile => ({
  id: f.id,
  labeled: f.labeled,
  first: f.first,
  last: f.last,
  commits: f.commits,
  entries: f.entries,
  bytes: f.bytes,
})

function retains(layout: Layout, version: number): boolean {
  if (!layout.retained || version > layout.through) return true
  return layout.retained.some(([lo, hi]) => lo <= version && version <= hi)
}

/**
 * Resolve a version (the newest by default) to its files. Requests for the
 * newest: the hint, the layout, a probe past each of the newest layout and
 * commit, and one read for each commit after the layout.
 */
export async function openView(
  store: Store,
  collection: string,
  opts: { version?: number } = {},
): Promise<View> {
  const latest = await readLatest(store, collection)
  let layout = await readLayoutAtHint(store, collection, latest?.layout)
  const layoutExists = async (n: number) => (await store.head(layoutKey(collection, n))) !== null
  const newest = await probeUp(layoutExists, layout?.number ?? 0)
  if (newest !== (layout?.number ?? 0)) layout = await readLayout(store, collection, newest)
  // The hint is trusted to exist (it is written after its commit); the probe finds anything newer.
  const commitExists = async (n: number) => (await store.head(commitKey(collection, n))) !== null
  const head = await probeUp(commitExists, latest?.commit ?? 0)
  const version = opts.version ?? head
  if (!Number.isSafeInteger(version) || version < 0 || version > head) {
    throw new VersionError(`${collection} has no version ${version} (the newest is ${head})`)
  }
  if (layout && !retains(layout, version)) {
    throw new VersionError(`${collection} no longer holds version ${version}`)
  }
  const files: ViewFile[] = []
  const through = layout?.through ?? 0
  if (layout) {
    for (const f of layout.files) if (f.commits[0] <= version) files.push(viewFile(f))
  }
  if (version > through) {
    for await (const c of readLog(store, collection, through + 1, version)) {
      for (const f of commitFiles(c.commit)) {
        files.push({
          id: f.id,
          labeled: false,
          first: f.first,
          last: f.last,
          commits: [c.commit.number, c.commit.number],
          entries: f.entries,
          bytes: f.bytes,
        })
      }
    }
  }
  return { collection, version, head, layout: layout?.number ?? 0, through, files }
}

/** The same collection at an older version, without asking the store again when it can. */
export function viewAt(view: View, version: number): View | null {
  if (version > view.version || version < 0) return null
  return { ...view, version, files: view.files.filter((f) => f.commits[0] <= version) }
}

const covers = (f: ViewFile, type: string, id: string): boolean =>
  f.first !== null &&
  f.last !== null &&
  compareKeys(f.first[0], f.first[1], type, id) <= 0 &&
  compareKeys(type, id, f.last[0], f.last[1]) <= 0

/** A row found by a read: its entry (with its commit) and the reader that can fetch its line. */
export interface Found {
  entry: Entry & { commit: number }
  reader: FileReader
}

/** Every entry for one key at or below the view's version, oldest first. */
async function lookupAll(
  store: Store,
  view: View,
  type: string,
  id: string,
  opts: ReadOptions,
): Promise<Found[]> {
  const files = view.files.filter((f) => covers(f, type, id))
  const found = await inParallel(
    files.map((f) => async () => {
      const file = await open(store, f.id, opts)
      let reader = opts.readers?.get(f.id)
      if (!reader) {
        reader = file.reader(opts.verify === undefined ? {} : { verify: opts.verify })
        opts.readers?.set(f.id, reader)
      }
      const entries = await reader.lookup(type, id)
      return entries.map((e) => ({
        entry: (f.labeled ? e : { ...e, commit: f.commits[0] }) as Entry & { commit: number },
        reader,
      }))
    }),
    16,
  )
  return found
    .flat()
    .filter((x) => x.entry.commit <= view.version)
    .sort((a, b) => a.entry.commit - b.entry.commit)
}

export interface RecordRead {
  type: string
  id: string
  /** The record's hash. */
  hash: string
  /** The commit that wrote this row. */
  commit: number
  /** The canonical record line, without a newline; null if the server withholds it. */
  line: Uint8Array | null
}

async function toRecord(f: Found): Promise<RecordRead> {
  const e = f.entry
  return {
    type: e.type,
    id: e.id,
    hash: e.hash!,
    commit: e.commit,
    line: e.kind === 'w' ? null : await f.reader.line(e),
  }
}

/** One record of a version, or null if the version has none with that key. */
export async function getRecord(
  store: Store,
  view: View,
  type: string,
  id: string,
  opts: ReadOptions = {},
): Promise<RecordRead | null> {
  const all = await lookupAll(store, view, type, id, opts)
  const winner = all[all.length - 1]
  if (!winner || winner.entry.kind === 'x') return null
  return toRecord(winner)
}

export interface HistoryRow {
  commit: number
  kind: Kind
  hash: string | null
  size: number
}

/** A key's row in a version, as `statesAt` finds it: present, with its hash and line size. */
export interface KeyRow {
  hash: string
  size: number
  commit: number
  withheld: boolean
}

/**
 * What many keys are in a version, at once: for each key, its row (or null if the version
 * has no record with that key). Keys are looked up a batch at a time, `concurrency` at
 * once, and within a batch each key block of each file is fetched once, so keys near each
 * other cost one fetch. For counting what a change does to a version, which a key at a
 * time would do in one round trip each.
 */
export async function statesAt(
  store: Store,
  view: View,
  keys: Key[],
  opts: ReadOptions & { concurrency?: number; batch?: number } = {},
): Promise<(KeyRow | null)[]> {
  const out: (KeyRow | null)[] = new Array(keys.length).fill(null)
  const batch = opts.batch ?? 512
  const readerOpts = opts.verify === undefined ? {} : { verify: opts.verify }
  for (let start = 0; start < keys.length; start += batch) {
    // Key blocks fetched for this batch, each once; dropped after it, to bound memory.
    const blocks = new Map<string, Promise<Entry[]>>()
    const end = Math.min(keys.length, start + batch)
    await inParallel(
      Array.from({ length: end - start }, (_, j) => async () => {
        const { type, id } = keys[start + j]!
        let best: (Entry & { commit: number }) | undefined
        for (const vf of view.files) {
          if (!covers(vf, type, id)) continue
          const f = await open(store, vf.id, opts)
          const entries = await lookupEntries(f, type, id, (i) => {
            const k = `${vf.id}/${i}`
            let p = blocks.get(k)
            if (!p) blocks.set(k, (p = f.reader(readerOpts).keyBlock(i)))
            return p
          })
          for (const e of entries) {
            const commit = vf.labeled ? e.commit! : vf.commits[0]
            if (commit <= view.version && (!best || commit > best.commit)) best = { ...e, commit }
          }
        }
        out[start + j] =
          best && best.kind !== 'x'
            ? {
                hash: best.hash!,
                size: best.size,
                commit: best.commit,
                withheld: best.kind === 'w',
              }
            : null
      }),
      opts.concurrency ?? 16,
    )
  }
  return out
}

/** One key's rows up to the view's version, newest first. */
export async function history(
  store: Store,
  view: View,
  type: string,
  id: string,
  opts: ReadOptions = {},
): Promise<HistoryRow[]> {
  const all = await lookupAll(store, view, type, id, opts)
  return all
    .map(({ entry: e }) => ({ commit: e.commit, kind: e.kind, hash: e.hash, size: e.size }))
    .reverse()
}

// --- The merge ---

export interface KeyRange {
  /** The first key wanted. */
  from?: Key
  /** Keys after this one only (a page's cursor). */
  after?: Key
  /** Stop before this key. */
  to?: Key
  /** Only this type. */
  type?: string
}

export interface ScanOptions extends ReadOptions {
  /** Bytes each file reads ahead: 0 for a page, more for a scan of everything. */
  readAhead?: number
}

interface Source {
  file: ViewFile
  /** Null until the merge reaches the file's key range. */
  cursor: EntryCursor | null
  reader: FileReader | null
  /** The key this source is ordered by: its current entry, or where it will start. */
  type: string
  id: string
  commit: number
}

export interface MergeHooks {
  /**
   * Called for a file no other file's entries fall inside the key range of,
   * before it is opened. Return true to leave it out of the merge (a rebuild
   * keeps such a file as it is). Every group before it has been yielded by then.
   */
  skipFile?: (file: ViewFile) => Promise<boolean> | boolean
}

/**
 * The entries of a view's files merged by key: one group per key, its entries
 * oldest first, each at or below the view's version.
 */
export async function* mergeGroups(
  store: Store,
  view: View,
  range: KeyRange = {},
  opts: ScanOptions = {},
  files: ViewFile[] = view.files,
  hooks: MergeHooks = {},
): AsyncGenerator<Found[]> {
  let from = range.from
  if (range.type !== undefined && (!from || compareKeys(from.type, from.id, range.type, '') < 0)) {
    from = { type: range.type, id: '' }
  }
  const after = range.after
  if (after && (!from || compareKeys(from.type, from.id, after.type, after.id) < 0)) from = after
  const past = (type: string, id: string) =>
    (range.type !== undefined && type !== range.type) ||
    (range.to !== undefined && compareKeys(type, id, range.to.type, range.to.id) >= 0)

  const heap = new Heap<Source>((a, b) => {
    const c = compareKeys(a.type, a.id, b.type, b.id)
    return c < 0 || (c === 0 && a.commit < b.commit)
  })
  for (const file of files) {
    if (!file.first || !file.last) continue
    if (from && compareKeys(file.last[0], file.last[1], from.type, from.id) < 0) continue
    if (range.type !== undefined && compareKeys(file.first[0], '', range.type, '') > 0) continue
    if (range.to && compareKeys(file.first[0], file.first[1], range.to.type, range.to.id) >= 0) {
      continue
    }
    const startsBefore = from && compareKeys(file.first[0], file.first[1], from.type, from.id) < 0
    heap.push({
      file,
      cursor: null,
      reader: null,
      type: startsBefore ? from!.type : file.first[0],
      id: startsBefore ? from!.id : file.first[1],
      commit: -1,
    })
  }
  const readerOpts = {
    ...(opts.readAhead === undefined ? {} : { readAhead: opts.readAhead }),
    ...(opts.verify === undefined ? {} : { verify: opts.verify }),
  }
  /** Put a source back by its cursor's current entry, or drop it when it runs out. */
  const requeue = (s: Source) => {
    const e = s.cursor!.current
    if (!e) return
    s.type = e.type
    s.id = e.id
    s.commit = e.commit!
    heap.push(s)
  }
  let group: Found[] = []
  for (;;) {
    const s = heap.pop()
    if (!s) break
    if (!s.cursor) {
      if (hooks.skipFile && s.file.first![0] === s.type && s.file.first![1] === s.id) {
        // A file about to be opened. If no other file has an entry before this one's last
        // key, its key range is its own, and the caller may want to leave it out of the merge.
        const held = group[0]?.entry
        if (!held || held.type !== s.type || held.id !== s.id) {
          if (group.length > 0) {
            yield group
            group = []
          }
          const other = heap.peek()
          const alone =
            !other || compareKeys(other.type, other.id, s.file.last![0], s.file.last![1]) > 0
          if (alone && (await hooks.skipFile(s.file))) continue
        }
      }
      // The merge has reached this file's keys: open it and take its place by its first entry.
      const f = await open(store, s.file.id, opts)
      s.reader = f.reader(readerOpts)
      s.cursor = new EntryCursor(s.reader, s.file.labeled ? null : s.file.commits[0])
      await s.cursor.seek(
        from && compareKeys(s.type, s.id, from.type, from.id) === 0 ? from : undefined,
      )
      requeue(s)
      continue
    }
    const e = s.cursor.current as Entry & { commit: number }
    // Past the range: keys only grow from here in this file, so it is done.
    if (past(e.type, e.id)) continue
    if (group.length > 0 && (group[0]!.entry.type !== e.type || group[0]!.entry.id !== e.id)) {
      yield group
      group = []
    }
    const skip = (after && e.type === after.type && e.id === after.id) || e.commit > view.version
    if (!skip) group.push({ entry: e, reader: s.reader! })
    await s.cursor.next()
    requeue(s)
  }
  if (group.length > 0) yield group
}

/** Records of a version from a key on, in key order, at most `limit`. */
export async function page(
  store: Store,
  view: View,
  range: KeyRange & { limit: number },
  opts: ScanOptions = {},
): Promise<RecordRead[]> {
  const out: RecordRead[] = []
  if (range.limit <= 0) return out
  for await (const group of mergeGroups(store, view, range, opts)) {
    const winner = group[group.length - 1]!
    if (winner.entry.kind === 'x') continue
    out.push(await toRecord(winner))
    if (out.length >= range.limit) break
  }
  return out
}

/** Every record of a version in key order, as a stream. */
export async function* exportAll(
  store: Store,
  view: View,
  range: KeyRange = {},
  opts: ScanOptions = {},
): AsyncGenerator<RecordRead> {
  const scan = { readAhead: 4 * 1024 * 1024, ...opts }
  for await (const group of mergeGroups(store, view, range, scan)) {
    const winner = group[group.length - 1]!
    if (winner.entry.kind === 'x') continue
    yield toRecord(winner)
  }
}

export interface TypeCount {
  records: number
  /** Bytes of the records' lines. */
  bytes: number
}

/** Records and bytes per type in a version, from key entries alone. */
export async function counts(
  store: Store,
  view: View,
  range: KeyRange = {},
  opts: ScanOptions = {},
): Promise<Map<string, TypeCount>> {
  const out = new Map<string, TypeCount>()
  const scan = { readAhead: 2 * 1024 * 1024, ...opts }
  for await (const group of mergeGroups(store, view, range, scan)) {
    const e = group[group.length - 1]!.entry
    if (e.kind === 'x') continue
    let t = out.get(e.type)
    if (!t) out.set(e.type, (t = { records: 0, bytes: 0 }))
    t.records++
    t.bytes += e.size
  }
  return out
}

/** A key's state in a version: a record (by hash), or absent. */
export interface KeyState {
  hash: string
  commit: number
  withheld: boolean
}

export interface ChangeRow {
  type: string
  id: string
  /** The key after the change; null if it was removed. */
  after: KeyState | null
  /** The key before; only with `before`. Undefined when not asked for. */
  before?: KeyState | null
  /** Fetch the record's line as of the newer version. */
  line: () => Promise<Uint8Array | null>
}

const stateOf = (f: Found | undefined): KeyState | null =>
  !f || f.entry.kind === 'x'
    ? null
    : { hash: f.entry.hash!, commit: f.entry.commit, withheld: f.entry.kind === 'w' }

/**
 * What changed between version `since` and the view's version: every key with
 * a row written by a commit after `since`, with its state now. Only files with
 * such rows are read.
 *
 * With `before`, each key's state at `since` is looked up in the older files as
 * well, and keys that ended as they began are left out. That costs up to a key
 * block from each older file for each changed key.
 */
export async function* changes(
  store: Store,
  view: View,
  since: number,
  range: KeyRange & { before?: boolean; batch?: number } = {},
  opts: ScanOptions = {},
): AsyncGenerator<ChangeRow> {
  if (since > view.version) throw new VersionError('`since` is after the version read')
  const recent = view.files.filter((f) => f.commits[1] > since)
  const older = range.before
    ? view.files.filter((f) => f.commits[1] <= since).sort((a, b) => b.commits[1] - a.commits[1])
    : []
  const readerOpts = opts.verify === undefined ? {} : { verify: opts.verify }
  /** Key blocks of the older files fetched for the batch in hand, each once. */
  let blocks = new Map<string, Promise<Entry[]>>()
  const stateBefore = async (
    group: Found[],
    type: string,
    id: string,
  ): Promise<KeyState | null> => {
    let best: (Entry & { commit: number }) | undefined
    for (const f of group) if (f.entry.commit <= since) best = f.entry
    // Every older file that could hold the key, looked in at once: one at a time costs a
    // round trip each, and a key added since is in none of them, so it is looked for in all.
    // (A file older than a row already found cannot beat it.)
    const files = older.filter(
      (file) => covers(file, type, id) && !(best && best.commit > file.commits[1]),
    )
    const found = await Promise.all(
      files.map(async (file) => {
        const f = await open(store, file.id, opts)
        const entries = await lookupEntries(f, type, id, (i) => {
          const k = `${file.id}/${i}`
          let p = blocks.get(k)
          if (!p) blocks.set(k, (p = f.reader(readerOpts).keyBlock(i)))
          return p
        })
        return entries.map((e) => ({ ...e, commit: file.labeled ? e.commit! : file.commits[0] }))
      }),
    )
    for (const e of found.flat()) {
      if (e.commit <= since && (!best || e.commit > best.commit)) best = e
    }
    return best && best.kind !== 'x'
      ? { hash: best.hash!, commit: best.commit, withheld: best.kind === 'w' }
      : null
  }
  /**
   * Changed keys are looked up in the older files a batch at a time, several at once. A
   * caller reading a page of changes passes its page size, so the page is one batch.
   */
  const BATCH = range.batch ?? 64
  let batch: { row: ChangeRow; group: Found[] }[] = []
  const flush = async function* (): AsyncGenerator<ChangeRow> {
    const befores = await inParallel(
      batch.map((b) => () => stateBefore(b.group, b.row.type, b.row.id)),
      16,
    )
    for (let i = 0; i < batch.length; i++) {
      const row = batch[i]!.row
      const before = befores[i]!
      if ((before?.hash ?? null) === (row.after?.hash ?? null)) continue
      row.before = before
      yield row
    }
    batch = []
    blocks = new Map()
  }
  for await (const group of mergeGroups(store, view, range, opts, recent)) {
    const winner = group[group.length - 1]!
    if (winner.entry.commit <= since) continue
    const row: ChangeRow = {
      type: winner.entry.type,
      id: winner.entry.id,
      after: stateOf(winner),
      line: async () => (winner.entry.kind === 'r' ? winner.reader.line(winner.entry) : null),
    }
    if (!range.before) {
      yield row
      continue
    }
    batch.push({ row, group })
    if (batch.length >= BATCH) yield* flush()
  }
  if (batch.length > 0) yield* flush()
}

/** A key a commit wrote that another commit had changed since the commit's base. */
export interface Crossed {
  type: string
  id: string
  /** What this commit left the key as; null if it removed it. */
  mine: KeyState | null
  /** What the key was just before this commit, written after the base; null if removed. */
  theirs: KeyState | null
  /** The commit that last wrote the key before this one. */
  theirCommit: number
}

/**
 * For a commit, the keys it wrote that were also changed by commits after its
 * base and up to the commit before it: what the author had not seen when they
 * prepared the upload. Read-only, and it refuses nothing: the newest still
 * wins. A commit whose base is the commit before it crossed nothing.
 *
 * It is a diff of key entries over (base, previous], cut down to this commit's
 * keys, so it reads only files with rows from those commits.
 */
export async function* changedSinceBase(
  store: Store,
  collection: string,
  number: number,
  opts: ScanOptions & { search?: number } = {},
): AsyncGenerator<Crossed> {
  const commit = await readCommit(store, collection, number)
  if (!commit) throw new VersionError(`${collection} has no commit ${number}`)
  const view = await openView(store, collection, { version: number })
  const before = viewAt(view, number - 1)!
  for (const change of commit.commit.changes) {
    // A null base is "from nothing": every earlier commit counts.
    let base = 0
    if (change.base !== null) {
      const found =
        commit.commit.previous === change.base
          ? number - 1
          : await findVersion(store, collection, change.base, number - 1, {
              ...(opts.search === undefined ? {} : { search: opts.search }),
            })
      if (found === null) throw new VersionError(`Commit ${number}'s base is not in the log`)
      base = found
    }
    if (base >= number - 1) continue
    // Both lists are in key order: walk them together.
    const theirs = changes(store, before, base, {}, opts)
    let other = await theirs.next()
    for await (const mine of changes(store, view, number - 1, {}, opts)) {
      while (!other.done && compareKeys(other.value.type, other.value.id, mine.type, mine.id) < 0) {
        other = await theirs.next()
      }
      if (other.done) break
      if (other.value.type === mine.type && other.value.id === mine.id) {
        const last = await lastWriter(store, before, mine.type, mine.id, opts)
        yield {
          type: mine.type,
          id: mine.id,
          mine: mine.after,
          theirs: other.value.after,
          theirCommit: last,
        }
      }
    }
    await theirs.return(undefined)
  }
}

/** The commit that last wrote a key in a version, removal or not; 0 if none did. */
async function lastWriter(
  store: Store,
  view: View,
  type: string,
  id: string,
  opts: ReadOptions,
): Promise<number> {
  const all = await lookupAll(store, view, type, id, opts)
  return all[all.length - 1]?.entry.commit ?? 0
}
