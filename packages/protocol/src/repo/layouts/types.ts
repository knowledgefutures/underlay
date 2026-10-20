/**
 * Where a repository keeps record bytes (record-storage-layout.md). `today` is no
 * RecordStore at all (leaf bodies, repo.ts). `f` takes records out of leaves, so a
 * commit writes only the records that changed and a leaf's node lists what it
 * holds. Neither changes a node, a root or any hash.
 */
import type { RecordEntry } from '../../tree/node.js'
import type { PackInfo, PendingRun } from './kit.js'

export const LAYOUTS = ['today', 'f'] as const
export type LayoutName = (typeof LAYOUTS)[number]

/**
 * A record entry as layout F carries it through a build: with its place once stored.
 * A record written into a pack at upload comes without its body: `packed` is its
 * place there and `fileRefs` the files it references, read from it at upload.
 */
export type Placed = RecordEntry & { loc?: string; packed?: string; fileRefs?: string[] }

/** A record an upload writes into a pack: its id, hash and canonical line. */
export interface PackRecord {
  id: string
  hash: string
  line: string
}

/** Records still in use, from a mark over every retained version (storage reclaim). */
export interface LiveSet {
  /** `${id}\u0000${hash}` of every record in a retained version. */
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

export interface RecordStore {
  readonly name: LayoutName
  /** The stored lines of a leaf's entries, in entry order (out-of-line pointers unresolved). */
  leafLines(leafHash: string, entries: readonly RecordEntry[]): Promise<string[]>
  /** One entry's stored line: a changed record's old body, which file references need. */
  entryLine(leafHash: string, entries: readonly RecordEntry[], i: number): Promise<string>
  /** The stored lines of some of a leaf's entries (by index), reading only those records. */
  linesAt(
    leafHash: string,
    entries: readonly RecordEntry[],
    at: readonly number[],
  ): Promise<string[]>
  /** A writer for one commit unit or build. */
  writer(): RecordWriter
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
   * Write an upload's records into packs of their own, named by `ids` (more than it
   * needs; see `packIdsFor`), outside the index and the manifest: their places, in
   * the order given, and the packs written.
   */
  writePacks?(
    records: readonly PackRecord[],
    ids: readonly string[],
  ): Promise<{ places: string[]; packs: PackInfo[] }>
  /**
   * List packs uploads wrote, once the commit's index names their records: large
   * ones in the registry, small ones in the manifest for merges. `name` is the
   * commit's, so a retry lists nothing twice.
   */
  adoptPacks?(name: string, packs: readonly PackInfo[]): Promise<void>
  /** Delete packs uploads wrote for commit `name`, unless it named them (false then). */
  dropPacks?(name: string, ids: readonly string[]): Promise<boolean>
}

export interface RecordWriter {
  /** Store one record line (a spilled or new entry): its place. */
  add(entry: RecordEntry, line: string): string
  /** Index a record an upload already wrote into a pack, at `place`; returns it. */
  addPlaced(entry: RecordEntry, place: string): string
  /**
   * Write what's held: packs, the index layer, then the manifest. With `hold`, the
   * manifest isn't told: the run is returned, for the commit to name with its others.
   */
  finish(opts?: { hold?: boolean }): Promise<HeldRun | null>
}

/** A run a commit unit wrote and held back from the manifest (layout F). */
export type HeldRun = PendingRun

export const recordKey = (id: string, hash: string) => `${id}\u0000${hash}`
