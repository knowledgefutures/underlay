import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  buildTree,
  type Change,
  compareUtf8,
  diffTrees,
  getEntry,
  iterate,
  MapSource,
  MemorySink,
  mergeTree,
  protocolChunking,
  type RecordEntry,
  recordTree,
  sha256Hex,
  verifyTree,
} from '../src/index.js'
import { fixedChunking as fixed } from '../src/tree/chunking.js'

// Tiny nodes so a few hundred entries make deep trees with forced splits:
// mean leaf 4 entries (forced at 8), mean fanout 2 (forced at 4).
const RUNS = Number(process.env.PROPERTY_RUNS ?? 1)
const tiny = fixed({ leafBits: 2, stepBits: 1, leafMax: 8, interiorMax: 4 }, 'tiny')

const entry = (key: string, v = 0): RecordEntry => ({
  key,
  hash: sha256Hex(`${key}#${v}`),
  size: key.length + v,
})

const sorted = (es: RecordEntry[]) => es.slice().sort((a, b) => compareUtf8(a.key, b.key))

/** A store shared across builds, the way R2 is shared across versions. */
function store() {
  const sink = new MemorySink<RecordEntry>()
  const source = new MapSource(recordTree, sink.nodes, sink.leaves)
  return { sink, source }
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of it) out.push(x)
  return out
}

const keyArb = fc.string({ unit: 'grapheme-ascii', minLength: 1, maxLength: 6 })
const keySet = (max: number) => fc.uniqueArray(keyArb, { maxLength: max })

describe('build', () => {
  it('gives an empty tree a null root and one leaf as its own root', () => {
    const { sink } = store()
    expect(buildTree(recordTree, sink, [])).toBe(null)
    const root = buildTree(recordTree, sink, [entry('a'), entry('b')])!
    expect(root.level).toBe(0)
    expect(root.count).toBe(2)
  })

  it('builds deep trees that verify, with counts and bytes summed', async () => {
    const { sink, source } = store()
    const es = sorted(Array.from({ length: 2000 }, (_, i) => entry(`k${i}`, i % 7)))
    const root = buildTree(recordTree, sink, es, { chunking: tiny })!
    expect(root.level).toBeGreaterThan(3)
    expect(root.count).toBe(2000)
    expect(root.bytes).toBe(es.reduce((s, e) => s + e.size, 0))
    const v = await verifyTree(source, root.hash, { chunking: tiny })
    expect(v.errors).toEqual([])
    expect(v.count).toBe(2000)
  })

  it('refuses keys out of order', () => {
    const { sink } = store()
    expect(() => buildTree(recordTree, sink, [entry('b'), entry('a')])).toThrow(/out of order/)
    expect(() => buildTree(recordTree, sink, [entry('a'), entry('a')])).toThrow(/out of order/)
  })

  it('verify rejects a tree built under different chunking', async () => {
    const { sink, source } = store()
    const es = sorted(Array.from({ length: 300 }, (_, i) => entry(`k${i}`)))
    const root = buildTree(recordTree, sink, es, { chunking: tiny })!
    const v = await verifyTree(source, root.hash, { chunking: protocolChunking })
    expect(v.ok).toBe(false)
    expect(v.errors.join()).toMatch(/not canonical/)
  })
})

describe('merge', () => {
  /** Apply changes to a key→entry map: the expected result of a merge. */
  const apply = (base: Map<string, RecordEntry>, changes: Change<RecordEntry>[]) => {
    const m = new Map(base)
    for (const c of changes) {
      if (c.entry) m.set(c.key, c.entry)
      else m.delete(c.key)
    }
    return sorted([...m.values()])
  }

  const changeArb = (pool: string[]) =>
    fc.uniqueArray(
      fc.record({
        key: pool.length > 0 ? fc.oneof(fc.constantFrom(...pool), keyArb) : keyArb,
        del: fc.boolean(),
        v: fc.integer({ min: 0, max: 3 }),
      }),
      { selector: (c) => c.key, maxLength: 80 },
    )

  it('an incremental merge equals a full rebuild (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        keySet(400).chain((keys) => fc.tuple(fc.constant(keys), changeArb(keys))),
        async ([keys, raw]) => {
          const { sink, source } = store()
          const base = sorted(keys.map((k) => entry(k)))
          const baseRoot = buildTree(recordTree, sink, base, { chunking: tiny })
          const changes = raw
            .map((c) => ({ key: c.key, entry: c.del ? null : entry(c.key, c.v) }))
            .sort((a, b) => compareUtf8(a.key, b.key))
          const merged = await mergeTree(source, sink, baseRoot?.hash ?? null, changes, {
            chunking: tiny,
          })
          const want = buildTree(
            recordTree,
            new MemorySink(),
            apply(new Map(base.map((e) => [e.key, e])), changes),
            {
              chunking: tiny,
            },
          )
          expect(merged.root?.hash ?? null).toBe(want?.hash ?? null)
          expect(merged.root?.count ?? 0).toBe(want?.count ?? 0)
          if (merged.root) {
            const v = await verifyTree(source, merged.root.hash, { chunking: tiny })
            expect(v.errors).toEqual([])
          }
        },
      ),
      { numRuns: 300 * RUNS },
    )
  })

  it('random insertion orders converge on one root (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        keySet(300),
        fc.integer({ min: 1, max: 6 }),
        fc.integer(),
        async (keys, parts, seed) => {
          const { sink, source } = store()
          // Split the keys into `parts` batches pseudo-randomly and merge them in one by one.
          const batches: string[][] = Array.from({ length: parts }, () => [])
          keys.forEach((k, i) => batches[Math.abs((seed ^ (i * 2654435761)) % parts)]!.push(k))
          let root: string | null = null
          for (const b of batches) {
            const changes = b
              .map((k) => ({ key: k, entry: entry(k) }))
              .sort((x, y) => compareUtf8(x.key, y.key))
            root =
              (await mergeTree(source, sink, root, changes, { chunking: tiny })).root?.hash ?? null
          }
          const want = buildTree(recordTree, new MemorySink(), sorted(keys.map((k) => entry(k))), {
            chunking: tiny,
          })
          expect(root).toBe(want?.hash ?? null)
        },
      ),
      { numRuns: 200 * RUNS },
    )
  })

  it('deleting everything gives null; a no-op merge returns the base', async () => {
    const { sink, source } = store()
    const es = sorted(Array.from({ length: 200 }, (_, i) => entry(`k${i}`)))
    const root = buildTree(recordTree, sink, es, { chunking: tiny })!
    const none = await mergeTree(source, sink, root.hash, [], { chunking: tiny })
    expect(none.root?.hash).toBe(root.hash)
    const same = await mergeTree(
      source,
      sink,
      root.hash,
      es.slice(0, 50).map((e) => ({ key: e.key, entry: e })),
      {
        chunking: tiny,
      },
    )
    expect(same.root?.hash).toBe(root.hash)
    expect(same.stats.unchanged).toBe(50)
    const all = await mergeTree(
      source,
      sink,
      root.hash,
      es.map((e) => ({ key: e.key, entry: null })),
      {
        chunking: tiny,
      },
    )
    expect(all.root).toBe(null)
    expect(all.stats.removed).toBe(200)
  })

  it('collapses to a reused single-child subtree correctly', async () => {
    // Keep only the keys under one base subtree; the new root must be found by
    // walking down single-child chains inside reused nodes.
    for (let n = 50; n < 400; n += 37) {
      const { sink, source } = store()
      const es = sorted(Array.from({ length: n }, (_, i) => entry(`k${i}`)))
      const root = buildTree(recordTree, sink, es, { chunking: tiny })!
      for (const keep of [1, 3, 10, n >> 1]) {
        const drop = es.slice(keep).map((e) => ({ key: e.key, entry: null }))
        const merged = await mergeTree(source, sink, root.hash, drop, { chunking: tiny })
        const want = buildTree(recordTree, new MemorySink(), es.slice(0, keep), { chunking: tiny })
        expect(merged.root?.hash).toBe(want?.hash)
      }
    }
  })

  it('costs O(changes): one update in a large tree reads one path', async () => {
    const { sink, source } = store()
    const es = sorted(
      Array.from({ length: 200_000 }, (_, i) => entry(`id${String(i).padStart(7, '0')}`)),
    )
    const root = buildTree(recordTree, sink, es, { chunking: protocolChunking })!
    expect(root.level).toBeGreaterThanOrEqual(1)
    const target = es[123_456]!
    let written = 0
    const counting = {
      leaf: (...a: Parameters<typeof sink.leaf>) => {
        written++
        sink.leaf(...a)
      },
      interior: (...a: Parameters<typeof sink.interior>) => {
        written++
        sink.interior(...a)
      },
    }
    const merged = await mergeTree(source, counting, root.hash, [
      { key: target.key, entry: entry(target.key, 9) },
    ])
    expect(merged.stats.updated).toBe(1)
    // Root, maybe one interior level, one leaf (plus at most a neighbour to re-align).
    expect(merged.stats.readNodes).toBeLessThanOrEqual(2 * (root.level + 1) + 1)
    expect(written).toBeLessThanOrEqual(2 * (root.level + 1))
    expect(merged.stats.reusedNodes).toBeGreaterThan(0)
  })

  it('reports changes in key order through onChange', async () => {
    const { sink, source } = store()
    const root = buildTree(recordTree, sink, sorted(['a', 'b', 'c'].map((k) => entry(k))), {
      chunking: tiny,
    })!
    const seen: string[] = []
    await mergeTree(
      source,
      sink,
      root.hash,
      [
        { key: 'a', entry: null },
        { key: 'b', entry: entry('b', 1) },
        { key: 'c', entry: entry('c') },
        { key: 'd', entry: entry('d') },
        { key: 'e', entry: null },
      ],
      {
        chunking: tiny,
        onChange: (before, after) => seen.push(`${before?.key ?? '-'}>${after?.key ?? '-'}`),
      },
    )
    expect(seen).toEqual(['a>-', 'b>b', '->d'])
  })
})

describe('read', () => {
  it('looks up, iterates from a key or an offset, and diffs (property)', async () => {
    await fc.assert(
      fc.asyncProperty(keySet(300), fc.nat(), fc.nat(), async (keys, at, edits) => {
        const { sink, source } = store()
        const es = sorted(keys.map((k) => entry(k)))
        const root = buildTree(recordTree, sink, es, { chunking: tiny })?.hash ?? null
        // Point lookups.
        for (const e of es.slice(0, 20))
          expect((await getEntry(source, root, e.key))?.hash).toBe(e.hash)
        expect(await getEntry(source, root, '\u{10FFFF}missing')).toBe(null)
        // Offset and keyset pagination agree with the sorted array.
        const offset = es.length === 0 ? 0 : at % (es.length + 1)
        const fromOffset = await collect(iterate(source, root, { offset, prefetch: 3 }))
        expect(fromOffset.map((e) => e.key)).toEqual(es.slice(offset).map((e) => e.key))
        if (offset > 0) {
          const after = es[offset - 1]!.key
          const fromKey = await collect(iterate(source, root, { after }))
          expect(fromKey.map((e) => e.key)).toEqual(es.slice(offset).map((e) => e.key))
        }
        // Diff against an edited copy reports exactly the edits.
        const changes: Change<RecordEntry>[] = []
        es.forEach((e, i) => {
          if ((i * 7 + edits) % 11 === 0) changes.push({ key: e.key, entry: null })
          else if ((i * 5 + edits) % 13 === 0) changes.push({ key: e.key, entry: entry(e.key, 1) })
        })
        const merged = await mergeTree(source, sink, root, changes, { chunking: tiny })
        const diff = await collect(diffTrees(source, root, merged.root?.hash ?? null))
        expect(diff.map((d) => `${d.key}:${d.before ? 1 : 0}${d.after ? 1 : 0}`)).toEqual(
          changes.map((c) => `${c.key}:1${c.entry ? 1 : 0}`),
        )
      }),
      { numRuns: 200 * RUNS },
    )
  })
})
