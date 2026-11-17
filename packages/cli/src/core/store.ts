/**
 * The store (local-tool.md "Configuration"): record files, versions not yet pushed, and run
 * logs, outside home. Default `~/.local/share/underlay`; a rule may send a
 * collection's records elsewhere, which is then a store of its own.
 *
 * A store is laid out as a v3 server lays out its bucket (protocol-v3 Section 9), so the
 * library reads it as it reads one:
 *
 *   records/<file id>                          sorted-record-files, once per store
 *   collections/<id>/commits/<n>.json          the log: pulled commits and unpushed ones
 *   collections/<id>/commits/<n>.receipt.json  the authority's receipt, once pushed or pulled
 *   collections/<id>/layouts/<n>.json          the authority's current layout, as pulled
 *   local/<id>.json                            what this machine knows of each version
 *   runs/<run>/                                a run's log and output
 *
 * A file a version names but this machine does not keep is fetched from the authority when
 * something reads it, and kept from then on (`forget` lets it go).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  type BlobHead,
  type BlobObject,
  type FileStore,
  fileStore,
  type Store,
  v3,
} from '@underlay/protocol'

/** What this machine knows of a version beyond its commit. */
export interface VersionNote {
  /** Stays the same through replays, so a run keeps pointing at its version. */
  change: string
  savedAt: string
  run?: string
  message?: string | null
  stats?: { added: number; changed: number; removed: number }
}

export interface CollectionState {
  /** The authority's newest version as of the last pull or push; null if it has none. */
  remote: { number: number; id: string; semver: string } | null
  /** By version id. */
  versions: Record<string, VersionNote>
}

export class LocalStore {
  readonly fs: FileStore

  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true })
    this.fs = fileStore(root)
  }

  statePath(cid: string) {
    return join(this.root, 'local', `${cid}.json`)
  }

  state(cid: string): CollectionState {
    const p = this.statePath(cid)
    if (!existsSync(p)) return { remote: null, versions: {} }
    return JSON.parse(readFileSync(p, 'utf8')) as CollectionState
  }

  setState(cid: string, s: CollectionState): void {
    const p = this.statePath(cid)
    mkdirSync(dirname(p), { recursive: true })
    // Written whole and renamed into place, so a reader never sees half of it.
    const tmp = `${p}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(s, null, 1))
    renameSync(tmp, p)
  }

  runDir(run: string) {
    return join(this.root, 'runs', run)
  }
}

/**
 * A store that fetches a record file it does not hold from the authority, and keeps it.
 * Everything else is the local store's.
 */
export class FetchingStore implements Store {
  readonly #pending = new Map<string, Promise<boolean>>()

  constructor(
    readonly local: Store,
    readonly fetchFile: ((id: string) => Promise<Uint8Array>) | null,
  ) {}

  /** Fetch `records/<id>` if absent; true if it is here now. */
  async #ensure(key: string): Promise<boolean> {
    if (!this.fetchFile || !key.startsWith('records/')) return false
    const id = key.slice('records/'.length)
    if (!/^[0-9a-f]{64}$/.test(id)) return false
    let p = this.#pending.get(id)
    if (!p) {
      p = (async () => {
        const bytes = await this.fetchFile!(id)
        // Checked against its id before it is kept: a file is named by its content.
        const scratch = `tmp/fetch-${crypto.randomUUID()}`
        await this.local.put(scratch, bytes)
        try {
          await v3.verifyFile(this.local, scratch, { id })
          await this.local.put(key, bytes)
        } finally {
          await this.local.delete(scratch)
        }
        return true
      })()
      this.#pending.set(id, p)
      p.finally(() => this.#pending.delete(id)).catch(() => {})
    }
    return p
  }

  async get(key: string, range?: { offset: number; length?: number }): Promise<BlobObject | null> {
    const hit = await this.local.get(key, range)
    if (hit) return hit
    return (await this.#ensure(key)) ? this.local.get(key, range) : null
  }

  async head(key: string): Promise<BlobHead | null> {
    const hit = await this.local.head(key)
    if (hit) return hit
    return (await this.#ensure(key)) ? this.local.head(key) : null
  }

  put: Store['put'] = (k, b, o) => this.local.put(k, b, o)
  list: Store['list'] = (p, c) => this.local.list(p, c)
  delete: Store['delete'] = (k) => this.local.delete(k)
  create: NonNullable<Store['create']> = (k, b, o) => this.local.create!(k, b, o)
  copy: NonNullable<Store['copy']> = (f, t, s) =>
    this.local.copy ? this.local.copy(f, t, s) : Promise.reject(new Error('no copy'))
}

/** An empty view: the version before a collection's first. */
export const emptyView = (collection: string): v3.View => ({
  collection,
  version: 0,
  head: 0,
  layout: 0,
  through: 0,
  files: [],
})
