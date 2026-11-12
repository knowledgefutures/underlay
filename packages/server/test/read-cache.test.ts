import { type BlobObject, memoryStore, type Store } from '@underlay/protocol'
import { describe, expect, it } from 'vitest'

import { MemoryCache } from '../src/cache.js'
import { ReadCachedStore } from '../src/v3/read-cache.js'

/** A store whose etag changes on every write, counting the reads that reach it. */
function countingStore() {
  const inner = memoryStore()
  const etags = new Map<string, string>()
  let n = 0
  const reads: string[] = []
  const withEtag = (key: string, o: BlobObject | null): BlobObject | null =>
    o ? { ...o, etag: etags.get(key) ?? '' } : o
  const store: Store = {
    get: async (key, range) => {
      reads.push(`get ${key} ${range ? `${range.offset}:${range.length}` : ''}`)
      return withEtag(key, await inner.get(key, range))
    },
    tail: async (key, length) => {
      reads.push(`tail ${key}`)
      return withEtag(key, await inner.tail(key, length))
    },
    head: (key) => inner.head(key),
    put: async (key, body, opts) => {
      etags.set(key, `e${++n}`)
      await inner.put(key, body, opts)
    },
    list: (p, c) => inner.list(p, c),
    delete: (key) => inner.delete(key),
  }
  return { store, reads }
}

const key = `records/${'a'.repeat(64)}`
const text = (o: BlobObject | null) => o!.text()

describe('the v3 read cache', () => {
  it("serves a file's blocks from cache, under the etag its tail was read with", async () => {
    const { store, reads } = countingStore()
    const cached = new ReadCachedStore(store, new MemoryCache())
    await store.put(key, 'first bytes of a file')
    await cached.tail(key, 5)
    expect(await text(await cached.get(key, { offset: 0, length: 5 }))).toBe('first')
    reads.length = 0
    expect(await text(await cached.get(key, { offset: 0, length: 5 }))).toBe('first')
    expect(reads).toEqual([])

    // Stored again with other bytes under the same id: once a tail read learns the new
    // etag, its blocks are read afresh, never the old object's.
    await store.put(key, 'other bytes entirely')
    await cached.tail(key, 5)
    expect(await text(await cached.get(key, { offset: 0, length: 5 }))).toBe('other')
    // Anything but a file's ranged read goes straight through.
    reads.length = 0
    await cached.get(key)
    await cached.get('c/commits/000001.json')
    expect(reads).toHaveLength(2)
  })
})
