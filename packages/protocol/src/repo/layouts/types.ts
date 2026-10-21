/**
 * Where a repository keeps record bytes (record-storage-layout.md). `today` is no
 * RecordStore at all (leaf bodies, repo.ts). `f` takes records out of leaves, so a
 * commit writes only the records that changed and a leaf's node lists what it
 * holds. Neither changes a node, a root or any hash.
 */
import type { RecordEntry } from '../../tree/node.js'
import type { PackHooks, PackInfo, PendingRun } from './kit.js'

export const LAYOUTS = ['today', 'f'] as const
export type LayoutName = (typeof LAYOUTS)[number]

/**
 * A record entry as layout F carries it through a build: with its place once stored.
 * A record written into a pack at upload comes without its body: `packed` is its
 * place there and `fileRefs` the files it references, read from it at upload.
 */
export type Placed = RecordEntry & { loc?: string; packed?: string; fileRefs?: string[] }

/** A record an upload writes into a pack: its type, id, hash and canonical line. */
export interface PackRecord {
  type: string
  id: string
  hash: string
  line: string
}

/** Writes an upload's records into packs (RecordStore.uploadWriter). */
export interface UploadWriter {
  /** Write one record: its place. */
  append(record: PackRecord): string
  /** Wait while too much is held (call between records): memory stays bounded. */
  ready(): Promise<void>
  /** Write the last pack and wait for every write: the packs written. */
  finish(): Promise<PackInfo[]>
}

/** Records still in use, from a mark over every retained version (storage reclaim). */
export interface LiveSet {
  /** `recordKey(type, id, hash)` of every record in a retained version. */
  records: Set<string>
}

/** A record set: a version's public records, or its private ones (file-sets.ts SetName). */
export type RecordSet = 'public' | 'private'

/**
 * A collection's records in layout F, a store a set: its public records and its
 * private ones never share a pack or an index run, so a mirror of the public set
 * copies files that hold nothing else.
 */
export interface RecordSets {
  readonly public: RecordStore
  readonly private: RecordStore
}

/** A leaf of a type's record tree: its records are found by type, id and hash. */
export interface TypedLeaf {
  hash: string
  type: string
  entries: readonly RecordEntry[]
}

export interface RecordStore {
  readonly name: LayoutName
  /** The stored lines of a leaf's entries, in entry order (out-of-line pointers unresolved). */
  leafLines(leaf: TypedLeaf): Promise<string[]>
  /** One entry's stored line: a changed record's old body, which file references need. */
  entryLine(leaf: TypedLeaf, i: number): Promise<string>
  /** The stored lines of some of a leaf's entries (by index), reading only those records. */
  linesAt(leaf: TypedLeaf, at: readonly number[]): Promise<string[]>
  /** A writer for one commit unit or build; with `hold`, its runs are returned, not named. */
  writer(opts?: { hold?: boolean }): RecordWriter
  /**
   * Merges due after a write (layers, packs), run in the writer's own job as a commit's
   * tail. True when a budget stopped it with work perhaps left: queue another.
   */
  maintain(): Promise<boolean | void>
  /** Drop what `live` doesn't hold, rewriting packs that are mostly dead. Returns counts. */
  reclaim(live: LiveSet): Promise<Record<string, number>>
  /** Name a commit's held runs (RecordWriter.finish with `hold`) in the index, together. */
  appendRuns?(runs: HeldRun[]): Promise<void>
  /** Give a fork its records: it lists the parent's files and reads them where they are. */
  forkInto?(target: RecordStore): Promise<Record<string, number>>
  /**
   * A writer of an upload's records into packs of its own, outside the index and the
   * manifest until a commit names them (`adoptPacks`). Records in key order fill whole
   * packs; one below the last starts a new pack.
   */
  uploadWriter?(hooks?: PackHooks): UploadWriter
  /** An upload's records into packs, sorted first: their places, in the order given. */
  writePacks?(
    records: readonly PackRecord[],
    hooks?: PackHooks,
  ): Promise<{ places: string[]; packs: PackInfo[] }>
  /**
   * List packs uploads wrote, once the commit's index names their records: large
   * ones in the registry, small ones in the manifest for merges. `name` is the
   * commit's, so a retry lists nothing twice.
   */
  adoptPacks?(name: string, packs: readonly PackInfo[]): Promise<void>
  /** Delete packs uploads wrote for commit `name`, but none the collection lists: the ids deleted. */
  dropPacks?(name: string, ids: readonly string[]): Promise<string[]>
}

export interface RecordWriter {
  /** Store one record line (a spilled or new entry) of type `type`: its place. */
  add(type: string, entry: RecordEntry, line: string): string
  /** Write a run out if enough is held (called as a build goes): memory stays bounded. */
  drain?(): Promise<void>
  /** Index a record of type `type` an upload already wrote into a pack, at `place`; returns it. */
  addPlaced(type: string, entry: RecordEntry, place: string): string
  /**
   * Write what's held: packs, the index layer, then the manifest. A writer made with
   * `hold` doesn't tell the manifest: its runs are returned, for the commit to name.
   */
  finish(): Promise<HeldRun[]>
}

/** A run a commit unit wrote and held back from the manifest (layout F). */
export type HeldRun = PendingRun

/**
 * A record's index key: its type, id and hash. The type comes first so a type's
 * records are together in the index, as its tree's leaves are: a leaf's records are
 * one short range, never the other types' records whose ids fall between its ids.
 */
export const recordKey = (type: string, id: string, hash: string) =>
  `${type}\u0000${id}\u0000${hash}`

/** Record bytes a reader of a leaf takes at once (layout F): a leaf of small records in one read. */
export const LEAF_CHUNK_BYTES = 4 * 1024 * 1024

/**
 * A leaf's entries as runs of indexes of at most LEAF_CHUNK_BYTES of records (one at
 * least): each run is one index lookup, so a leaf of small records is read in one,
 * and one of large records is never held whole.
 */
export function leafChunks(
  entries: readonly RecordEntry[],
  maxBytes = LEAF_CHUNK_BYTES,
): number[][] {
  const out: number[][] = []
  let run: number[] = []
  let bytes = 0
  entries.forEach((e, i) => {
    if (run.length && bytes + e.size > maxBytes) {
      out.push(run)
      run = []
      bytes = 0
    }
    run.push(i)
    bytes += e.size
  })
  if (run.length) out.push(run)
  return out
}

/** The key a record's versions share (`recordKey` without the hash): what a filter holds. */
export const recordIdKey = (type: string, id: string) => `${type}\u0000${id}`
