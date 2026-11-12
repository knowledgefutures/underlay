import { chunkLines, gunzipStream } from '../repo/gzip.js'
/**
 * Building an upload: lines in, sorted-record-files out.
 *
 *   parseUpload    NDJSON bytes to rows, under the input rules
 *   sortRows       an external sort with bounded memory: sorted chunks spilled to
 *                  scratch, then merged. A key given twice keeps its last line.
 *   buildFiles     rows in key order to one or more files, cut by size
 *
 * Input that is already in key order skips `sortRows`; `buildFiles` refuses rows
 * out of order. Scratch and the files' target are both a `Store`, so the same
 * code builds on disk, in a bucket, or in memory.
 */
import { MIN_PART_BYTES, putFromParts, readParts, type Store } from '../repo/types.js'
import { utf8ByteLength } from '../utf8.js'
import { MAX_FILE_ENTRIES } from './constants.js'
import {
  type FileRef,
  fileRef,
  type FileSink,
  SortedFileWriter,
  type WriteRow,
  type WriterOptions,
} from './file.js'
import { concatBytes, gzipMember } from './gz.js'
import { compareKeys, type Key, lineKey, type LineRow, parseInputLine } from './lines.js'
import { Channel, equalParts, mergeSorted, PART_BYTES } from './util.js'

const enc = new TextEncoder()

/** NDJSON bytes to rows. Empty lines are skipped. */
export async function* parseUpload(
  chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): AsyncGenerator<LineRow> {
  const source = (async function* () {
    yield* chunks
  })()
  for await (const line of chunkLines(source)) {
    if (line.length === 0 || line === '\r') continue
    const row = parseInputLine(line)
    yield { kind: row.kind, type: row.type, id: row.id, line: row.line }
  }
}

// --- Sorting ---

export interface SortOptions {
  /** Estimated bytes of rows held before a chunk is spilled. */
  memoryBytes?: number
  /** Chunks merged at once. */
  fanIn?: number
  /** Key prefix for spilled chunks in the scratch store. */
  prefix?: string
}

/** What a row costs in memory, roughly: its line at two bytes a character, and its strings' overhead. */
const rowWeight = (r: LineRow) => r.line.length * 2 + (r.type.length + r.id.length) * 2 + 200

/** Raw bytes per gzip member of a spilled chunk: what a reader of it holds at once. */
const SPILL_MEMBER = 1024 * 1024

async function* spillParts(lines: Iterable<string>): AsyncGenerator<Uint8Array> {
  let held: string[] = []
  let n = 0
  for (const line of lines) {
    held.push(line)
    n += line.length + 1
    if (n >= SPILL_MEMBER) {
      yield await gzipMember(enc.encode(held.join('\n') + '\n'), 1)
      held = []
      n = 0
    }
  }
  if (held.length > 0) yield await gzipMember(enc.encode(held.join('\n') + '\n'), 1)
}

async function* asyncLines(lines: AsyncIterable<string>): AsyncGenerator<Uint8Array> {
  let held: string[] = []
  let n = 0
  for await (const line of lines) {
    held.push(line)
    n += line.length + 1
    if (n >= SPILL_MEMBER) {
      yield await gzipMember(enc.encode(held.join('\n') + '\n'), 1)
      held = []
      n = 0
    }
  }
  if (held.length > 0) yield await gzipMember(enc.encode(held.join('\n') + '\n'), 1)
}

/** A stored object's bytes in order, `partBytes` at a time. */
async function* objectChunks(
  store: Store,
  key: string,
  partBytes: number,
): AsyncGenerator<Uint8Array> {
  const head = await store.head(key)
  if (!head) throw new Error(`${key} is missing`)
  yield* readParts(store, key, head.size, partBytes)
}

/** Compressed bytes a merge reads at a time over all its inputs. */
const MERGE_READ_BYTES = 16 * 1024 * 1024

interface Keyed extends Key {
  kind: 'r' | 'x'
  line: string
}

async function* spilledRows(store: Store, key: string, partBytes: number): AsyncGenerator<Keyed> {
  for await (const line of chunkLines(gunzipStream(objectChunks(store, key, partBytes)))) {
    yield { ...lineKey(line), line }
  }
}

const byKey = (a: Key, b: Key) => compareKeys(a.type, a.id, b.type, b.id)

/** Merge chunks, oldest first, keeping each key's line from the newest chunk that has it. */
async function* mergeChunks(store: Store, keys: string[]): AsyncGenerator<Keyed> {
  const partBytes = Math.max(65_536, Math.floor(MERGE_READ_BYTES / keys.length))
  const streams = keys.map((k) => spilledRows(store, k, partBytes))
  let held: Keyed | null = null
  try {
    for await (const [row] of mergeSorted(streams, byKey)) {
      // Ties arrive in chunk order, so the last of several equal keys is the newest.
      if (held && byKey(held, row) !== 0) yield held
      held = row
    }
    if (held) yield held
  } finally {
    for (const s of streams) await s.return(undefined)
  }
}

/**
 * Sort rows by key with bounded memory. Rows are collected up to `memoryBytes`,
 * sorted, and spilled to `scratch` as a chunk; chunks are then merged, `fanIn`
 * at a time. Input that fits in memory is never spilled. Spilled chunks are
 * deleted as they are used up.
 */
export async function* sortRows(
  rows: AsyncIterable<LineRow> | Iterable<LineRow>,
  scratch: Store,
  opts: SortOptions = {},
): AsyncGenerator<LineRow> {
  const budget = opts.memoryBytes ?? 32 * 1024 * 1024
  const fanIn = Math.max(2, opts.fanIn ?? 48)
  const prefix = opts.prefix ?? `tmp/sort-${crypto.randomUUID()}/`
  let chunks: string[] = []
  let made = 0
  let held: (LineRow & { seq: number })[] = []
  let weight = 0
  let seq = 0

  /** Sort what is held and drop all but the last line given for each key. */
  const sorted = (): LineRow[] => {
    held.sort((a, b) => byKey(a, b) || a.seq - b.seq)
    const out: LineRow[] = []
    for (let i = 0; i < held.length; i++) {
      const next = held[i + 1]
      if (next && byKey(held[i]!, next) === 0) continue
      const { kind, type, id, line } = held[i]!
      out.push({ kind, type, id, line })
    }
    held = []
    weight = 0
    return out
  }
  const put = async (parts: AsyncIterable<Uint8Array>) => {
    const key = `${prefix}${String(made++).padStart(8, '0')}`
    await putFromParts(scratch, key, equalParts(parts, Math.max(PART_BYTES, MIN_PART_BYTES)))
    return key
  }

  try {
    for await (const row of rows) {
      held.push({ ...row, seq: seq++ })
      weight += rowWeight(row)
      if (weight >= budget) {
        const out = sorted()
        chunks.push(await put(spillParts(out.map((r) => r.line))))
      }
    }
    if (chunks.length === 0) {
      yield* sorted()
      return
    }
    if (held.length > 0) {
      const out = sorted()
      chunks.push(await put(spillParts(out.map((r) => r.line))))
    }
    // Merge down until one pass can take what is left. Groups are of neighbours, so order holds.
    while (chunks.length > fanIn) {
      const next: string[] = []
      for (let i = 0; i < chunks.length; i += fanIn) {
        const group = chunks.slice(i, i + fanIn)
        if (group.length === 1) {
          next.push(group[0]!)
          continue
        }
        const lines = (async function* () {
          for await (const r of mergeChunks(scratch, group)) yield r.line
        })()
        next.push(await put(asyncLines(lines)))
        for (const k of group) await scratch.delete(k)
      }
      chunks = next
    }
    yield* mergeChunks(scratch, chunks)
  } finally {
    for (const k of chunks) await scratch.delete(k).catch(() => {})
  }
}

// --- Files ---

/** A file being written somewhere it can be named once its id is known. */
export interface FileDraft extends FileSink {
  /** Keep the file under its id. A file already stored under that id is left as it is. */
  keep(id: string): Promise<void>
  discard(): Promise<void>
}

export interface FileTarget {
  begin(): Promise<FileDraft>
}

export const recordKey = (id: string) => `records/${id}`
/** Where an upload's file waits to be checked: under its upload session, not among the stored files. */
export const uploadKey = (session: string, id: string) => `uploads/${session}/${id}`

/** A new upload session: a name no one can guess, under which one upload's files arrive. */
export const newSession = (): string => crypto.randomUUID()

/**
 * Files written to a store at `records/<file id>`. A small file is held in
 * memory and created in one put. A larger one is uploaded in equal parts to a
 * temporary key as it is written, then copied to its name: its id is known only
 * at the end, and a bucket cannot rename.
 */
export function storeTarget(
  store: Store,
  opts: { memoryBytes?: number; keyOf?: (id: string) => string } = {},
): FileTarget {
  const limit = opts.memoryBytes ?? 16 * 1024 * 1024
  const keyOf = opts.keyOf ?? recordKey
  return {
    async begin() {
      let held: Uint8Array[] = []
      let size = 0
      let channel: Channel | null = null
      let upload: Promise<void> | null = null
      const tmp = `tmp/file-${crypto.randomUUID()}`
      return {
        async write(chunk) {
          size += chunk.byteLength
          if (channel) return channel.write(chunk)
          held.push(chunk)
          if (size <= limit) return
          const ch = (channel = new Channel())
          upload = putFromParts(store, tmp, equalParts(ch)).catch((err) => {
            ch.fail(err)
            throw err
          })
          upload.catch(() => {})
          for (const c of held) await ch.write(c)
          held = []
        },
        async keep(id) {
          const key = keyOf(id)
          if (!channel) {
            const bytes = concatBytes(held.length > 0 ? held : [new Uint8Array(0)], size)
            if (store.create) await store.create(key, bytes)
            else await store.put(key, bytes, { ifAbsent: true })
            return
          }
          channel.close()
          await upload
          if (!(await store.head(key))) {
            if (store.copy) await store.copy(tmp, key, size)
            else await putFromParts(store, key, equalParts(readParts(store, tmp, size, PART_BYTES)))
          }
          await store.delete(tmp)
        },
        async discard() {
          if (!channel) return
          channel.fail(new Error('discarded'))
          await upload?.catch(() => {})
          await store.delete(tmp)
        },
      }
    },
  }
}

/**
 * Files written into an upload session (`uploads/<session>/<file id>`), as a
 * client's upload arrives. A commit may name a file only if its bytes are in
 * the session the commit is made from; the server installs them among the
 * stored files once they are checked (`commitUpload`).
 */
export const uploadTarget = (
  store: Store,
  session: string,
  opts: { memoryBytes?: number } = {},
): FileTarget => storeTarget(store, { ...opts, keyOf: (id) => uploadKey(session, id) })

/**
 * Move a checked file from its upload session to the stored files. A file
 * already stored under that id is left as it is, and the uploader is not told.
 */
export async function installUpload(store: Store, session: string, id: string): Promise<void> {
  const from = uploadKey(session, id)
  const to = recordKey(id)
  if (await store.head(to)) return
  const head = await store.head(from)
  if (!head) throw new Error(`${from} is missing`)
  if (store.copy) await store.copy(from, to, head.size)
  else await putFromParts(store, to, equalParts(readParts(store, from, head.size, PART_BYTES)))
}

export interface BuildOptions extends WriterOptions {
  /**
   * Cut by key: close a file after a key that `keyCut` picks, so that files hold
   * about this many bytes of lines. The same stretch of keys then lands in the
   * same file whoever builds it and however the work was split, and a file whose
   * keys did not change keeps its id. Default `CUT_BYTES`; `Infinity` for no cut
   * by key.
   */
  cutBytes?: number
  /** The cap: close a file once its lines reach this many bytes. Default four times `CUT_BYTES`. */
  maxBytes?: number
  /** Close a file once it has this many entries. Default 524,288. */
  maxEntries?: number
  /** Close a file where the type changes, once it holds this many bytes of lines. Default 16 MiB. */
  typeCutBytes?: number
}

/**
 * The reference client's target for an upload's files: 512 MiB of lines, which
 * stores as about 128 MB (records store at a fifth to a quarter of their lines).
 * It is counted in lines so that the cut depends on the rows alone, never on how
 * they compress. A server accepts any cut; this is only what this client does.
 *
 * Why this size (measured 2026-11-12, see the bench report): what smaller files
 * buy is less rewritten by a takedown or a merge that keeps untouched files,
 * which are uncommon, and what they cost is a longer file list in every large
 * commit and layout. Cutting by key at all is what makes the same rows give the
 * same files, and that holds at any target.
 */
export const CUT_BYTES = 512 * 1024 * 1024
/** A file's cap, for a stretch of keys the hash happens not to cut. */
export const DEFAULT_FILE_BYTES = 4 * CUT_BYTES
export const DEFAULT_FILE_ENTRIES = 524_288
export const TYPE_CUT_BYTES = 16 * 1024 * 1024

/** A row's size as the cut weighs it: the bytes of its line. */
export const rowSize = (row: WriteRow): number =>
  row.kind === 'w'
    ? row.size
    : typeof row.line === 'string'
      ? utf8ByteLength(row.line)
      : row.line.byteLength

/**
 * Whether a file ends after a key, for files of about `cutBytes` of lines. The
 * choice is a hash of the key against the row's own size (a row of twice the
 * size is twice as likely to end a file), so it depends on that row alone and
 * files come out near the target whatever the records' sizes. Which keys cut is
 * the server's choice, not the protocol's; it only has to stay the same for a
 * collection and its forks.
 */
export function keyCut(type: string, id: string, size: number, cutBytes: number): boolean {
  // FNV-1a over the key's code units, then a finishing mix so the bits are well spread.
  let h = 2_166_136_261
  for (let i = 0; i < type.length; i++) h = Math.imul(h ^ type.charCodeAt(i), 16_777_619)
  h = Math.imul(h ^ 0, 16_777_619)
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16_777_619)
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 4_294_967_296 < (size + 1) / cutBytes
}

/**
 * One part of an upload that is built in parts, moved so that it ends on cut
 * keys: then the files are the same however many parts there were. `rows` are
 * the part's rows in key order, followed by the rows after it for as far as it
 * takes; `past` says a row is beyond the part's own end. The part gives up its
 * rows through the first cut key (the part before takes them), unless it is the
 * first, and runs on past its end through the next cut key.
 */
export async function* partOnCuts<R extends WriteRow>(
  rows: AsyncIterable<R> | Iterable<R>,
  opts: { first: boolean; past: (row: R) => boolean; cutBytes?: number },
): AsyncGenerator<R> {
  const cutBytes = opts.cutBytes ?? CUT_BYTES
  let skipping = !opts.first
  for await (const row of rows) {
    const past = opts.past(row)
    const cut = keyCut(row.type, row.id, rowSize(row), cutBytes)
    if (skipping) {
      // No cut key in the whole part: the part before runs through it, and this one is empty.
      if (past) return
      if (cut) skipping = false
      continue
    }
    yield row
    if (past && cut) return
  }
}

/**
 * Write rows, in key order, as one or more files. A file ends after a key the
 * hash picks (`cutBytes`), at the cap, or where the type changes. A cut falls
 * only between keys, so a key's rows are never split across files. Returns each
 * file as a commit or layout names it, with its stored size.
 */
export async function buildFiles(
  rows: AsyncIterable<WriteRow> | Iterable<WriteRow>,
  target: FileTarget,
  opts: BuildOptions = {},
): Promise<(FileRef & { size: number; labeled: boolean; commits: [number, number] | null })[]> {
  const cutBytes = opts.cutBytes ?? CUT_BYTES
  const maxBytes = opts.maxBytes ?? DEFAULT_FILE_BYTES
  const maxEntries = Math.min(opts.maxEntries ?? DEFAULT_FILE_ENTRIES, MAX_FILE_ENTRIES)
  const typeCut = opts.typeCutBytes ?? TYPE_CUT_BYTES
  const out: (FileRef & { size: number; labeled: boolean; commits: [number, number] | null })[] = []
  let draft: FileDraft | null = null
  let writer: SortedFileWriter | null = null
  let last: Key | null = null
  let lastSize = 0
  const close = async () => {
    if (!writer || !draft) return
    const w = await writer.finish()
    await draft.keep(w.id)
    out.push({
      ...fileRef(w.id, w.content),
      size: w.size,
      labeled: w.content.labeled,
      commits: w.content.commits,
    })
    writer = null
    draft = null
  }
  try {
    for await (const row of rows) {
      if (writer && last && (last.type !== row.type || last.id !== row.id)) {
        const full = writer.bytes >= maxBytes || writer.entries >= maxEntries
        const byKey = keyCut(last.type, last.id, lastSize, cutBytes)
        if (full || byKey || (last.type !== row.type && writer.bytes >= typeCut)) await close()
      }
      if (!writer) {
        draft = await target.begin()
        writer = new SortedFileWriter(draft, opts)
      }
      // A key's rows stay together even past the entry limit's soft cut, but never past the hard one.
      await writer.add(row)
      last = row
      lastSize = rowSize(row)
    }
    await close()
  } catch (err) {
    await (draft as FileDraft | null)?.discard().catch(() => {})
    throw err
  }
  return out
}
