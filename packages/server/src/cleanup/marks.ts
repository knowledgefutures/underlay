/**
 * The mark: every hash a live collection still reaches (planning:
 * v2-storage-cleanup.md, step 2).
 *
 * A version reaches its root (`roots/<digest>`), its private set object
 * (`private/<commitment>`), every node of its record and file trees
 * (`nodes/<hash>`), each leaf's body (`bodies/<leafHash>`, so the leaf hash
 * covers it), its out-of-line records (`records/<hash>`: entries over
 * OUT_OF_LINE_BYTES, the only threshold any writer uses) and its files
 * (`files/<hash>`). Rows add the file reference count trees and the cumulative
 * public files tree. Schemas are never swept, so they aren't marked.
 *
 * Only tree nodes are read. The set is exact, so a node already in it is
 * skipped with its whole subtree: shared history costs one read per distinct
 * node. A read that fails fails the mark: a sweep never runs on a partial one.
 *
 * Entries are kept per kind (`n:` a walked node, which covers its body, `v:` a
 * walked version root, `p:` a private set object, `r:` an out-of-line record,
 * `f:` a file). One flat set would let a file whose bytes happen to be a node's
 * JSON (hash for hash) pass for that node, and the walk would skip the subtree.
 */
import {
  countTree,
  type FileEntry,
  fileTree,
  gunzipText,
  gzip,
  keys,
  OUT_OF_LINE_BYTES,
  readHead,
  readLogEntry,
  type RecordEntry,
  recordTree,
  type Repo,
  type SetObject,
  type Store,
  type TreeSpec,
  versionDigest,
} from '@underlay/protocol'

import { runDir } from './config.js'

/** n: node, v: version root, p: private set object, r: out-of-line record, f: file. */
export type MarkKind = 'n' | 'v' | 'p' | 'r' | 'f'

export class MarkSet {
  readonly hashes = new Set<string>()
  /** Added since the last save. */
  #fresh: string[] = []
  /** Tree nodes read, for job budgets. */
  reads = 0

  has(kind: MarkKind, h: string): boolean {
    return this.hashes.has(`${kind}:${h}`)
  }

  add(kind: MarkKind, h: string): void {
    const token = `${kind}:${h}`
    if (this.hashes.has(token)) return
    this.hashes.add(token)
    this.#fresh.push(token)
  }

  get size(): number {
    return this.hashes.size
  }

  /** Load every shard a run saved under `runDir(runId)` with this name prefix. */
  async load(store: Store, runId: string, name = ''): Promise<void> {
    const prefix = `${runDir(runId)}/${name}`
    let cursor: string | undefined
    do {
      const page = await store.list(prefix, cursor)
      for (const key of page.keys) {
        if (!key.endsWith('.txt.gz')) continue
        const obj = await store.get(key)
        if (!obj) throw new Error(`Mark shard ${key} vanished`)
        for (const h of (await gunzipText(await obj.bytes())).split('\n')) {
          if (h) this.hashes.add(h)
        }
      }
      cursor = page.cursor
    } while (cursor)
  }

  /** Save what was added since the last save as one shard. Returns how many. */
  async save(store: Store, runId: string, name: string): Promise<number> {
    // Taken before the write: a walk may still add while it's in flight.
    const fresh = this.#fresh
    if (fresh.length === 0) return 0
    this.#fresh = []
    const key = `${runDir(runId)}/${name}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.txt.gz`
    try {
      await store.put(key, await gzip(fresh.join('\n')), { contentType: 'application/gzip' })
    } catch (err) {
      this.#fresh = fresh.concat(this.#fresh)
      throw err
    }
    return fresh.length
  }
}

export interface MarkerOptions {
  /** Stop reading once `marks.reads` reaches this (default: no limit). */
  budget?: number
  /** Reads in flight at once. */
  concurrency?: number
  /** Called after each read (a job writes its progress from here). */
  onRead?: () => Promise<void> | void
}

/**
 * Walks a repository's trees into a MarkSet, reading up to `concurrency` nodes
 * at a time. With a budget it stops once the budget is spent, and every walk
 * says whether it finished: false means part of it is still to do, and marks
 * hold only what is complete (a node once its subtree is, a version once its
 * sets are), so walking it again from the top skips what's done.
 */
export class Marker {
  readonly budget: number
  readonly concurrency: number
  readonly onRead: (() => Promise<void> | void) | undefined
  #active = 0
  #waiting: (() => void)[] = []
  readonly #startSize: number

  constructor(
    readonly repo: Repo,
    readonly marks: MarkSet,
    opts: MarkerOptions = {},
  ) {
    this.budget = opts.budget ?? Infinity
    this.concurrency = Math.max(1, opts.concurrency ?? 16)
    this.onRead = opts.onRead
    this.#startSize = marks.size
  }

  /**
   * Whether the budget is spent. Not before this marker has added a mark:
   * walking back down to where the last one stopped costs reads, and every
   * marker has to get further than the one before it.
   */
  get spent(): boolean {
    return this.marks.reads >= this.budget && this.marks.size > this.#startSize
  }

  /** One read, counted, inside the concurrency limit. */
  async #read<T>(f: () => Promise<T>): Promise<T> {
    while (this.#active >= this.concurrency) await new Promise<void>((r) => this.#waiting.push(r))
    this.#active++
    try {
      return await f()
    } finally {
      this.#active--
      this.marks.reads++
      this.#waiting.shift()?.()
    }
  }

  /** A tree and what its leaves point to. Marks a node only once its subtree is done. */
  async tree<E>(
    spec: TreeSpec<E>,
    root: string | null,
    leaf?: (entries: E[]) => void,
  ): Promise<boolean> {
    if (!root || this.marks.has('n', root)) return true
    if (this.spent) return false
    const node = await this.#read(() => this.repo.decoded(spec, root))
    await this.onRead?.()
    if (node.kind === 'leaf') leaf?.(node.entries)
    else {
      // A slice of children at a time keeps the walk close to depth first.
      for (let i = 0; i < node.children.length; i += this.concurrency) {
        const part = node.children.slice(i, i + this.concurrency)
        const done = await Promise.all(part.map((c) => this.tree(spec, c.hash, leaf)))
        if (done.includes(false)) return false
      }
    }
    this.marks.add('n', root)
    return true
  }

  records(root: string | null) {
    return this.tree<RecordEntry>(recordTree, root, (entries) => {
      for (const e of entries) if (e.size > OUT_OF_LINE_BYTES) this.marks.add('r', e.hash)
    })
  }

  files(root: string | null) {
    return this.tree<FileEntry>(fileTree, root, (entries) => {
      for (const e of entries) this.marks.add('f', e.key)
    })
  }

  counts(root: string | null) {
    return this.tree(countTree, root)
  }

  async set(s: SetObject): Promise<boolean> {
    for (const t of Object.values(s.types)) if (!(await this.records(t.root))) return false
    return this.files(s.files.root)
  }

  /** A version: its sets, then its root (so a marked root means a fully marked version). */
  async version(hash: string): Promise<boolean> {
    const digest = versionDigest(hash)
    if (this.marks.has('v', digest)) return true
    if (this.spent) return false
    const root = await this.#read(() => this.repo.root(hash))
    if (!(await this.set(root.public))) return false
    if (root.private) {
      // A version copied with its public sets only (a public mirror read back)
      // keeps the commitment but not the object: nothing of it is here to keep.
      if (await this.repo.blobs.head(keys.privateSet(root.private))) {
        if (!(await this.set(await this.#read(() => this.repo.privateSet(root.private!))))) {
          return false
        }
      }
      this.marks.add('p', root.private)
    }
    this.marks.add('v', digest)
    return true
  }

  /**
   * A deleted collection's versions, from its signed log (the rows went with it),
   * starting after log entry `after`. Returns the last entry it finished, the
   * log's length, and what it couldn't: a broken log only costs this collection
   * its grace period, it doesn't stop every mark for a week.
   */
  async fromLog(
    collectionId: string,
    after = 0,
  ): Promise<{ seq: number; length: number; complete: boolean; problem: string | null }> {
    let seq = after
    let length = 0
    try {
      const head = await readHead(this.repo, collectionId)
      length = head?.seq ?? 0
      while (seq < length) {
        if (this.spent) return { seq, length, complete: false, problem: null }
        const entry = await this.#read(() => readLogEntry(this.repo, collectionId, seq + 1))
        if (!entry)
          return { seq, length, complete: true, problem: `log entry ${seq + 1} is missing` }
        if (!(await this.version(entry.versionHash)))
          return { seq, length, complete: false, problem: null }
        seq++
      }
      return { seq, length, complete: true, problem: null }
    } catch (err) {
      return { seq, length, complete: true, problem: (err as Error).message }
    }
  }
}
