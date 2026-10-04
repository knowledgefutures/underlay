import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  assembleTree,
  boundaryBytes,
  buildTree,
  type Change,
  compareUtf8,
  diffTrees,
  entryAt,
  getEntry,
  inRange,
  iterate,
  type KeyRange,
  MapSource,
  MemorySink,
  mergeTree,
  newNodes,
  protocolChunking,
  rankOf,
  type NodeDesc,
  type NodeSource,
  type RecordEntry,
  recordTree,
  type Segment,
  sha256Hex,
  trailingZeros,
  type TreeSink,
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

describe('parallel commit', () => {
  /** Natural leaf boundaries under `tiny`: the keys a planner may split at. */
  const natural = (k: string) => trailingZeros(boundaryBytes(k)) >= 2

  /** Run one unit: a range merge with its leaves collected. */
  const runUnit = async (
    source: NodeSource<RecordEntry>,
    sink: TreeSink<RecordEntry>,
    base: string | null,
    range: KeyRange,
    changes: Change<RecordEntry>[],
  ) => {
    const leaves: NodeDesc[] = []
    const r = await mergeTree(
      source,
      sink,
      base,
      changes.filter((c) => inRange(range, c.key)),
      { chunking: tiny, range, leafOutput: (d) => leaves.push(d) },
    )
    // Every output leaf lies inside the range (the coordinator's fallback would
    // otherwise hide a unit that spills over its edges).
    for (const leaf of leaves) {
      for (const e of await source.leafEntries(leaf.hash)) expect(inRange(range, e.key)).toBe(true)
    }
    return { ...r, leaves, survived: range.through === null || r.lastKey === range.through }
  }

  /**
   * A coordinator in miniature: split at `splits`, leave change-free ranges in
   * `gaps` to assembly, run the rest as units, merge a unit whose `through` was
   * deleted with the next range, then assemble.
   */
  const parallel = async (
    source: NodeSource<RecordEntry>,
    sink: TreeSink<RecordEntry>,
    base: string | null,
    changes: Change<RecordEntry>[],
    splits: string[],
    gap: (i: number) => boolean,
  ) => {
    const bounds = [null, ...splits, null]
    let ranges = bounds.slice(1).map((through, i) => {
      const range = { after: bounds[i]!, through }
      return { ...range, gap: gap(i) && !changes.some((c) => inRange(range, c.key)) }
    })
    for (;;) {
      const segments: Segment[] = []
      const stats = { added: 0, removed: 0, updated: 0, unchanged: 0, missingDeletes: 0 }
      let failed = -1
      for (let i = 0; i < ranges.length && failed < 0; i++) {
        const r = ranges[i]!
        if (r.gap) continue
        const unit = await runUnit(source, sink, base, r, changes)
        if (!unit.survived) {
          // Only a deleted split key may fail a unit.
          expect(changes.some((c) => c.key === r.through && c.entry === null)).toBe(true)
          failed = i
        }
        segments.push({ after: r.after, through: r.through, leaves: unit.leaves })
        for (const k of Object.keys(stats) as (keyof typeof stats)[]) stats[k] += unit.stats[k]
      }
      if (failed >= 0) {
        const [a, b] = [ranges[failed]!, ranges[failed + 1]!]
        ranges = [
          ...ranges.slice(0, failed),
          { after: a.after, through: b.through, gap: false },
          ...ranges.slice(failed + 2),
        ]
        continue
      }
      const assembled = await assembleTree(source, sink, base, segments, { chunking: tiny })
      return { root: assembled.root, stats, assembly: assembled.stats, units: segments.length }
    }
  }

  // fast-check keeps arrays near ten elements unless told otherwise; units and
  // straddled leaves need trees several levels deep.
  const bigKeySet = fc.uniqueArray(keyArb, { maxLength: 400, size: 'max' })
  const changeArb = (pool: string[]) =>
    fc.uniqueArray(
      fc.record({
        key: pool.length > 0 ? fc.oneof(fc.constantFrom(...pool), keyArb) : keyArb,
        del: fc.boolean(),
        v: fc.integer({ min: 0, max: 3 }),
      }),
      { selector: (c) => c.key, maxLength: 80, size: 'large' },
    )

  it(
    'units plus assembly equal the serial merge (property)',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          bigKeySet.chain((keys) => fc.tuple(fc.constant(keys), changeArb(keys))),
          fc.array(fc.boolean(), { minLength: 1, maxLength: 16 }),
          fc.array(fc.boolean(), { minLength: 1, maxLength: 16 }),
          async ([keys, raw], pick, gaps) => {
            const { sink, source } = store()
            const baseRoot =
              buildTree(recordTree, sink, sorted(keys.map((k) => entry(k))), { chunking: tiny })
                ?.hash ?? null
            const changes = raw
              .map((c) => ({ key: c.key, entry: c.del ? null : entry(c.key, c.v) }))
              .sort((a, b) => compareUtf8(a.key, b.key))
            // Candidates as a planner sees them: natural keys of the base and of the
            // upserts. Some may be deleted by the changes; units must catch that.
            const upserts = changes.filter((c) => c.entry).map((c) => c.key)
            const candidates = [...new Set([...keys, ...upserts])].filter(natural).sort(compareUtf8)
            const splits = candidates.filter((_, i) => pick[i % pick.length])
            const serial = await mergeTree(source, sink, baseRoot, changes, { chunking: tiny })
            const par = await parallel(
              source,
              sink,
              baseRoot,
              changes,
              splits,
              (i) => gaps[i % gaps.length]!,
            )
            expect(par.root?.hash ?? null).toBe(serial.root?.hash ?? null)
            expect(par.root?.count ?? 0).toBe(serial.root?.count ?? 0)
            expect(par.root?.bytes ?? 0).toBe(serial.root?.bytes ?? 0)
            const { added, removed, updated, unchanged, missingDeletes } = serial.stats
            expect(par.stats).toEqual({ added, removed, updated, unchanged, missingDeletes })
            if (par.root) {
              const v = await verifyTree(source, par.root.hash, { chunking: tiny })
              expect(v.errors).toEqual([])
            }
          },
        ),
        { numRuns: 300 * RUNS },
      )
    },
    20_000 * RUNS,
  )

  it('appends past the end of the base in their own unit', async () => {
    // A split at the base's last key with records appended after it: assembly
    // must not reuse the base's right-edge nodes whole.
    for (let n = 20; n < 400; n += 13) {
      const { sink, source } = store()
      const keys = Array.from({ length: n }, (_, i) => `k${String(i).padStart(4, '0')}`)
      const last = keys.filter(natural).at(-1)!
      const base = sorted(keys.filter((k) => compareUtf8(k, last) <= 0).map((k) => entry(k)))
      const root = buildTree(recordTree, sink, base, { chunking: tiny })!.hash
      const changes = keys
        .filter((k) => compareUtf8(k, last) > 0)
        .map((k) => ({ key: k, entry: entry(k) }))
      if (changes.length === 0) continue
      const serial = await mergeTree(source, sink, root, changes, { chunking: tiny })
      const par = await parallel(source, sink, root, changes, [last], (i) => i === 0)
      expect(par.root?.hash).toBe(serial.root?.hash)
    }
  })

  it('a unit reports a deleted through', async () => {
    const { sink, source } = store()
    const es = sorted(Array.from({ length: 300 }, (_, i) => entry(`k${i}`)))
    const root = buildTree(recordTree, sink, es, { chunking: tiny })!.hash
    const splits = es.map((e) => e.key).filter(natural)
    const [after, through, next] = [splits[3]!, splits[4]!, splits[5]!]
    const changes = [{ key: through, entry: null }]
    const unit = await runUnit(source, sink, root, { after, through }, changes)
    expect(unit.survived).toBe(false)
    expect(unit.lastKey).not.toBe(through)
    expect(unit.stats.removed).toBe(1)
    const pair = await runUnit(source, sink, root, { after, through: next }, changes)
    expect(pair.survived).toBe(true)
  })

  it('refuses a change outside the unit range', async () => {
    const { sink, source } = store()
    const range = { after: 'b', through: 'd' }
    await expect(
      mergeTree(source, sink, null, [{ key: 'e', entry: entry('e') }], {
        chunking: tiny,
        range,
        leafOutput: () => {},
      }),
    ).rejects.toThrow(/outside/)
  })

  it('assembly reads O(segments) nodes in a large tree', async () => {
    const { sink, source } = store()
    const es = sorted(
      Array.from({ length: 200_000 }, (_, i) => entry(`id${String(i).padStart(7, '0')}`)),
    )
    const root = buildTree(recordTree, sink, es, { chunking: protocolChunking })!
    const isNatural = (k: string) => trailingZeros(boundaryBytes(k)) >= 10
    const nat = es.map((e) => e.key).filter(isNatural)
    // Three units, each a few leaves wide, with one update in each.
    const segments: Segment[] = []
    const changes: Change<RecordEntry>[] = []
    for (const at of [10, 80, 150]) {
      const range = { after: nat[at]!, through: nat[at + 3]! }
      const target = es.find((e) => compareUtf8(e.key, nat[at + 1]!) > 0)!
      const unitChanges = [{ key: target.key, entry: entry(target.key, 9) }]
      changes.push(...unitChanges)
      const leaves: NodeDesc[] = []
      await mergeTree(source, sink, root.hash, unitChanges, {
        range,
        leafOutput: (d) => leaves.push(d),
      })
      segments.push({ ...range, leaves })
    }
    const assembled = await assembleTree(source, sink, root.hash, segments)
    const serial = await mergeTree(source, sink, root.hash, changes)
    expect(assembled.root?.hash).toBe(serial.root?.hash)
    // A path per segment, plus the root.
    expect(assembled.stats.readNodes).toBeLessThanOrEqual(3 * (root.level + 2) + 1)
  })
})

describe('newNodes', () => {
  it('lists exactly the nodes of b that a lacks, parents first (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(keyArb, { maxLength: 400, size: 'max' }),
        fc.array(fc.tuple(fc.nat(), fc.boolean(), fc.integer({ min: 1, max: 3 })), {
          maxLength: 60,
        }),
        async (keys, edits) => {
          const { sink, source } = store()
          const base = sorted(keys.map((k) => entry(k)))
          const a = buildTree(recordTree, sink, base, { chunking: tiny })?.hash ?? null
          const changes = new Map<string, Change<RecordEntry>>()
          for (const [i, del, v] of edits) {
            const k = keys.length > 0 && i % 3 !== 0 ? keys[i % keys.length]! : `new${i}`
            changes.set(k, { key: k, entry: del ? null : entry(k, v) })
          }
          const merged = await mergeTree(
            source,
            sink,
            a,
            [...changes.values()].sort((x, y) => compareUtf8(x.key, y.key)),
            { chunking: tiny },
          )
          const b = merged.root?.hash ?? null
          const all = async (root: string | null) => {
            const out = new Set<string>()
            const walk = async (h: string) => {
              out.add(h)
              const n = await source.node(h)
              if (n.kind === 'node') for (const c of n.children) await walk(c.hash)
            }
            if (root) await walk(root)
            return out
          }
          const inA = await all(a)
          const inB = await all(b)
          const listed: string[] = []
          const seen = new Set<string>()
          for await (const n of newNodes(source, a, b)) {
            listed.push(n.hash)
            seen.add(n.hash)
            // Parents first: a listed node's children come later, never earlier.
            const node = await source.node(n.hash)
            if (node.kind === 'node')
              for (const c of node.children) expect(seen.has(c.hash)).toBe(false)
          }
          // Everything b needs that a lacks is listed, and nothing outside b.
          for (const h of inB) if (!inA.has(h)) expect(seen.has(h)).toBe(true)
          for (const h of listed) expect(inB.has(h)).toBe(true)
        },
      ),
      { numRuns: 200 * RUNS },
    )
  })
})

describe('newNodes resumed', () => {
  it('stopping after any leaf and resuming still lists everything (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(keyArb, { maxLength: 300, size: 'max' }),
        fc.array(fc.tuple(fc.nat(), fc.boolean()), { maxLength: 60 }),
        fc.nat(),
        async (keys, edits, pick) => {
          const { sink, source } = store()
          const a =
            buildTree(recordTree, sink, sorted(keys.map((k) => entry(k))), { chunking: tiny })
              ?.hash ?? null
          const changes = new Map<string, Change<RecordEntry>>()
          for (const [i, del] of edits) {
            const k = keys.length > 0 && i % 3 !== 0 ? keys[i % keys.length]! : `new${i}`
            changes.set(k, { key: k, entry: del ? null : entry(k, 1) })
          }
          const b =
            (
              await mergeTree(
                source,
                sink,
                a,
                [...changes.values()].sort((x, y) => compareUtf8(x.key, y.key)),
                { chunking: tiny },
              )
            ).root?.hash ?? null
          const full: { hash: string; level: number; lastKey: string }[] = []
          for await (const n of newNodes(source, a, b)) full.push(n)
          const leaves = full.filter((n) => n.level === 0)
          if (leaves.length === 0) return
          const stop = leaves[pick % leaves.length]!
          const cut = full.indexOf(stop) + 1
          const rest: string[] = []
          for await (const n of newNodes(source, a, b, { after: stop.lastKey })) rest.push(n.hash)
          // Together the two halves list everything b has that a lacks, and nothing
          // outside b. (The resumed half can be leaner: it may match a base node the
          // full walk re-sent because the tree changed height.)
          const all = async (root: string | null) => {
            const out = new Set<string>()
            const walk = async (h: string) => {
              out.add(h)
              const n = await source.node(h)
              if (n.kind === 'node') for (const c of n.children) await walk(c.hash)
            }
            if (root) await walk(root)
            return out
          }
          const inA = await all(a)
          const inB = await all(b)
          const sent = new Set([...full.slice(0, cut).map((n) => n.hash), ...rest])
          for (const h of inB) if (!inA.has(h)) expect(sent.has(h)).toBe(true)
          for (const h of sent) expect(inB.has(h)).toBe(true)
        },
      ),
      { numRuns: 300 * RUNS },
    )
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

describe('rank and offset seeks', () => {
  it('rankOf and entryAt agree with the sorted entries (property)', async () => {
    await fc.assert(
      fc.asyncProperty(keySet(300), keyArb, fc.nat(), async (keys, probe, at) => {
        const { sink, source } = store()
        const es = sorted(keys.map((k) => entry(k)))
        const root = buildTree(recordTree, sink, es, { chunking: tiny })?.hash ?? null
        const want = es.filter((e) => compareUtf8(e.key, probe) < 0).length
        expect(await rankOf(source, root, probe)).toBe(want)
        const i = es.length === 0 ? 0 : at % (es.length + 1)
        expect((await entryAt(source, root, i))?.key ?? null).toBe(es[i]?.key ?? null)
      }),
      { numRuns: 200 * RUNS },
    )
  })
})
