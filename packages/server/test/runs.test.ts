import { MemoryBlobStore } from '@underlay/repo/blob/memory'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  compactRuns,
  MERGE_FAN_IN,
  mergeRuns,
  readRun,
  type RunEntry,
  RunWriter,
  writeRun,
} from '../src/push/runs.js'

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of it) out.push(x)
  return out
}

describe('sorted runs', () => {
  it('writes blocks, reads them back in order, and filters by type', async () => {
    const store = new MemoryBlobStore()
    const entries: RunEntry[] = []
    for (let i = 0; i < 5000; i++)
      entries.push({ t: i % 2 ? 'B' : 'A', k: `id${i}`, b: 'x'.repeat(500) })
    const ix = await writeRun(store, 's', 1, entries)
    expect(ix.blocks.length).toBeGreaterThan(1)
    const all = await collect(readRun(store, 's', ix))
    expect(all.length).toBe(5000)
    expect(all.slice(0, 2500).every((e) => e.t === 'A')).toBe(true)
    const onlyB = await collect(readRun(store, 's', ix, 'B'))
    expect(onlyB.length).toBe(2500)
    expect(onlyB.every((e) => e.t === 'B')).toBe(true)
  })

  it('refuses out-of-order writes', () => {
    const w = new RunWriter(new MemoryBlobStore(), 's', 1)
    w.add({ t: 'A', k: 'b' })
    expect(() => w.add({ t: 'A', k: 'a' })).toThrow(/out of order/)
  })

  it('merges and compacts any number of runs, later uploads winning (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.array(fc.tuple(fc.constantFrom('A', 'B', 'C'), fc.integer({ min: 0, max: 60 })), {
            maxLength: 30,
          }),
          {
            minLength: 1,
            maxLength: 2 * MERGE_FAN_IN + 5,
          },
        ),
        async (batches) => {
          const store = new MemoryBlobStore()
          const want = new Map<string, number>()
          const indexes = []
          for (let seq = 1; seq <= batches.length; seq++) {
            const entries = batches[seq - 1]!.map(([t, k]) => ({ t, k: `k${k}`, s: seq }))
            for (const e of entries) want.set(`${e.t}\u0000${e.k}`, seq)
            indexes.push(await writeRun(store, 's', seq, entries))
          }
          const compacted = await compactRuns(store, 's', indexes, batches.length + 1)
          expect(compacted.length).toBeLessThanOrEqual(MERGE_FAN_IN)
          const merged = await collect(mergeRuns(store, 's', compacted))
          const got = new Map(merged.map((e) => [`${e.t}\u0000${e.k}`, e.s]))
          expect(got).toEqual(want)
          // Sorted by type, then id.
          const keys = merged.map((e) => `${e.t}\u0000${e.k}`)
          expect(keys).toEqual([...keys].sort())
        },
      ),
      { numRuns: 60 },
    )
  })
})
