import { describe, expect, it } from 'vitest'

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
} from '../../src/format.js'
import { gzip } from '../../src/repo/gzip.js'
import { Lru } from '../../src/repo/lru.js'
import {
  bodyOfRecord,
  dropRecordBody,
  IntegrityError,
  keys,
  OUT_OF_LINE_BYTES,
  recordPayloadBytes,
  Repo,
  RepoSink,
  RepoSource,
} from '../../src/repo/repo.js'
import { PrefixedBlobStore } from '../../src/repo/types.js'
import { MemoryBlobStore } from '../../src/stores/memory.js'

const freshRepo = (opts: { trusted?: boolean } = {}) => {
  const blobs = new MemoryBlobStore()
  // A private LRU per test, so reads really go to the store.
  const repo = new Repo(blobs, {
    scope: 'test',
    trusted: opts.trusted ?? true,
    lru: new Lru(8 << 20, () => 1024),
  })
  return { blobs, repo }
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

async function buildRecords(repo: Repo, n: number) {
  const sink = new RepoSink(repo, { bodyOf: bodyOfRecord })
  const b = new TreeBuilder(recordTree, sink)
  for (const id of ids(n)) b.addEntry(record(id))
  const root = b.finish().root!
  await sink.flush()
  return { root, sink }
}

describe('record trees in a repository', () => {
  it('round-trips nodes and bodies in the documented layout, and verifies', async () => {
    const { blobs, repo } = freshRepo()
    const { root, sink } = await buildRecords(repo, 5000)
    expect(root.count).toBe(5000)
    const stored = [...blobs.objects.keys()]
    expect(
      stored.every((k) => /^nodes\/[0-9a-f]{64}$|^bodies\/[0-9a-f]{64}\.ndjson\.gz$/.test(k)),
    ).toBe(true)
    // The sink lists exactly what it wrote: a commit's sync work for mirrors.
    expect(new Set(sink.written)).toEqual(new Set(stored))

    const source = new RepoSource(recordTree, repo)
    expect((await verifyTree(source, root.hash)).ok).toBe(true)
    const rows = await collect(iterate(source, root.hash, { payloads: true, offset: 4990 }))
    expect(rows.map((r) => r.key)).toEqual(ids(5000).slice(4990))
    for (const r of rows) expect(JSON.parse(r.body!).id).toBe(r.key)
  })

  it('merges against stored trees, rewriting only changed leaves', async () => {
    const { blobs, repo } = freshRepo()
    const { root: base } = await buildRecords(repo, 20_000)
    const putsBefore = blobs.puts
    const all = ids(20_000)
    const source = new RepoSource(recordTree, repo)
    const changes = [all[10]!, all[15_000]!].map((id) => ({ key: id, entry: record(id, 1) }))
    const sink = new RepoSink(repo, { bodyOf: bodyOfRecord })
    const merged = await mergeTree(source, sink, base.hash, changes)
    await sink.flush()
    expect(merged.stats.updated).toBe(2)
    expect(blobs.puts - putsBefore).toBeLessThanOrEqual(2 * 2 + 2 * (base.level + 1))
    const diff = await collect(diffTrees(source, base.hash, merged.root!.hash))
    expect(diff.map((d) => d.key)).toEqual([all[10], all[15_000]])
    const changed = await collect(
      iterate(source, merged.root!.hash, { payloads: true, offset: 10 }),
    )
    expect(JSON.parse(changed[0]!.body!).data.v).toBe(1)
  })

  it('writes a large leaf body as several gzip members in one object', async () => {
    const { blobs, repo } = freshRepo()
    const sink = new RepoSink(repo, { bodyOf: bodyOfRecord })
    const b = new TreeBuilder(recordTree, sink, {
      payloadBytes: recordPayloadBytes,
      dropPayload: dropRecordBody,
      spillBytes: 20_000, // tiny, to force several members
    })
    for (const id of ids(3000)) b.addEntry(record(id))
    const root = b.finish().root!
    await sink.flush()
    const body = [...blobs.objects.entries()].find(([k]) => k.startsWith('bodies/'))![1].bytes
    let members = 0
    for (let i = 0; i + 2 < body.length; i++)
      if (body[i] === 0x1f && body[i + 1] === 0x8b && body[i + 2] === 8) members++
    expect(members).toBeGreaterThan(1)
    const rows = await collect(
      iterate(new RepoSource(recordTree, repo), root.hash, { payloads: true }),
    )
    expect(rows.length).toBe(3000)
    expect(rows.every((r) => JSON.parse(r.body!).id === r.key)).toBe(true)
  })

  it('resolves out-of-line records', async () => {
    const { repo } = freshRepo()
    const big = hashRecord('big', 'T', { blob: 'y'.repeat(OUT_OF_LINE_BYTES + 10) })
    const pointer = await repo.putOutOfLine(big.hash, big.canonical)
    const sink = new RepoSink(repo, { bodyOf: bodyOfRecord })
    const b = new TreeBuilder(recordTree, sink)
    b.addEntry(record('a'))
    b.addEntry({ key: 'big', hash: big.hash, size: utf8ByteLength(big.canonical), body: pointer })
    const root = b.finish().root!
    await sink.flush()
    const rows = await collect(
      iterate(new RepoSource(recordTree, repo), root.hash, { payloads: true }),
    )
    expect(rows[1]!.body).toBe(big.canonical)
  })

  it('stores file trees without bodies', async () => {
    const { blobs, repo } = freshRepo()
    const sink = new RepoSink(repo)
    const b = new TreeBuilder(fileTree, sink)
    b.addEntry({ key: 'a'.repeat(64), size: 10 })
    b.addEntry({ key: 'b'.repeat(64), size: 20 })
    const root = b.finish().root!
    await sink.flush()
    expect([...blobs.objects.keys()]).toEqual([keys.node(root.hash)])
    const entries = await collect(iterate(new RepoSource(fileTree, repo), root.hash))
    expect(entries.map((e) => e.size)).toEqual([10, 20])
  })

  it('verifies bodies from untrusted locations, and never caches a bad one', async () => {
    const { blobs, repo } = freshRepo()
    const { root } = await buildRecords(repo, 300)
    // Tamper with one record in the stored body.
    const bodyKey = [...blobs.objects.keys()].find((k) => k.startsWith('bodies/'))!
    const lines = (
      await new Response(
        new Blob([blobs.objects.get(bodyKey)!.bytes as Uint8Array<ArrayBuffer>])
          .stream()
          .pipeThrough(new DecompressionStream('gzip')),
      ).text()
    ).split('\n')
    lines[5] = lines[5]!.replace('"v":0', '"v":9')
    blobs.objects.set(bodyKey, { bytes: await gzip(lines.join('\n')), contentType: null })

    const untrusted = new Repo(blobs, {
      scope: 'mirror',
      trusted: false,
      lru: new Lru(8 << 20, () => 1024),
    })
    await expect(
      collect(iterate(new RepoSource(recordTree, untrusted), root.hash, { payloads: true })),
    ).rejects.toThrow(IntegrityError)
  })

  it('keeps each location under its prefix', async () => {
    const shared = new MemoryBlobStore()
    const repo = new Repo(new PrefixedBlobStore(shared, 'underlay/v2'), {
      scope: 'p',
      trusted: true,
    })
    await repo.putSchema({ type: 'object' })
    expect([...shared.objects.keys()][0]).toMatch(/^underlay\/v2\/schemas\/[0-9a-f]{64}\.json$/)
  })
})
