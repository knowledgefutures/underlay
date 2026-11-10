/**
 * The engine interface the scenarios drive, and its v3 driver. The interface is
 * what any storage design under test has to offer: load, commit, the reads,
 * fork, maintain, delete, and storage stats. Layout F was driven through the
 * server (branch `scale-testing`); v3 is a library, so its driver calls it
 * directly, through the bench store.
 */
import { v3 } from '../../packages/protocol/src/index.js'
import { clientTarget, refOf } from './lib.js'
import { type BenchStore, diskUsage } from './store.js'

export type Rows = AsyncIterable<v3.LineRow> | Iterable<v3.LineRow>

export interface CommitResult {
  number: number
  semver: string
  files: number
  entries: number
  /** Bytes of lines, uncompressed, and stored bytes of the files. */
  lineBytes: number
  storedBytes: number
  validated: number
}

export interface MaintainResult {
  layouts: number
  merges: number
  filesIn: number
  filesOut: number
  /** Stored bytes written by merges, and line bytes read by them. */
  written: number
  bytesIn: number
  dropped: number
}

/** A version resolved for reading. */
export interface Handle {
  collection: string
  version: number
  files: number
  /** Runs (a rebuild's output, or a commit's own files) a key may sit in. */
  runs: number
  view: unknown
}

export interface Engine {
  readonly name: string
  /** Build an upload from rows in any order (as a client does) and commit it (as the server does). */
  commit(collection: string, rows: Rows, opts?: { message?: string }): Promise<CommitResult>
  /** Resolve a version, asking the store (a cold open). */
  open(collection: string, version?: number): Promise<Handle>
  /** Forget every cached footer, so the next reads are cold. */
  dropCaches(): void
  readPoint(h: Handle, type: string, id: string): Promise<number>
  readPage(h: Handle, type: string, after: string | null, limit: number): Promise<number>
  exportAll(h: Handle, range?: v3.KeyRange): Promise<{ records: number; bytes: number }>
  diff(h: Handle, since: number, opts: { before: boolean; limit?: number }): Promise<number>
  history(h: Handle, type: string, id: string): Promise<number>
  fork(parent: string, fork: string): Promise<{ objects: number; bytes: number }>
  /** Run maintenance (rebuilds) until there is nothing left to do. */
  maintain(collection: string): Promise<MaintainResult>
  deleteCollection(collection: string): Promise<number>
  /** Bytes and objects in the location by kind, from disk. */
  storageStats(): Promise<Record<string, { objects: number; bytes: number }>>
}

export interface V3Options {
  tiers?: v3.TierOptions
  /** Check uploads' structure and validate records at commit, as a server does. Default true. */
  verify?: boolean
  validate?: boolean
  /** Where a client's sort spills. */
  scratch?: import('../../packages/protocol/src/index.js').Store
  /** Gzip level for built files. */
  level?: number
}

export class V3Engine implements Engine {
  readonly name = 'v3'
  cache = new v3.FileCache()

  constructor(
    readonly store: BenchStore,
    readonly opts: V3Options = {},
  ) {}

  dropCaches(): void {
    this.cache = new v3.FileCache()
  }

  /** The client's half: sort and build files on local disk, and upload them. */
  async build(rows: Rows): Promise<v3.FileRef[]> {
    const scratch = this.opts.scratch
    const sorted = scratch ? v3.sortRows(rows, scratch) : v3.sortRows(rows, this.store)
    const files = await v3.buildFiles(sorted, clientTarget(this.store), {
      ...(this.opts.level === undefined ? {} : { level: this.opts.level }),
    })
    this.#sizes = files.reduce((n, f) => n + f.size, 0)
    return files.map(refOf)
  }
  #sizes = 0

  /** The server's half: check the files and create the commit. */
  async commitFiles(
    collection: string,
    files: v3.FileRef[],
    message?: string,
  ): Promise<CommitResult> {
    const made = await v3.commitUpload(
      this.store,
      collection,
      { files, message: message ?? null },
      {
        cache: this.cache,
        verify: this.opts.verify ?? true,
        validate: this.opts.validate ?? true,
      },
    )
    return {
      number: made.commit.number,
      semver: made.commit.semver,
      files: files.length,
      entries: files.reduce((n, f) => n + f.entries, 0),
      lineBytes: files.reduce((n, f) => n + f.bytes, 0),
      storedBytes: this.#sizes,
      validated: made.check.validated,
    }
  }

  async commit(
    collection: string,
    rows: Rows,
    opts: { message?: string } = {},
  ): Promise<CommitResult> {
    const files = await this.build(rows)
    return this.commitFiles(collection, files, opts.message)
  }

  async open(collection: string, version?: number): Promise<Handle> {
    const view = await v3.openView(this.store, collection, version === undefined ? {} : { version })
    // Files of one run have key ranges that don't overlap, so a key sits in at most one per run.
    const runs = new Set(view.files.map((f) => `${f.commits[0]}-${f.commits[1]}-${f.labeled}`))
    return { collection, version: view.version, files: view.files.length, runs: runs.size, view }
  }

  async readPoint(h: Handle, type: string, id: string): Promise<number> {
    const r = await v3.getRecord(this.store, h.view as v3.View, type, id, { cache: this.cache })
    return r?.line?.byteLength ?? 0
  }

  async readPage(h: Handle, type: string, after: string | null, limit: number): Promise<number> {
    const rows = await v3.page(
      this.store,
      h.view as v3.View,
      { type, limit, ...(after === null ? {} : { after: { type, id: after } }) },
      { cache: this.cache },
    )
    return rows.length
  }

  async exportAll(h: Handle, range: v3.KeyRange = {}): Promise<{ records: number; bytes: number }> {
    let records = 0
    let bytes = 0
    for await (const r of v3.exportAll(this.store, h.view as v3.View, range, {
      cache: this.cache,
    })) {
      records++
      bytes += r.line?.byteLength ?? 0
      if (records % 2_000_000 === 0) console.log(`export: ${records} records`)
    }
    return { records, bytes }
  }

  async diff(h: Handle, since: number, opts: { before: boolean; limit?: number }): Promise<number> {
    let n = 0
    for await (const _ of v3.changes(
      this.store,
      h.view as v3.View,
      since,
      { before: opts.before },
      { cache: this.cache },
    )) {
      if (++n >= (opts.limit ?? Infinity)) break
    }
    return n
  }

  async history(h: Handle, type: string, id: string): Promise<number> {
    return (await v3.history(this.store, h.view as v3.View, type, id, { cache: this.cache })).length
  }

  async fork(parent: string, fork: string): Promise<{ objects: number; bytes: number }> {
    const f = await v3.forkCollection(this.store, parent, fork)
    return { objects: f.objects, bytes: f.bytes }
  }

  async maintain(collection: string): Promise<MaintainResult> {
    const total: MaintainResult = {
      layouts: 0,
      merges: 0,
      filesIn: 0,
      filesOut: 0,
      written: 0,
      bytesIn: 0,
      dropped: 0,
    }
    for (;;) {
      const r = await v3.rebuild(this.store, collection, {
        cache: this.cache,
        // Maintenance runs after each commit here, so it always leaves a layout that lists
        // the newest commit's files: the next commit and the next cold read open one layout,
        // not a commit for each upload since the last merge.
        adoptAfter: 1,
        ...(this.opts.tiers ? { tiers: this.opts.tiers } : {}),
        ...(this.opts.level === undefined ? {} : { level: this.opts.level }),
      })
      if (!r.layout) break
      total.layouts++
      total.merges += r.merges
      total.filesIn += r.filesIn
      total.filesOut += r.filesOut
      total.written += r.written
      total.bytesIn += r.bytesIn
      total.dropped += r.dropped
      // A layout that only adopted commits leaves nothing more to merge.
      if (r.merges === 0) break
    }
    return total
  }

  deleteCollection(collection: string): Promise<number> {
    return v3.deleteCollection(this.store, collection)
  }

  storageStats(): Promise<Record<string, { objects: number; bytes: number }>> {
    return diskUsage(this.store.dir)
  }
}
