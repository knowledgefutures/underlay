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
    const n = this.#fresh.length
    if (n === 0) return 0
    const key = `${runDir(runId)}/${name}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.txt.gz`
    await store.put(key, await gzip(this.#fresh.join('\n')), { contentType: 'application/gzip' })
    this.#fresh = []
    return n
  }
}

/** Walks a repository's trees into a MarkSet. */
export class Marker {
  constructor(
    readonly repo: Repo,
    readonly marks: MarkSet,
  ) {}

  /** A tree and what its leaves point to. Marks a node only once its subtree is done. */
  async tree<E>(spec: TreeSpec<E>, root: string | null, leaf?: (entries: E[]) => void) {
    if (!root || this.marks.has('n', root)) return
    const node = await this.repo.decoded(spec, root)
    this.marks.reads++
    if (node.kind === 'leaf') leaf?.(node.entries)
    else for (const c of node.children) await this.tree(spec, c.hash, leaf)
    this.marks.add('n', root)
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

  async set(s: SetObject) {
    for (const t of Object.values(s.types)) await this.records(t.root)
    await this.files(s.files.root)
  }

  /** A version: its sets, then its root (so a marked root means a fully marked version). */
  async version(hash: string) {
    const digest = versionDigest(hash)
    if (this.marks.has('v', digest)) return
    const root = await this.repo.root(hash)
    await this.set(root.public)
    if (root.private) {
      // A version copied with its public sets only (a public mirror read back)
      // keeps the commitment but not the object: nothing of it is here to keep.
      if (await this.repo.blobs.head(keys.privateSet(root.private))) {
        await this.set(await this.repo.privateSet(root.private))
      }
      this.marks.add('p', root.private)
    }
    this.marks.add('v', digest)
  }

  /**
   * A deleted collection's versions, from its signed log (the rows went with it).
   * Returns how many it marked and what it couldn't: a broken log only costs this
   * collection its grace period, it doesn't stop every mark for a week.
   */
  async fromLog(collectionId: string): Promise<{ versions: number; problem: string | null }> {
    let versions = 0
    try {
      const head = await readHead(this.repo, collectionId)
      for (let seq = 1; seq <= (head?.seq ?? 0); seq++) {
        const entry = await readLogEntry(this.repo, collectionId, seq)
        this.marks.reads++
        if (!entry) return { versions, problem: `log entry ${seq} is missing` }
        await this.version(entry.versionHash)
        versions++
      }
      return { versions, problem: null }
    } catch (err) {
      return { versions, problem: (err as Error).message }
    }
  }
}
