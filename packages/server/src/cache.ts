import { type Cache, Lru } from '@underlay/protocol'

/** Node: an in-process LRU (the isolate LRU in Objects sits in front of it). */
export class MemoryCache implements Cache {
  readonly #lru: Lru<Uint8Array>
  constructor(budgetBytes = 256 * 1024 * 1024) {
    this.#lru = new Lru(budgetBytes, (v) => v.byteLength)
  }
  async get(key: string, opts?: { maxBytes?: number }) {
    const hit = this.#lru.get(key) ?? null
    return hit && opts?.maxBytes !== undefined && hit.byteLength > opts.maxBytes ? null : hit
  }
  async put(key: string, value: Uint8Array) {
    this.#lru.set(key, value)
  }
}

/** The cached bytes' length, so a size-capped get can refuse an entry without reading it. */
const SIZE_HEADER = 'x-underlay-bytes'

interface CfCacheStorage {
  default: {
    match(req: Request): Promise<Response | undefined>
    put(req: Request, res: Response): Promise<void>
  }
}

/**
 * Workers: the per-colo Cache API. Keys are synthetic URLs; everything cached is
 * immutable and keyed by content, so it's cached for a year.
 */
export class CfCache implements Cache {
  constructor(
    readonly caches: CfCacheStorage,
    readonly namespace: string,
    /** Run a cache write after the response (ctx.waitUntil), not on the request's path. */
    readonly defer?: (p: Promise<unknown>) => void,
  ) {}
  #req(key: string) {
    return new Request(`https://cache.underlay.internal/${this.namespace}/${key}`)
  }
  async get(key: string, opts?: { maxBytes?: number }) {
    const res = await this.caches.default.match(this.#req(key))
    if (!res) return null
    if (opts?.maxBytes !== undefined) {
      // The size from the header put writes, else Content-Length; unknown counts as too large.
      const size = Number(res.headers.get(SIZE_HEADER) ?? res.headers.get('content-length') ?? NaN)
      if (!(size <= opts.maxBytes)) {
        await res.body?.cancel()
        return null
      }
    }
    return new Uint8Array(await res.arrayBuffer())
  }
  async put(key: string, value: Uint8Array, opts?: { ttlSeconds?: number }) {
    const ttl = opts?.ttlSeconds ?? 31_536_000
    const write = this.caches.default.put(
      this.#req(key),
      new Response(value as Uint8Array<ArrayBuffer>, {
        headers: {
          'cache-control': `public, max-age=${ttl}, immutable`,
          [SIZE_HEADER]: String(value.byteLength),
        },
      }),
    )
    if (this.defer) this.defer(write.catch((err: unknown) => console.error('[cache] put', err)))
    else await write
  }
}
