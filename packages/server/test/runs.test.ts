import { compareUtf8, MemoryBlobStore, sha256Hex } from '@underlay/protocol'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  compactRuns,
  inRunRange,
  isMark,
  mergeRuns,
  readRun,
  type RunEntry,
  type RunIndex,
  runMarks,
  RunWriter,
  writeRun,
} from '../src/push/runs.js'

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of it) out.push(x)
  return out
}

/** A store that counts reads and the bytes they return. */
class CountingStore extends MemoryBlobStore {
  gets = 0
  bytes = 0
  override async get(key: string, range?: { offset: number; length?: number }) {
    const obj = await super.get(key, range)
    if (obj && !key.endsWith('index.json')) {
      this.gets++
      this.bytes += range?.length ?? 0
    }
    return obj
  }
}

const key = (e: { t: string; k: string }) => `${e.t}\u0000${e.k}`

describe('sorted runs', () => {
  it('writes blocks into parts, reads them back in order, and filters by type', async () => {
    const store = new MemoryBlobStore()
    const entries: RunEntry[] = []
    // Hex bodies barely compress, so this spans several 4 MB parts.
    for (let i = 0; i < 12_000; i++)
      entries.push({
        t: i % 2 ? 'B' : 'A',
        k: `id${i}`,
        b: Array.from({ length: 16 }, (_, j) => sha256Hex(`${i}.${j}`)).join(''),
      })
    const ix = await writeRun(store, 's', 1, entries)
    expect(ix.blocks.length).toBeGreaterThan(50)
    expect(new Set(ix.blocks.map((b) => b.part)).size).toBeGreaterThan(1)
    const all = await collect(readRun(store, 's', ix))
    expect(all.length).toBe(12_000)
    expect(all.slice(0, 6000).every((e) => e.t === 'A')).toBe(true)
    const onlyB = await collect(readRun(store, 's', ix, 'B'))
    expect(onlyB.length).toBe(6000)
    expect(onlyB.every((e) => e.t === 'B')).toBe(true)
  })

  it('refuses out-of-order writes', () => {
    const w = new RunWriter(new MemoryBlobStore(), 's', 1)
    w.add({ t: 'A', k: 'b' })
    expect(() => w.add({ t: 'A', k: 'a' })).toThrow(/out of order/)
  })

  it('reads a key range by fetching only the blocks that overlap it', async () => {
    const store = new CountingStore()
    const ids = Array.from({ length: 40_000 }, (_, i) => `r${String(i).padStart(6, '0')}`)
    const entries = ids.map((k) => ({ t: 'T', k, h: sha256Hex(k) }))
    const ix = await writeRun(store, 's', 1, entries)
    const total = ix.blocks.reduce((n, b) => n + b.length, 0)
    const range = { type: 'T', after: ids[20_000]!, through: ids[20_999]! }
    store.gets = 0
    store.bytes = 0
    const got = await collect(readRun(store, 's', ix, range))
    expect(got.map((e) => e.k)).toEqual(ids.slice(20_001, 21_000))
    expect(store.bytes).toBeLessThan(total / 10)
    // A range in another type reads nothing.
    store.gets = 0
    expect(await collect(readRun(store, 's', ix, { type: 'U' }))).toEqual([])
    expect(store.gets).toBe(0)
  })

  it('marks exactly the upserts whose id is a split-key candidate', async () => {
    const store = new MemoryBlobStore()
    const entries: RunEntry[] = Array.from({ length: 60_000 }, (_, i) => ({
      t: 'T',
      k: `id${i}`,
      ...(i % 3 === 0 ? { x: true } : { h: 'h' }),
    }))
    const ix = await writeRun(store, 's', 1, entries)
    const want = entries
      .filter((e) => !e.x && isMark(e.k))
      .map(key)
      .sort(compareUtf8)
    expect(want.length).toBeGreaterThan(0)
    expect(runMarks([ix])).toEqual(want)
    const after = want[0]!.split('\u0000')[1]!
    expect(runMarks([ix], { type: 'T', after })).toEqual(want.slice(1))
  })

  it('merges any grouping of compactions, later uploads winning (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.array(fc.tuple(fc.constantFrom('A', 'B', 'C'), fc.integer({ min: 0, max: 60 })), {
            maxLength: 30,
          }),
          { minLength: 1, maxLength: 40, size: 'max' },
        ),
        fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 20 }),
        fc.tuple(fc.integer({ min: -1, max: 61 }), fc.integer({ min: -1, max: 61 })),
        async (batches, picks, [a, b]) => {
          const store = new MemoryBlobStore()
          const want = new Map<string, number>()
          let runs: RunIndex[] = []
          for (let seq = 1; seq <= batches.length; seq++) {
            const entries = batches[seq - 1]!.map(([t, k]) => ({ t, k: `k${k}`, s: seq }))
            for (const e of entries) want.set(key(e), seq)
            runs.push(await writeRun(store, 's', seq, entries))
          }
          // Compact arbitrary, non-adjacent groups of runs, repeatedly.
          let seq = batches.length + 1
          for (const p of picks) {
            if (runs.length < 2) break
            const group = runs.filter((_, i) => (p >> (i % 10)) & 1 || i === p % runs.length)
            if (group.length < 2) continue
            const merged = await compactRuns(store, 's', group, seq++, 1)
            runs = [...runs.filter((r) => !group.includes(r)), merged]
          }
          const merged = await collect(mergeRuns(store, 's', runs))
          const got = new Map(merged.map((e) => [key(e), e.s]))
          expect(got).toEqual(want)
          const keys = merged.map(key)
          expect(keys).toEqual([...keys].sort(compareUtf8))
          // A range read of the merge agrees with filtering the whole merge.
          const fmt = (n: number) => (n < 0 ? null : `k${n}`)
          const range = { type: 'B', after: fmt(a), through: fmt(b) }
          const ranged = await collect(mergeRuns(store, 's', runs, range))
          expect(ranged.map(key)).toEqual(merged.filter((e) => inRunRange(range, e)).map(key))
        },
      ),
      { numRuns: 60 },
    )
  })

  it('merges hundreds of runs with a heap', async () => {
    const store = new MemoryBlobStore()
    const runs: RunIndex[] = []
    const want = new Map<string, number>()
    for (let seq = 1; seq <= 300; seq++) {
      const entries = Array.from({ length: 50 }, (_, i) => {
        const k = `k${(seq * 7919 + i * 104_729) % 5000}`
        return { t: 'T', k, s: seq }
      })
      for (const e of entries) want.set(e.k, seq)
      runs.push(await writeRun(store, 's', seq, entries))
    }
    const merged = await collect(mergeRuns(store, 's', runs))
    expect(new Map(merged.map((e) => [e.k, e.s]))).toEqual(want)
  })
})
