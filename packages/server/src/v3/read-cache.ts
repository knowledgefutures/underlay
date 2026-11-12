/**
 * Caches in front of the v3 area for the read routes: not part of the protocol, and
 * never on a write path.
 *
 *   readStore   the v3 store, with a sorted-record-file's blocks read through two caches:
 *               this isolate's memory, then the colo's (the Cache API on Workers,
 *               `ports.cache`). Opening a file (its tail) still asks R2 once an isolate,
 *               and learns the object's etag; its blocks are then cached under it.
 *   readView    a version resolved to its files, kept by collection, commit number, and
 *               version id for a few minutes in both caches. The version D1 names has
 *               landed, so opening one skips the commit probe.
 *
 * Without these, every read of a v3 collection made four or more requests to R2 in
 * sequence (the hint, the layout, a probe past each) before reading a record, and every
 * block again on each request: about 150 to 200 ms over v2's reads at any size
 * (v3-deploy-plan.md, "Read timing on staging").
 *
 * Why these keys. A file's id names its content, not its bytes: blocks compressed by
 * another compressor have the same id, and a file the sweep removed may be stored again
 * by another upload. So a block is cached under the stored object's etag, and a reader
 * holding an older footer reads the older blocks it describes. Commits and layouts are
 * rewritten under the same numbers when a collection is converted afresh, so they are
 * not cached on their own; a view is, keyed by D1's version id, which changes with them.
 * A view kept a few minutes may name files a rebuild has since replaced; those stay
 * stored through the sweep's grace (a day in trash, then a week). The denylist is
 * applied when records are read, not when views are made.
 */
import {
  blobObject,
  type BlobObject,
  type Cache,
  Lru,
  type Presigner,
  type Store,
  v3,
} from '@underlay/protocol'

import type { Ports } from '../ports.js'

/** A stored sorted-record-file. */
const FILE = /(^|\/)records\/[0-9a-f]{64}$/

/**
 * What one cached read may hold: a block as a page reads it (a record block inflates to
 * about 256 KiB, a key block to less). A scan's read-ahead windows (2 MiB and up) go
 * straight through: caching them filled the isolate during a deep walk.
 */
const MAX_CACHED_BYTES = 512 * 1024

/** This isolate's share, across requests: a few hundred blocks, well inside 128 MB. */
const ISOLATE_BYTES = 24 * 1024 * 1024

/** How long a resolved view is kept. */
export const VIEW_TTL_MS = 5 * 60 * 1000

const blocks = new Lru<Uint8Array>(ISOLATE_BYTES, (b) => b.byteLength)
/** Each file's stored etag, as last read from R2. */
const etags = new Map<string, string>()

const asObject = (bytes: Uint8Array, etag: string): BlobObject =>
  blobObject(bytes, { etag, contentType: null })

function learn(key: string, etag: string) {
  if (!etag) return
  if (etags.size > 100_000) etags.clear()
  etags.set(key, etag)
}

/** The v3 store with a file's block reads cached; everything else goes straight through. */
export class ReadCachedStore implements Store {
  readonly presigner?: Presigner
  constructor(
    readonly inner: Store,
    readonly cache: Cache,
  ) {
    if (inner.presigner) this.presigner = inner.presigner
  }

  async get(key: string, range?: { offset: number; length?: number }) {
    if (!FILE.test(key) || !range || range.length === undefined) return this.inner.get(key, range)
    const at = `@${range.offset}:${range.length}`
    const known = etags.get(key)
    // The isolate keeps its own copy and hands out copies: a reader may detach or consume
    // the bytes it is given (inflating them), and the next request would get them empty.
    if (known) {
      const ck = `v3b/${key}#${known}${at}`
      const hot = blocks.get(ck)
      if (hot) return asObject(hot.slice(), known)
      const warm = await this.cache.get(ck, { maxBytes: MAX_CACHED_BYTES }).catch(() => null)
      if (warm) {
        blocks.set(ck, warm.slice())
        return asObject(warm, known)
      }
    }
    const obj = await this.inner.get(key, range)
    if (!obj) return null
    learn(key, obj.etag)
    if (!obj.etag || obj.size > MAX_CACHED_BYTES) return obj
    const bytes = await obj.bytes()
    const ck = `v3b/${key}#${obj.etag}${at}`
    blocks.set(ck, bytes.slice())
    // A failed cache write costs a later read, never this one.
    await this.cache.put(ck, bytes.slice()).catch(() => {})
    return asObject(bytes, obj.etag)
  }

  async tail(key: string, length: number) {
    const obj = this.inner.tail
      ? await this.inner.tail(key, length)
      : await this.inner
          .head(key)
          .then((h) => (h ? this.inner.get(key, { offset: Math.max(0, h.size - length) }) : null))
    if (obj && FILE.test(key)) learn(key, obj.etag)
    return obj
  }

  head: Store['head'] = (key) => this.inner.head(key)
  put: Store['put'] = (...a) => this.inner.put(...a)
  list: Store['list'] = (...a) => this.inner.list(...a)
  delete: Store['delete'] = (...a) => this.inner.delete(...a)
}

const stores = new WeakMap<Ports, ReadCachedStore>()

/** The read routes' v3 store: one wrapper per ports, so per request on Workers. */
export function readStore(ports: Ports): ReadCachedStore {
  let s = stores.get(ports)
  if (!s) stores.set(ports, (s = new ReadCachedStore(ports.stores.v3, ports.cache)))
  return s
}

const views = new Map<string, { at: number; view: v3.View }>()
const MAX_VIEWS = 2_000

/**
 * A version of a v3 collection resolved to its files, by its D1 row (`seq`, the commit
 * number, and `hash`, the version id); null when the collection no longer holds it. The version D1 names
 * has landed, so it is passed as the newest commit: a read needs nothing newer, and the
 * probe for one is skipped.
 */
export async function readView(
  ports: Ports,
  collectionId: string,
  version: { seq: number; hash: string },
): Promise<v3.View | null> {
  if (version.seq < 1) return null
  const key = `${collectionId}:${version.seq}:${version.hash}`
  const hit = views.get(key)
  if (hit && Date.now() - hit.at < VIEW_TTL_MS) return hit.view
  const ck = `v3view/${key}`
  const warm = await ports.cache.get(ck).catch(() => null)
  let view: v3.View | null = null
  let at = Date.now()
  if (warm) {
    const parsed = JSON.parse(new TextDecoder().decode(warm)) as { at: number; view: v3.View }
    if (Date.now() - parsed.at < VIEW_TTL_MS) ({ view, at } = parsed)
  }
  if (!view) {
    try {
      view = await v3.openView(readStore(ports), collectionId, {
        version: version.seq,
        head: version.seq,
      })
    } catch (err) {
      if (err instanceof v3.VersionError) return null
      throw err
    }
    const body = new TextEncoder().encode(JSON.stringify({ at, view }))
    await ports.cache.put(ck, body, { ttlSeconds: VIEW_TTL_MS / 1000 }).catch(() => {})
  }
  if (views.size >= MAX_VIEWS) views.clear()
  views.set(key, { at, view })
  return view
}
