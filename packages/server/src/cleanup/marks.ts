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
 */
import {
  countTree,
  type FileEntry,
  fileTree,
  gunzipText,
  gzip,
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

export class MarkSet {
  readonly hashes = new Set<string>()
  /** Added since the last save. */
  #fresh: string[] = []
  /** Tree nodes read, for job budgets. */
  reads = 0

  has(h: string): boolean {
    return this.hashes.has(h)
  }

  add(h: string): void {
    if (this.hashes.has(h)) return
    this.hashes.add(h)
    this.#fresh.push(h)
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
    if (!root || this.marks.has(root)) return
    const node = await this.repo.decoded(spec, root)
    this.marks.reads++
    if (node.kind === 'leaf') leaf?.(node.entries)
    else for (const c of node.children) await this.tree(spec, c.hash, leaf)
    this.marks.add(root)
  }

  records(root: string | null) {
    return this.tree<RecordEntry>(recordTree, root, (entries) => {
      for (const e of entries) if (e.size > OUT_OF_LINE_BYTES) this.marks.add(e.hash)
    })
  }

  files(root: string | null) {
    return this.tree<FileEntry>(fileTree, root, (entries) => {
      for (const e of entries) this.marks.add(e.key)
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
    if (this.marks.has(digest)) return
    const root = await this.repo.root(hash)
    await this.set(root.public)
    if (root.private) {
      await this.set(await this.repo.privateSet(root.private))
      this.marks.add(root.private)
    }
    this.marks.add(digest)
  }

  /** A deleted collection's versions, from its signed log (the rows went with it). */
  async fromLog(collectionId: string): Promise<number> {
    const head = await readHead(this.repo, collectionId)
    let n = 0
    for (let seq = 1; seq <= (head?.seq ?? 0); seq++) {
      const entry = await readLogEntry(this.repo, collectionId, seq)
      if (!entry)
        throw new Error(`Log entry ${seq} of deleted collection ${collectionId} is missing`)
      await this.version(entry.versionHash)
      n++
    }
    return n
  }
}
