import {
  compareUtf8,
  diffTrees,
  fileTree,
  hashRecord,
  iterate,
  mergeTree,
  type RecordEntry,
  recordTree,
  TreeBuilder,
  utf8ByteLength,
  verifyTree,
} from '@underlay/core'
import { describe, expect, it } from 'vitest'

import { MemoryBlobStore } from '../src/blob/memory.js'
import { noCache } from '../src/cache.js'
import { Lru } from '../src/lib/lru.js'
import {
  BlobSink,
  BlobSource,
  bodyOfRecord,
  dropRecordBody,
  keys,
  Objects,
  OUT_OF_LINE_BYTES,
  recordPayloadBytes,
} from '../src/storage/objects.js'

const freshObjects = () => {
  const blobs = new MemoryBlobStore()
  // A private LRU per test, so reads really go to the store.
  return { blobs, objects: new Objects(blobs, noCache, new Lru(8 * 1024 * 1024, () => 1024)) }
}

const record = (id: string, v = 0): RecordEntry => {
  const { hash, canonical } = hashRecord(id, 'T', { id, v, pad: 'x'.repeat(200) })
  return { key: id, hash, size: utf8ByteLength(canonical), body: canonical }
}

const ids = (n: number) =>
  Array.from({ length: n }, (_, i) => `rec-${String(i).padStart(6, '0')}`).sort(compareUtf8)

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of it) out.push(x)
  return out
}

describe('record trees in the blob store', () => {
  it('round-trips nodes and bodies, and verifies', async () => {
    const { blobs, objects } = freshObjects()
    const sink = new BlobSink(objects, { bodyOf: bodyOfRecord })
    const b = new TreeBuilder(recordTree, sink)
    for (const id of ids(5000)) b.addEntry(record(id))
    const { root } = b.finish()
    await sink.flush()
    expect(root!.count).toBe(5000)
    expect([...blobs.objects.keys()].filter((k) => k.startsWith('bodies/')).length).toBeGreaterThan(
      1,
    )

    const source = new BlobSource(recordTree, objects)
    expect((await verifyTree(source, root!.hash)).ok).toBe(true)
    const rows = await collect(iterate(source, root!.hash, { payloads: true, offset: 4990 }))
    expect(rows.map((r) => r.key)).toEqual(ids(5000).slice(4990))
    for (const r of rows) expect(JSON.parse(r.body!).id).toBe(r.key)
  })

  it('merges against stored trees, rewriting only changed leaves', async () => {
    const { blobs, objects } = freshObjects()
    const sink = new BlobSink(objects, { bodyOf: bodyOfRecord })
    const b = new TreeBuilder(recordTree, sink)
    const all = ids(20_000)
    for (const id of all) b.addEntry(record(id))
    const base = b.finish().root!
    await sink.flush()
    const putsBefore = blobs.puts

    const source = new BlobSource(recordTree, objects)
    const changes = [all[10]!, all[15_000]!].map((id) => ({ key: id, entry: record(id, 1) }))
    const sink2 = new BlobSink(objects, { bodyOf: bodyOfRecord })
    const merged = await mergeTree(source, sink2, base.hash, changes)
    await sink2.flush()
    expect(merged.stats.updated).toBe(2)
    // Two leaves (node + body each) and their paths; nothing else.
    expect(blobs.puts - putsBefore).toBeLessThanOrEqual(2 * 2 + 2 * (base.level + 1))
    const diff = await collect(diffTrees(source, base.hash, merged.root!.hash))
    expect(diff.map((d) => d.key)).toEqual([all[10], all[15_000]])
    const changed = await collect(
      iterate(source, merged.root!.hash, { payloads: true, offset: 10 }),
    )
    expect(JSON.parse(changed[0]!.body!).data.v).toBe(1)
  })

  it('spills large leaf bodies into parts and reads them back', async () => {
    const { blobs, objects } = freshObjects()
    const sink = new BlobSink(objects, { bodyOf: bodyOfRecord })
    const b = new TreeBuilder(recordTree, sink, {
      payloadBytes: recordPayloadBytes,
      dropPayload: dropRecordBody,
      spillBytes: 20_000, // tiny, to force parts
    })
    for (const id of ids(3000)) b.addEntry(record(id))
    const root = b.finish().root!
    await sink.flush()
    expect([...blobs.objects.keys()].some((k) => k.startsWith('bodyparts/'))).toBe(true)
    const source = new BlobSource(recordTree, objects)
    const rows = await collect(iterate(source, root.hash, { payloads: true }))
    expect(rows.length).toBe(3000)
    expect(rows.every((r) => JSON.parse(r.body!).id === r.key)).toBe(true)
  })

  it('resolves out-of-line records', async () => {
    const { objects } = freshObjects()
    const big = hashRecord('big', 'T', { blob: 'y'.repeat(OUT_OF_LINE_BYTES + 10) })
    const pointer = await objects.putOutOfLine(big.hash, big.canonical)
    const sink = new BlobSink(objects, { bodyOf: bodyOfRecord })
    const b = new TreeBuilder(recordTree, sink)
    b.addEntry(record('a'))
    b.addEntry({ key: 'big', hash: big.hash, size: utf8ByteLength(big.canonical), body: pointer })
    const root = b.finish().root!
    await sink.flush()
    const rows = await collect(
      iterate(new BlobSource(recordTree, objects), root.hash, { payloads: true }),
    )
    expect(rows[1]!.body).toBe(big.canonical)
  })

  it('stores file trees without bodies', async () => {
    const { blobs, objects } = freshObjects()
    const sink = new BlobSink(objects)
    const b = new TreeBuilder(fileTree, sink)
    b.addEntry({ key: 'a'.repeat(64), size: 10 })
    b.addEntry({ key: 'b'.repeat(64), size: 20 })
    const root = b.finish().root!
    await sink.flush()
    expect([...blobs.objects.keys()]).toEqual([keys.node(root.hash)])
    const entries = await collect(iterate(new BlobSource(fileTree, objects), root.hash))
    expect(entries.map((e) => e.size)).toEqual([10, 20])
  })
})
