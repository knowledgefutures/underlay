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
  type Layout,
  layoutKey,
  type LayoutFile,
  probeUp,
  readLatest,
  readLayout,
  readLog,
} from './log.js'
import { EntryCursor, type FileReader, SortedFile } from './reader.js'
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
      p = SortedFile.open(store, recordKey(id), { id }).then(
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
}

const open = (store: Store, id: string, opts: ReadOptions): Promise<SortedFile> =>
  opts.cache ? opts.cache.open(store, id) : SortedFile.open(store, recordKey(id), { id })

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
  let layout: Layout | null = null
  if (latest && latest.layout > 0) layout = await readLayout(store, collection, latest.layout)
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
      const reader = file.reader(opts.verify === undefined ? {} : { verify: opts.verify })
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
  range: KeyRange & { before?: boolean } = {},
  opts: ScanOptions = {},
): AsyncGenerator<ChangeRow> {
  if (since > view.version) throw new VersionError('`since` is after the version read')
  const recent = view.files.filter((f) => f.commits[1] > since)
  const older = range.before
    ? view.files.filter((f) => f.commits[1] <= since).sort((a, b) => b.commits[1] - a.commits[1])
    : []
  const cursors = new Map<string, EntryCursor>()
  const stateBefore = async (
    group: Found[],
    type: string,
    id: string,
  ): Promise<KeyState | null> => {
    let best: Found | undefined
    for (const f of group) if (f.entry.commit <= since) best = f
    for (const file of older) {
      if (!covers(file, type, id)) continue
      // Files are newest first: nothing in this one or after can beat a newer row already found.
      if (best && best.entry.commit > file.commits[1]) continue
      let cursor = cursors.get(file.id)
      if (!cursor) {
        const f = await open(store, file.id, opts)
        const reader = f.reader(opts.verify === undefined ? {} : { verify: opts.verify })
        cursor = new EntryCursor(reader, file.labeled ? null : file.commits[0])
        cursors.set(file.id, cursor)
      }
      await cursor.seek({ type, id })
      while (cursor.current && cursor.current.type === type && cursor.current.id === id) {
        const e = cursor.current as Entry & { commit: number }
        if (e.commit <= since && (!best || e.commit > best.entry.commit)) {
          best = { entry: e, reader: cursor.reader }
        }
        await cursor.next()
      }
    }
    return stateOf(best)
  }
  for await (const group of mergeGroups(store, view, range, opts, recent)) {
    const winner = group[group.length - 1]!
    if (winner.entry.commit <= since) continue
    const after = stateOf(winner)
    const row: ChangeRow = {
      type: winner.entry.type,
      id: winner.entry.id,
      after,
      line: async () => (winner.entry.kind === 'r' ? winner.reader.line(winner.entry) : null),
    }
    if (range.before) {
      const before = await stateBefore(group, row.type, row.id)
      if ((before?.hash ?? null) === (after?.hash ?? null)) continue
      row.before = before
    }
    yield row
  }
}
