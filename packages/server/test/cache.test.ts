/**
 * The shared caches refuse an entry over a size cap without reading it, so a
 * streamed read of a large leaf body never takes a whole cached copy.
 */
import { describe, expect, it } from 'vitest'

import { CfCache, MemoryCache } from '../src/cache.js'

/** A stand-in for the Workers Cache API that counts body reads and cancels. */
function fakeCaches() {
  const entries = new Map<string, { bytes: Uint8Array; headers: Headers }>()
  let bodyReads = 0
  let cancels = 0
  const caches = {
    default: {
      async match(req: Request) {
        const e = entries.get(req.url)
        if (!e) return undefined
        return {
          headers: e.headers,
          body: { cancel: async () => void cancels++ },
          arrayBuffer: async () => {
            bodyReads++
            return e.bytes.slice().buffer
          },
        } as unknown as Response
      },
      async put(req: Request, res: Response) {
        entries.set(req.url, {
          bytes: new Uint8Array(await res.arrayBuffer()),
          headers: res.headers,
        })
      },
    },
  }
  return { caches, entries, reads: () => bodyReads, cancels: () => cancels }
}

describe('CfCache', () => {
  it('records the size on put, and a capped get refuses a larger entry without reading it', async () => {
    const f = fakeCaches()
    const cache = new CfCache(f.caches, 'test')
    await cache.put('small', new Uint8Array(10))
    await cache.put('big', new Uint8Array(5000))
    expect((await cache.get('small', { maxBytes: 100 }))?.byteLength).toBe(10)
    const reads = f.reads()
    expect(await cache.get('big', { maxBytes: 100 })).toBeNull()
    expect(f.reads()).toBe(reads)
    expect(f.cancels()).toBe(1)
    // Uncapped, it's a hit as before.
    expect((await cache.get('big'))?.byteLength).toBe(5000)
  })

  it('treats an entry of unknown size as too large under a cap', async () => {
    const f = fakeCaches()
    const cache = new CfCache(f.caches, 'test')
    // An entry written before the size header, served without Content-Length.
    f.entries.set('https://cache.underlay.internal/test/old', {
      bytes: new Uint8Array(10),
      headers: new Headers(),
    })
    expect(await cache.get('old', { maxBytes: 100 })).toBeNull()
    expect((await cache.get('old'))?.byteLength).toBe(10)
  })
})

describe('MemoryCache', () => {
  it('refuses an entry over the cap', async () => {
    const cache = new MemoryCache()
    await cache.put('big', new Uint8Array(5000))
    expect(await cache.get('big', { maxBytes: 100 })).toBeNull()
    expect((await cache.get('big', { maxBytes: 5000 }))?.byteLength).toBe(5000)
  })
})
