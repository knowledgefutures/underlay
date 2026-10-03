import { Lru } from './lib/lru.js'
import type { Cache } from './ports.js'

/** Node: an in-process LRU (the isolate LRU in Objects sits in front of it). */
export class MemoryCache implements Cache {
  readonly #lru: Lru<Uint8Array>
  constructor(budgetBytes = 256 * 1024 * 1024) {
    this.#lru = new Lru(budgetBytes, (v) => v.byteLength)
  }
  async get(key: string) {
    return this.#lru.get(key) ?? null
  }
  async put(key: string, value: Uint8Array) {
    this.#lru.set(key, value)
  }
}

/** A cache that holds nothing (tests that count blob reads). */
export const noCache: Cache = {
  get: async () => null,
  put: async () => {},
}

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
  ) {}
  #req(key: string) {
    return new Request(`https://cache.underlay.internal/${this.namespace}/${key}`)
  }
  async get(key: string) {
    const res = await this.caches.default.match(this.#req(key))
    return res ? new Uint8Array(await res.arrayBuffer()) : null
  }
  async put(key: string, value: Uint8Array, opts?: { ttlSeconds?: number }) {
    const ttl = opts?.ttlSeconds ?? 31_536_000
    await this.caches.default.put(
      this.#req(key),
      new Response(value as Uint8Array<ArrayBuffer>, {
        headers: { 'cache-control': `public, max-age=${ttl}, immutable` },
      }),
    )
  }
}
