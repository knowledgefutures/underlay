/**
 * Layout F's index pieces (repo/layouts): a layer's Bloom
 * filter holds every key it was built from, and a lookup through the filters
 * finds exactly what a range read of the same keys finds, newest layer winning.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  buildTree,
  decodeNode,
  describeNode,
  encodeLeaf,
  gunzipText,
  hashNode,
  headConfig,
  HomeStore,
  IntegrityError,
  KeyedLayout,
  layoutConfig,
  LiveHashes,
  MapSource,
  MemorySink,
  memoryStore,
  type MergePlan,
  mergeTree,
  type NodeSource,
  openRepo,
  type RecordEntry,
  recordCanonical,
  RECLAIM_MAX_RUNS,
  recordIdKey,
  RepoSink,
  recordTree,
  sha256Hex,
  type Store,
  TooManyRunsError,
  treeObjects,
  UPLOAD_PACK_FINAL_RAW,
  utf8ByteLength,
} from '../../src/index.js'
import {
  buildFilter,
  filterHas,
  LayerReader,
  levelFor,
  LayeredIndex,
  ManifestStore,
  MERGE_READ_BUDGET,
  mergeRead,
  pendingConfig,
  runs,
  RunWriter,
} from '../../src/repo/layouts/kit.js'
import { repoLru } from '../../src/repo/repo.js'

// F's manifest head is written at most once a second: tests wait a fortieth of that.
beforeEach(() => {
  headConfig.intervalMs = 25
})
afterEach(() => {
  headConfig.intervalMs = 1000
})

/** A collection's layout F over `store`: its files under `runs/<home>/`. */
const fLayout = (store: Store = memoryStore(), home = 'c1', scope = 's') =>
  new KeyedLayout(new HomeStore(store, home), repoLru(8 << 20), scope)

const ids = Array.from(
  { length: 20_000 },
  (_, i) => `10.${1000 + (i % 50)}/x${String(i).padStart(6, '0')}`,
).sort()

describe('layer filters', () => {
  it('hold every key they were built from', () => {
    const keys = ids.slice(0, 12_000)
    const f = buildFilter(new Set(keys), keys.length)
    expect(keys.filter((k) => !filterHas(f, k))).toEqual([])
  })

  it('reject most keys they were not built from', () => {
    const f = buildFilter(new Set(ids.slice(0, 10_000)), 10_000)
    const false_ = ids.slice(10_000).filter((k) => filterHas(f, k)).length
    expect(false_ / 10_000).toBeLessThan(0.03)
  })
})

describe('reclaim a key range at a time', () => {
  // Small lines make packs merges still take (listed in the manifest); big ones make
  // packs no merge takes (listed in the registry instead).
  const noise = (i: number) => {
    let x = (i + 1) * 2_654_435_761
    let out = ''
    for (let j = 0; j < 400; j++) {
      x = (x * 1_103_515_245 + 12_345) % 2_147_483_648
      out += x.toString(36)
    }
    return out
  }
  it.each([
    ['small packs', false],
    ['registry packs', true],
  ])('keeps exactly the live records, rewriting mostly-dead packs (%s)', async (_, big) => {
    const layout = fLayout()
    const n = 3_000
    const entry = (i: number, v: number) => ({ key: ids[i]!, hash: `h${v}.${i}`, size: 10 })
    const line = (i: number, v: number) => `line ${v}.${i}${big ? ` ${noise(i * 7 + v)}` : ''}`
    const write = async (from: number, to: number, v: number) => {
      const w = layout.writer()
      for (let i = from; i < to; i++) w.add('T', entry(i, v), line(i, v))
      await w.finish()
    }
    await write(0, n, 1)
    // Most of the first write's records change: its packs become mostly dead.
    await write(0, 2_000, 2)
    const listed = (await layout.manifests.latest()).packs.length
    const registered = (await layout.registry.read()).packs.length
    if (big) expect(registered).toBeGreaterThan(0)
    else expect(registered).toBe(0)
    expect(listed + registered).toBe((await layout.allPacks()).length)

    const live = new LiveHashes()
    const want = Array.from({ length: n }, (_, i) => entry(i, i < 2_000 ? 2 : 1))
    for (const e of want) live.add(recordIdKey('T', e.key), e.hash)
    expect(live.has(recordIdKey('T', want[0]!.key), 'h1.0')).toBe(false)
    expect(live.has(recordIdKey('T', want[0]!.key), want[0]!.hash)).toBe(true)

    const plan = await layout.reclaimPlan(500)
    expect(plan.ranges.length).toBeGreaterThan(3)
    const done = []
    for (let i = 0; i < plan.ranges.length; i++) done.push(await layout.reclaimRange(plan, i, live))
    expect(done.at(-1)).toBe(true)
    expect(done.slice(0, -1).every((d) => !d)).toBe(true)
    const swapped = await layout.reclaimSwap(plan)
    expect(swapped?.stats.entriesKept).toBe(n)
    expect(swapped?.stats.entriesDropped).toBe(2_000)
    expect(swapped!.rewrite.length).toBeGreaterThan(0)
    // A second caller doesn't swap again.
    expect(await layout.reclaimSwap(plan)).toBeNull()
    // Until its rewrite swaps it out, a pack being rewritten is still listed (once): a
    // reclaim planned meanwhile, a fork or a mirror would otherwise lose its records.
    const between = (await layout.allPacks()).map((p) => p.id)
    expect(swapped!.rewrite.filter((id) => !between.includes(id))).toEqual([])
    expect(new Set(between).size).toBe(between.length)
    for (const id of swapped!.rewrite) await layout.reclaimRewrite([id])

    const packs = await layout.allPacks()
    expect(packs.some((p) => swapped!.rewrite.includes(p.id))).toBe(false)
    expect(packs.reduce((s, p) => s + p.records, 0)).toBe(n)
    const lines = await layout.leafLines({ hash: 'leaf', type: 'T', entries: want })
    expect(lines).toEqual(want.map((_, i) => line(i, i < 2_000 ? 2 : 1)))
  })
})

describe('concurrent commits', () => {
  it('are none of them lost, and a merge removes only what it read', async () => {
    const layout = fLayout()
    const entry = (i: number) => ({ key: ids[i]!, hash: `h.${i}`, size: 10 })
    await Promise.all(
      Array.from({ length: 12 }, async (_, k) => {
        const w = layout.writer()
        for (let i = k * 100; i < k * 100 + 100; i++) w.add('T', entry(i), `line ${i}`)
        await w.finish()
      }),
    )
    expect((await layout.manifests.latest()).layers.length).toBe(12)
    await layout.maintain()
    const want = Array.from({ length: 1_200 }, (_, i) => entry(i))
    expect(await layout.leafLines({ hash: 'leaf', type: 'T', entries: want })).toEqual(
      want.map((_, i) => `line ${i}`),
    )
    expect((await layout.manifests.latest()).layers.length).toBeLessThan(12)
  })
})

describe('size-tiered index levels', () => {
  it('merge small commits with each other, leaving a large run alone', async () => {
    const layout = fLayout()
    const entry = (i: number) => ({ key: ids[i]!, hash: `h.${i}`, size: 10 })
    const write = async (from: number, n: number) => {
      const w = layout.writer()
      for (let i = from; i < from + n; i++) w.add('T', entry(i), `line ${i}`)
      await w.finish()
    }
    await write(0, 8_000)
    const big = (await layout.manifests.latest()).layers[0]!
    expect(big.level).toBe(levelFor(8_000))
    for (let k = 0; k < 4; k++) await write(10_000 + k * 5, 5)
    await layout.maintain()
    const m = await layout.manifests.latest()
    // The large run is untouched; the four small ones are one run now.
    expect(m.layers.some((l) => l.id === big.id)).toBe(true)
    expect(m.layers.length).toBe(2)
    const want = [...Array.from({ length: 8_000 }, (_, i) => i), 10_000, 10_019].map(entry)
    expect(await layout.leafLines({ hash: 'leaf', type: 'T', entries: want })).toEqual(
      want.map((e) => `line ${ids.indexOf(e.key)}`),
    )
  })
})

describe('merges keep the newest place of every record', () => {
  // Random commits (new records, and new versions of old ones), each followed by the
  // merges it sets off, with replaced packs deleted at once: every record's newest
  // version must read, whatever merged with what.
  it('through random commits and merges', async () => {
    const saved = layoutConfig.graceMs
    layoutConfig.graceMs = 0
    // The head moves at most this often: still behind the manifests merges write.
    headConfig.intervalMs = 25
    try {
      const layout = fLayout()
      let x = 12_345
      const rand = (n: number) => {
        // xorshift32: exact in 32-bit integers.
        x ^= x << 13
        x ^= x >>> 17
        x ^= x << 5
        return (x >>> 0) % n
      }
      const version = new Map<number, number>()
      const top = new Map<number, number>()
      for (let c = 0; c < 150; c++) {
        // Mostly small commits, now and then a large one.
        const size = rand(10) === 0 ? 400 + rand(800) : 1 + rand(40)
        const touched = new Set<number>()
        while (touched.size < size) touched.add(rand(3_000))
        const w = layout.writer()
        for (const i of [...touched].sort((a, b) => a - b)) {
          // A third of changes go back to an earlier version: the same record, written again.
          const now = version.get(i) ?? 0
          const v = now > 1 && rand(3) === 0 ? 1 + rand(now - 1) : (top.get(i) ?? 0) + 1
          if (v > (top.get(i) ?? 0)) top.set(i, v)
          version.set(i, v)
          w.add('T', { key: ids[i]!, hash: `h${v}.${i}`, size: 10 }, `line ${v}.${i}`)
        }
        await w.finish()
        // Several maintain jobs at once, as many commits' jobs would be: one does the work.
        await Promise.all([layout.maintain(), layout.maintain(), layout.maintain()])
      }
      await layout.maintain()
      // However the commits came, the index stays a bounded number of runs.
      const m = await layout.manifests.latest()
      expect(new Set(m.layers.map((l) => l.run ?? l.id)).size).toBeLessThanOrEqual(13)
      const live = [...version].sort((a, b) => a[0] - b[0])
      const want = live.map(([i, v]) => ({ key: ids[i]!, hash: `h${v}.${i}`, size: 10 }))
      expect(await layout.leafLines({ hash: 'leaf', type: 'T', entries: want })).toEqual(
        live.map(([i, v]) => `line ${v}.${i}`),
      )
    } finally {
      layoutConfig.graceMs = saved
      headConfig.intervalMs = 1000
    }
  }, 30_000)
})

describe('merges split into key-range jobs', () => {
  it('keep every record readable, with commits landing while a split merge runs', async () => {
    const saved = { ...layoutConfig }
    layoutConfig.graceMs = 0
    layoutConfig.mergeJobEntries = 300
    try {
      const layout = fLayout()
      let x = 99
      const rand = (n: number) => {
        x ^= x << 13
        x ^= x >>> 17
        x ^= x << 5
        return (x >>> 0) % n
      }
      const pending: MergePlan[] = []
      let splits = 0
      const split = async (plan: MergePlan) => {
        pending.push(plan)
        splits++
      }
      // A split merge's range jobs run in any order, some time after it was planned.
      const runOne = async () => {
        const plan = pending.shift()
        if (!plan) return
        const order = plan.ranges.map((_, i) => i).sort(() => rand(3) - 1)
        for (const i of order) if (await layout.mergeRange(plan, i)) await layout.mergeSwap(plan)
      }
      const version = new Map<number, number>()
      let most = 0
      for (let c = 0; c < 80; c++) {
        const size = rand(8) === 0 ? 300 + rand(400) : 1 + rand(30)
        const touched = new Set<number>()
        while (touched.size < size) touched.add(rand(3_000))
        const w = layout.writer()
        for (const i of [...touched].sort((a, b) => a - b)) {
          const now = version.get(i) ?? 0
          const v = now > 1 && rand(3) === 0 ? 1 + rand(now - 1) : now + 1
          version.set(i, v)
          w.add('T', { key: ids[i]!, hash: `h${v}.${i}`, size: 10 }, `line ${v}.${i}`)
        }
        await w.finish()
        await layout.maintain({ split })
        most = Math.max(most, runs((await layout.manifests.latest()).layers).length)
        // Range jobs lag far behind commits (a busy queue), then catch up.
        if (rand(8) === 0) while (pending.length) await runOne()
      }
      while (pending.length) await runOne()
      await layout.maintain({ split })
      while (pending.length) await runOne()
      expect(splits).toBeGreaterThan(0)
      // Runs no split merge holds keep merging while one waits: 19 at most here,
      // 33 when every merge waited for it (round 12).
      expect(most).toBeLessThanOrEqual(20)
      const live = [...version].sort((a, b) => a[0] - b[0])
      const want = live.map(([i, v]) => ({ key: ids[i]!, hash: `h${v}.${i}`, size: 10 }))
      expect(await layout.leafLines({ hash: 'leaf', type: 'T', entries: want })).toEqual(
        live.map(([i, v]) => `line ${v}.${i}`),
      )
    } finally {
      Object.assign(layoutConfig, saved)
    }
  }, 30_000)
})

describe('a backlog of tiny commits', () => {
  it('merges in a few passes, with pack merges among them', async () => {
    // Many collections committing at once: hundreds of tiny runs and packs land
    // while one maintain job works. Pack merges add mid-sized runs among them.
    const store = memoryStore()
    const layout = fLayout(store)
    let x = 7
    const rand = (n: number) => {
      x ^= x << 13
      x ^= x >>> 17
      x ^= x << 5
      return (x >>> 0) % n
    }
    const version = new Map<number, number>()
    let written = 0
    const put = store.put.bind(store)
    store.put = (key, body, opts) => {
      if (key.startsWith('runs/c1/layers/') && key.endsWith('.dir')) written++
      return put(key, body, opts)
    }
    for (let round = 0; round < 4; round++) {
      for (let c = 0; c < 120; c++) {
        const w = layout.writer()
        const touched = new Set<number>()
        const n = 5 + rand(8)
        while (touched.size < n) touched.add(rand(20_000))
        for (const i of [...touched].sort((a, b) => a - b)) {
          const v = (version.get(i) ?? 0) + 1
          version.set(i, v)
          w.add('T', { key: ids[i]!, hash: `h${v}.${i}`, size: 10 }, `line ${v}.${i}`)
        }
        await w.finish()
      }
      written = 0
      await layout.maintain()
      // A few merges catch up (18–33 layer files when four runs merged at a time).
      expect(written).toBeLessThanOrEqual(6)
      expect(runs((await layout.manifests.latest()).layers).length).toBeLessThanOrEqual(10)
    }
    const live = [...version].sort((a, b) => a[0] - b[0])
    const want = live.map(([i, v]) => ({ key: ids[i]!, hash: `h${v}.${i}`, size: 10 }))
    expect(await layout.leafLines({ hash: 'leaf', type: 'T', entries: want })).toEqual(
      live.map(([i, v]) => `line ${v}.${i}`),
    )
  })
})

describe('pack merges', () => {
  it('reach every tier while commits keep landing', async () => {
    // One pass a job, with commits between: tier 0 always has enough (FANOUT) to merge.
    // Not a test of the head: its interval only makes the 120 jobs wait.
    headConfig.intervalMs = 1
    const saved = { ...layoutConfig }
    layoutConfig.maintainBudgetMs = 0
    try {
      const layout = fLayout()
      let next = 0
      let most = 0
      for (let job = 0; job < 120; job++) {
        for (let c = 0; c < 10; c++) {
          const w = layout.writer()
          for (let i = 0; i < 6; i++, next++)
            w.add('T', { key: ids[next % ids.length]!, hash: `h${next}`, size: 10 }, `line ${next}`)
          await w.finish()
        }
        await layout.maintain()
        most = Math.max(most, (await layout.manifests.latest()).packs.length)
      }
      // 20 at most; 120 and rising by one a job when only the lowest tier with enough merged.
      expect(most).toBeLessThanOrEqual(30)
    } finally {
      Object.assign(layoutConfig, saved)
    }
  }, 30_000)
})

describe('layout F', () => {
  const rec = (i: number, v = 1) => ({ key: ids[i]!, hash: `h${v}.${i}`, size: 10 })
  const line = (i: number, v = 1) => `line ${v}.${i}`

  it("writes no key twice when a push's units finish together", async () => {
    // R2 refuses a second write to a key within a second: a push's units finishing
    // at once must not each rewrite the collection's manifest.
    const root = memoryStore()
    const writes = new Map<string, number>()
    const put = root.put.bind(root)
    root.put = (key, body, opts) => {
      writes.set(key, (writes.get(key) ?? 0) + 1)
      return put(key, body, opts)
    }
    const layout = fLayout(root)
    await Promise.all(
      Array.from({ length: 40 }, async (_, u) => {
        const w = layout.writer()
        for (let i = u * 50; i < u * 50 + 50; i++) w.add('T', rec(i), line(i))
        await w.finish()
      }),
    )
    expect([...writes].filter(([, n]) => n > 1)).toEqual([])
    // Readable before any merge folds them in: a reader that misses looks at pending runs.
    const all = Array.from({ length: 2000 }, (_, i) => i)
    expect(
      await layout.leafLines({ hash: 'leaf', type: 'T', entries: all.map((i) => rec(i)) }),
    ).toEqual(all.map((i) => line(i)))
    await layout.maintain()
    expect((await root.list('runs/c1/manifest/f/pending/')).keys).toEqual([])
    expect(
      await layout.leafLines({ hash: 'leaf', type: 'T', entries: all.map((i) => rec(i)) }),
    ).toEqual(all.map((i) => line(i)))
  })

  it('forks by reference: nothing copied, and each side keeps what the other reads', async () => {
    const saved = layoutConfig.graceMs
    layoutConfig.graceMs = 0
    headConfig.intervalMs = 25
    try {
      const root = memoryStore()
      const open = (id: string) => fLayout(root, id, `s/${id}`)
      const parent = open('p')
      const commit = async (l: KeyedLayout, from: number, to: number, v: number) => {
        const w = l.writer()
        for (let i = from; i < to; i++) w.add('T', rec(i, v), line(i, v))
        await w.finish()
        await l.maintain()
      }
      for (let c = 0; c < 12; c++) await commit(parent, c * 100, c * 100 + 100, 1)
      const bytes = async (prefix: string) => {
        let n = 0
        for (const k of (await root.list(prefix)).keys) n += (await root.get(k))!.size
        return n
      }
      const before = await bytes('runs/fork/')
      expect(before).toBe(0)
      const fork = open('fork')
      const r = await parent.forkInto(fork)
      // A list of what it reads where, and a marker in the parent: no pack or index copied.
      expect(r.bytes).toBeLessThan(20_000)
      expect((await root.list('runs/fork/packs/')).keys).toEqual([])
      const base = Array.from({ length: 1200 }, (_, i) => i)
      expect(
        await fork.leafLines({ hash: 'leaf', type: 'T', entries: base.map((i) => rec(i)) }),
      ).toEqual(base.map((i) => line(i)))
      // Both go on: the parent merges its runs and packs away, sweeping at once.
      for (let c = 0; c < 10; c++) {
        await commit(parent, c * 30, c * 30 + 30, 2)
        await commit(fork, 600 + c * 30, 600 + c * 30 + 30, 3)
      }
      expect(
        await fork.leafLines({ hash: 'leaf', type: 'T', entries: base.map((i) => rec(i)) }),
      ).toEqual(base.map((i) => line(i)))
      // The parent is deleted: what the fork reads stays, the rest goes.
      const gone = new Set<string>()
      const deleted = async (id: string) => gone.has(id)
      gone.add('p')
      const dropped = await KeyedLayout.dropCollection(root, 'p', deleted)
      expect(dropped.kept).toBeGreaterThan(0)
      const forkView = open('fork')
      expect(
        await forkView.leafLines({ hash: 'leaf', type: 'T', entries: base.map((i) => rec(i)) }),
      ).toEqual(base.map((i) => line(i)))
      // Then the fork: nothing of either is left.
      gone.add('fork')
      await KeyedLayout.dropCollection(root, 'fork', deleted)
      expect((await root.list('runs/')).keys).toEqual([])
    } finally {
      layoutConfig.graceMs = saved
      headConfig.intervalMs = 1000
    }
  })

  it("keeps a maintain job within a Worker's storage calls, queueing the rest", async () => {
    // A 12M load's 354 units left one maintain job ~10,460 storage calls (round 19):
    // Workers allow 10,000 subrequests an invocation.
    const saved = { ...layoutConfig }
    layoutConfig.graceMs = 0
    layoutConfig.maintainCalls = 400
    layoutConfig.mergeInputs = 32
    pendingConfig.deletesPerUpdate = 64
    headConfig.intervalMs = 25
    try {
      const root = memoryStore()
      let calls = 0
      const io = new Set(['get', 'head', 'put', 'list', 'delete'])
      const counting = new Proxy(root, {
        get(t, k) {
          const v = Reflect.get(t, k, t)
          if (typeof v !== 'function') return v
          return io.has(String(k))
            ? (...a: unknown[]) => {
                calls++
                return v.apply(t, a)
              }
            : v.bind(t)
        },
      })
      const layout = fLayout(counting)
      // A load's units all land before its first maintain job.
      for (let u = 0; u < 300; u++) {
        const w = layout.writer()
        for (let i = u * 5; i < u * 5 + 5; i++) w.add('T', rec(i), line(i))
        await w.finish()
      }
      // Each job queues the next while work is left, as the server's handler does.
      const jobs: number[] = []
      for (let more = true; more && jobs.length < 100;) {
        const before = calls
        more = (await layout.maintain()) === true
        jobs.push(calls - before)
      }
      // Within the budget, but for the pass that crossed it.
      expect(Math.max(...jobs)).toBeLessThanOrEqual(layoutConfig.maintainCalls * 2)
      expect((await root.list('runs/c1/manifest/f/pending/')).keys).toEqual([])
      const all = Array.from({ length: 1500 }, (_, i) => i)
      expect(
        await layout.leafLines({ hash: 'leaf', type: 'T', entries: all.map((i) => rec(i)) }),
      ).toEqual(all.map((i) => line(i)))
    } finally {
      Object.assign(layoutConfig, saved)
      pendingConfig.deletesPerUpdate = 500
      headConfig.intervalMs = 1000
    }
  })
})

describe("a commit's held runs", () => {
  const rec = (i: number, v = 1) => ({ key: ids[i]!, hash: `h${v}.${i}`, size: 10 })
  const line = (i: number, v = 1) => `line ${v}.${i}`

  it('are named once, however often a retry appends them', async () => {
    // Assembly appends a tree's runs, then saves the tree: a retry between the two
    // appends them again, perhaps after the first copy was folded in and merged away
    // (its files swept). Folded in again, they'd be the newest run, of files gone.
    const saved = layoutConfig.graceMs
    layoutConfig.graceMs = 0
    try {
      const root = memoryStore()
      const layout = fLayout(root)
      const pending = async () => (await root.list('runs/c1/manifest/f/pending/')).keys
      const w = layout.writer({ hold: true })
      for (let i = 0; i < 100; i++) w.add('T', rec(i), line(i))
      const [run] = await w.finish()
      if (!run) throw new Error('no run')
      await layout.appendRuns([run])
      // Before the first copy is folded in.
      await layout.appendRuns([run])
      expect(await pending()).toHaveLength(1)
      // Folded in, merged away, and swept.
      for (let c = 1; c <= 4; c++) {
        const w = layout.writer()
        for (let i = c * 100; i < c * 100 + 100; i++) w.add('T', rec(i), line(i))
        await w.finish()
        await layout.maintain()
      }
      await new Promise((r) => setTimeout(r, 5))
      await layout.maintain()
      const id = run.layers[0]!.id
      expect((await layout.manifests.latest()).layers.some((l) => l.id === id)).toBe(false)
      expect((await root.list(`runs/c1/layers/${id}`)).keys).toEqual([])
      // The retry writes nothing (a commit's own pending object may still be listed,
      // folded in but not yet deleted, depending on what the last maintain wrote).
      const before = await pending()
      await layout.appendRuns([run])
      expect(await pending()).toEqual(before)
      await layout.maintain()
      const all = Array.from({ length: 500 }, (_, i) => i)
      expect(
        await layout.leafLines({ hash: 'leaf', type: 'T', entries: all.map((i) => rec(i)) }),
      ).toEqual(all.map((i) => line(i)))
    } finally {
      layoutConfig.graceMs = saved
    }
  })
})

describe("a commit's writer", () => {
  it('writes a run out each time a run of entries is held, not at the end', async () => {
    // A commit's entries held to its end grew with the push: 204k records ran a
    // 128 MB isolate out of memory (staging, 2026-10-20).
    const saved = layoutConfig.writerRunEntries
    layoutConfig.writerRunEntries = 100
    try {
      const root = memoryStore()
      const layout = fLayout(root)
      const keys = Array.from({ length: 350 }, (_, i) => `k${String(i).padStart(4, '0')}`)
      const rec = (i: number) => ({ key: keys[i]!, hash: `h${i}`, size: 10 })
      const held = layout.writer({ hold: true })
      for (let i = 0; i < 350; i++) {
        held.add('T', rec(i), `line ${i}`)
        await held.drain?.()
      }
      const runs = await held.finish()
      // Three full runs as it went, the rest at the end; each stands alone.
      expect(runs.map((r) => r.layers.length > 0)).toEqual([true, true, true, true])
      await layout.appendRuns(runs)
      const all = Array.from({ length: 350 }, (_, i) => i)
      expect(await layout.leafLines({ hash: 'leaf', type: 'T', entries: all.map(rec) })).toEqual(
        all.map((i) => `line ${i}`),
      )
      // Not held: each run is named as it's written.
      const w = fLayout(memoryStore()).writer()
      for (let i = 0; i < 350; i++) {
        w.add('T', rec(i), `line ${i}`)
        await w.drain?.()
      }
      expect(await w.finish()).toEqual([])
    } finally {
      layoutConfig.writerRunEntries = saved
    }
  })
})

describe("an upload's packs", () => {
  const rec = (i: number, v = 1) => ({ key: ids[i]!, hash: `h${v}.${i}`, size: 10 })
  const line = (i: number, v = 1) => `line ${v}.${i}`
  const upload = (from: number, to: number, v = 1) =>
    Array.from({ length: to - from }, (_, j) => {
      // Out of key order, as a batch arrives.
      const i = to - 1 - j
      return { type: 'T', id: ids[i]!, hash: `h${v}.${i}`, line: line(i, v) }
    })

  it('are indexed where they lie, and merges re-point them once listed', async () => {
    const saved = layoutConfig.graceMs
    layoutConfig.graceMs = 0
    try {
      const root = memoryStore()
      const layout = fLayout(root)
      const packsNow = async () => (await root.list('runs/c1/packs/')).keys.length
      // Ten small uploads, each into a pack of its own; their commits index them.
      for (let u = 0; u < 10; u++) {
        const recs = upload(u * 100, u * 100 + 100)
        // Each pack is announced before it's written, and reported once it is.
        const seen: string[] = []
        const { places, packs } = await layout.writePacks(recs, {
          before: async (id) => {
            seen.push(`before ${id}`)
            expect(await root.head(`runs/c1/packs/${id}.pk`)).toBeNull()
          },
          after: async (p) => void seen.push(`after ${p.id} ${p.records}`),
        })
        expect(packs).toHaveLength(1)
        expect(seen).toEqual([`before ${packs[0]!.id}`, `after ${packs[0]!.id} 100`])
        const before = await packsNow()
        const w = layout.writer()
        recs.forEach((_, i) => w.addPlaced('T', rec(u * 100 + (99 - i)), places[i]!))
        await w.finish()
        // The commit wrote no pack: only its index.
        expect(await packsNow()).toBe(before)
        await layout.adoptPacks(`s${u}`, packs)
      }
      const all = Array.from({ length: 1000 }, (_, i) => i)
      const read = () =>
        layout.leafLines({ hash: 'leaf', type: 'T', entries: all.map((i) => rec(i)) })
      expect(await read()).toEqual(all.map((i) => line(i)))
      // Small packs: listed in the manifest, merged, their records re-pointed.
      expect((await layout.manifests.latest()).packs).toHaveLength(10)
      await layout.maintain()
      await new Promise((r) => setTimeout(r, 5))
      await layout.maintain()
      const m = await layout.manifests.latest()
      expect(m.packs.length).toBeLessThan(10)
      expect(await read()).toEqual(all.map((i) => line(i)))
    } finally {
      layoutConfig.graceMs = saved
    }
  })

  it('stream into whole packs when they arrive in key order', async () => {
    // A sorted upload's records go straight into packs as they arrive: 16 MB raw
    // each, not one pack a request.
    const layout = fLayout(memoryStore())
    const big = (i: number) => ({
      type: 'T',
      id: `k${String(i).padStart(5, '0')}`,
      hash: `h${i}`,
      line: `${i}:${'x'.repeat(20_000)}`,
    })
    const sorted = layout.uploadWriter()
    const places: string[] = []
    for (let i = 0; i < 1000; i++) {
      places.push(sorted.append(big(i)))
      await sorted.ready()
    }
    const packs = await sorted.finish()
    // 20 MB of records: one full pack and the rest.
    expect(packs).toHaveLength(2)
    expect(packs[0]!.raw).toBeGreaterThanOrEqual(16 * 1024 * 1024)
    expect(new Set(places.map((p) => p.split('.')[0])).size).toBe(2)
    // Out of order, each step down starts a new pack.
    const shuffled = layout.uploadWriter()
    for (const i of [5, 6, 1, 2, 9, 3]) shuffled.append(big(i))
    expect(await shuffled.finish()).toHaveLength(3)
  })

  it("count toward a commit writer's runs, written as it goes", async () => {
    // A commit of packed entries alone must not hold every index entry to its end (#63).
    const saved = layoutConfig.writerRunEntries
    layoutConfig.writerRunEntries = 100
    try {
      const layout = fLayout(memoryStore())
      const recs = upload(0, 350)
      const { places } = await layout.writePacks(recs)
      const w = layout.writer({ hold: true })
      for (let j = 0; j < 350; j++) {
        w.addPlaced('T', rec(349 - j), places[j]!)
        await w.drain?.()
      }
      const runs = await w.finish()
      expect(runs.map((r) => r.layers.length > 0)).toEqual([true, true, true, true])
      // Index runs only: the records stay in the upload's pack.
      expect(runs.every((r) => r.packs.length === 0)).toBe(true)
      await layout.appendRuns(runs)
      const all = Array.from({ length: 350 }, (_, i) => i)
      expect(
        await layout.leafLines({ hash: 'leaf', type: 'T', entries: all.map((i) => rec(i)) }),
      ).toEqual(all.map((i) => line(i)))
    } finally {
      layoutConfig.writerRunEntries = saved
    }
  })

  it('are listed once however often a commit retries, even after a merge took them', async () => {
    const root = memoryStore()
    const layout = fLayout(root)
    const recs = upload(0, 50)
    const { packs } = await layout.writePacks(recs)
    await layout.adoptPacks('s1', packs)
    await layout.adoptPacks('s1', packs)
    expect((await layout.manifests.latest()).packs.map((p) => p.id)).toEqual([packs[0]!.id])
    // As if a merge took it: a retry must not list it again.
    await layout.manifests.update((m) => ({ ...m, packs: [] }))
    await layout.adoptPacks('s1', packs)
    expect((await layout.manifests.latest()).packs).toEqual([])

    // A large one goes in the registry, once.
    const large = { ...packs[0]!, raw: UPLOAD_PACK_FINAL_RAW }
    await layout.adoptPacks('s2', [large])
    await layout.adoptPacks('s2', [large])
    expect((await layout.registry.read()).packs).toEqual([large])
  })

  it('are dropped for a push that never listed them, and kept once it did', async () => {
    const root = memoryStore()
    const layout = fLayout(root)
    const named = upload(0, 20)
    const a = await layout.writePacks(named)
    await layout.adoptPacks('kept', a.packs)
    const left = upload(20, 40)
    const b = await layout.writePacks(left)
    const files = async () => (await root.list('runs/c1/packs/')).keys
    expect(await files()).toHaveLength(4)
    expect(await layout.dropPacks('kept', [a.packs[0]!.id])).toEqual([])
    expect(await layout.dropPacks('left', [b.packs[0]!.id, 'neverwritten'])).toEqual([
      b.packs[0]!.id,
      'neverwritten',
    ])
    expect((await files()).sort()).toEqual(
      [`runs/c1/packs/${a.packs[0]!.id}.dir`, `runs/c1/packs/${a.packs[0]!.id}.pk`].sort(),
    )
  })
})

describe('the maintain lease', () => {
  it('is left alone when another job took it over', async () => {
    // A job that ran past its lease, which another job then took: releasing it at
    // the end must not release the new holder's.
    const root = memoryStore()
    const layout = fLayout(root)
    for (let c = 0; c < 4; c++) {
      const w = layout.writer()
      for (let i = c * 10; i < c * 10 + 10; i++)
        w.add('T', { key: ids[i]!, hash: `h${i}`, size: 10 }, `line ${i}`)
      await w.finish()
    }
    const put = root.put.bind(root)
    let taken = false
    root.put = async (key, body, opts) => {
      // Taken over while this job merges.
      if (!taken && key.startsWith('runs/c1/manifest/f/0')) {
        taken = true
        await put('runs/c1/maintain/lease', JSON.stringify({ token: 'other', at: Date.now() }))
      }
      return put(key, body, opts)
    }
    await layout.maintain()
    expect(taken).toBe(true)
    const lease = await root.get('runs/c1/maintain/lease')
    expect((JSON.parse(await lease!.text()) as { token: string }).token).toBe('other')
  })
})

describe('an untrusted repository in layout F', () => {
  it('checks every record it reads against its entry, however it reads it', async () => {
    const store = memoryStore()
    const line = (i: number) => recordCanonical(`r${i}`, 'T', { n: i })
    const entries = [0, 1, 2].map((i) => ({
      key: `r${i}`,
      hash: sha256Hex(line(i)),
      size: utf8ByteLength(line(i)),
    }))
    const trusted = openRepo(store, { layout: 'f', recordScope: 'c1', trusted: true })
    const w = trusted.records!.public.writer()
    // The second record's stored line isn't its entry's record.
    entries.forEach((e, i) => w.add('T', e, i === 1 ? line(9) : line(i)))
    await w.finish()
    const repo = openRepo(store, { layout: 'f', recordScope: 'c1' })
    const leaf = { hash: 'leaf', type: 'T', entries }
    expect(await repo.linesAt(leaf, [0, 2], 'public')).toEqual([line(0), line(2)])
    await expect(repo.linesAt(leaf, [1], 'public')).rejects.toThrow(IntegrityError)
    await expect(repo.entryLine(leaf, 1, 'public')).rejects.toThrow(IntegrityError)
    await expect(repo.bodyLines(leaf, 'public')).rejects.toThrow(IntegrityError)
    const stream = async () => {
      for await (const _ of repo.bodyLineStream(leaf, undefined, { set: 'public' }));
    }
    await expect(stream()).rejects.toThrow(IntegrityError)
  })
})

describe('a sparse merge', () => {
  it("reads ahead of a leaf's changes a batch at a time, not to its last key", async () => {
    // A leaf's range can take any number of inserts: looking ahead to its last key for
    // the old records the changes replace held every one of them at once.
    const e = (k: string, v = 0): RecordEntry => ({
      key: k,
      hash: sha256Hex(`${k}#${v}`),
      size: 10,
    })
    const sink = new MemorySink<RecordEntry>()
    const base = new MapSource(recordTree, sink.nodes, sink.leaves)
    const root = buildTree(recordTree, sink, [e('a'), e('z')])!
    expect(root.level).toBe(0)
    const reads: number[] = []
    const source: NodeSource<RecordEntry> = {
      spec: recordTree,
      node: (h) => base.node(h),
      leafEntries: (h) => base.leafEntries(h),
      sparseStream: async function* (h) {
        yield* await base.leafEntries(h)
      },
      withPayload: async (_h, x) => ({ ...x, body: 'old' }),
      payloadsAt: async (_h, entries, at) => {
        reads.push(...at)
        return at.map((i) => ({ ...entries[i]!, body: 'old' }))
      },
    }
    let pulled = 0
    let applied = 0
    let most = 0
    const changes = (async function* () {
      yield { key: 'a', entry: e('a', 1) }
      for (let i = 0; i < 20_000; i++) {
        most = Math.max(most, ++pulled - applied)
        const k = `m${String(i).padStart(6, '0')}`
        yield { key: k, entry: e(k) }
      }
      yield { key: 'z', entry: e('z', 1) }
    })()
    const olds: (string | undefined)[] = []
    await mergeTree(source, new MemorySink<RecordEntry>(), root.hash, changes, {
      onChange: (before) => {
        applied++
        if (before) olds.push(before.body)
      },
    })
    expect(applied).toBe(20_002)
    expect(olds).toEqual(['old', 'old'])
    expect(reads.sort()).toEqual([0, 1])
    expect(most).toBeLessThan(2_000)
  })
})

describe("a layer's read of a few keys", () => {
  it('finds their pages by binary search', async () => {
    const store = memoryStore()
    const w = new RunWriter(store, 0)
    for (const id of ids) w.add(`${id}\u0000h`, 'v'.repeat(200))
    const [layer] = await w.finish()
    const lru = repoLru(64 << 20)
    const reader = new LayerReader(store, lru, 's')
    const key = `${ids.at(-10)!}\u0000h`
    const want = await reader.pick(layer!, [key])
    expect(want).toHaveLength(1)
    // Count reads of the directory's first keys (it's cached now).
    const dir = (lru.get(`s/layerdir:${layer!.id}`) as { v: { first: string[] } }).v
    const first = dir.first
    expect(first.length).toBeGreaterThan(200)
    let reads = 0
    dir.first = new Proxy(first, {
      get(t, k, r) {
        if (typeof k === 'string' && /^\d+$/.test(k)) reads++
        return Reflect.get(t, k, r) as unknown
      },
    })
    expect(await reader.pick(layer!, [key])).toEqual(want)
    expect(reads).toBeLessThan(40)
  })
})

describe('node deltas', () => {
  const e = (i: number, v = 0) => ({
    key: `k${String(i).padStart(3, '0')}`,
    hash: sha256Hex(`${i}#${v}`),
    size: 10,
  })
  const base = Array.from({ length: 40 }, (_, i) => e(i))
  const changed = (at: number) => base.map((x, i) => (i === at ? e(i, 1) : x))
  /** Write one leaf of `entries` through `sink`; its hash. */
  const write = async (sink: RepoSink<RecordEntry>, entries: RecordEntry[]) => {
    const json = encodeLeaf(recordTree, entries)
    const hash = hashNode(json)
    sink.leaf(describeNode(recordTree, decodeNode(recordTree, json, hash)), json, entries, 0)
    await sink.flush()
    return hash
  }
  const repoOf = () =>
    openRepo(memoryStore(), { layout: 'f', recordScope: 'c1', nodes: 'delta', trusted: true })

  it('diff a rewritten leaf against the leaf it replaces, and no later leaf', async () => {
    const repo = repoOf()
    const a = await write(new RepoSink(repo), base)
    const sink = new RepoSink<RecordEntry>(repo)
    sink.rewriting(a)
    const b = await write(sink, changed(3))
    // The sink's next leaf rewrites nothing (a merge reused the nodes between, or appends).
    const c = await write(sink, changed(7))
    expect(await repo.deltaBase(b)).toBe(a)
    expect(await repo.deltaBase(c)).toBeNull()
  })

  it('go to a mirror in full: it may not hold the node a delta is against', async () => {
    const repo = repoOf()
    const a = await write(new RepoSink(repo), base)
    const sink = new RepoSink<RecordEntry>(repo)
    sink.rewriting(a)
    const b = await write(sink, changed(3))
    expect(await repo.deltaBase(b)).toBe(a)
    const tree = { set: 'public', kind: 'records', slug: 'T', base: null, target: b } as const
    const sent = []
    for await (const o of treeObjects(repo, tree)) sent.push(o)
    expect(sent.map((o) => o.key)).toEqual([`nodes/${b}`])
    expect(sha256Hex(await gunzipText(sent[0]!.bytes))).toBe(b)
  })
})

describe("F's manifest head", () => {
  // Split merges' swaps, reclaim and forks settle the head from their own jobs, beside
  // the maintain job: when it was last written must come from the head, not from an
  // isolate's memory (round 17's quick suite: one head write R2 would refuse).
  it('is written at most once an interval, whichever isolate writes it', async () => {
    headConfig.intervalMs = 200
    try {
      const store = memoryStore()
      const writes: number[] = []
      const watched = new Proxy(store, {
        get(t, k, r) {
          const v = Reflect.get(t, k, r)
          if (k === 'put')
            return (key: string, ...rest: unknown[]) => {
              if (key.endsWith('/head.json')) writes.push(Date.now())
              return v.call(t, key, ...rest)
            }
          return typeof v === 'function' ? v.bind(t) : v
        },
      })
      const isolate = () => new ManifestStore(watched, 'f')
      const a = isolate()
      await a.update((m) => m)
      // Another isolate, which has never read the head, changes the manifest at once.
      const b = isolate()
      await b.update((m) => m)
      // Then several jobs end together, each bringing the head up to date.
      await Promise.all([a.settle(), b.settle(), isolate().settle(), isolate().settle()])
      const gaps = writes.slice(1).map((t, i) => t - writes[i]!)
      expect(gaps.every((g) => g >= headConfig.intervalMs - 2)).toBe(true)
      // And the head ends at the newest manifest.
      const latest = await isolate().latest()
      expect((await isolate().current()).seq).toBe(latest.seq)
    } finally {
      headConfig.intervalMs = 1000
    }
  })
})

describe('a split merge whose inputs went', () => {
  it('drops itself, its outputs too, instead of failing until abandoned', async () => {
    const saved = { ...layoutConfig }
    layoutConfig.graceMs = 0
    try {
      const store = memoryStore()
      const layout = fLayout(store)
      for (let c = 0; c < 6; c++) {
        const w = layout.writer()
        for (let i = c * 10; i < c * 10 + 10; i++)
          w.add('T', { key: ids[i]!, hash: `h${i}`, size: 10 }, `line ${i}`)
        await w.finish()
      }
      const plan = await layout.mergePlan((await layout.manifests.latest()).layers, 20)
      expect(plan.ranges.length).toBeGreaterThan(1)
      expect(await layout.mergeRange(plan, 0)).toBe(false)
      // Another maintain merges the same runs first (a lease two jobs both held).
      await layout.maintain()
      expect(await layout.mergeRange(plan, 1)).toBe(false)
      expect(await layout.mergePlanById(plan.id)).toBeNull()
      expect((await store.list('runs/c1/merges/')).keys).toEqual([])
      const m = await layout.manifests.latest()
      const want = Array.from({ length: 60 }, (_, i) => ({ key: ids[i]!, hash: `h${i}`, size: 10 }))
      expect(await layout.leafLines({ hash: 'leaf', type: 'T', entries: want })).toEqual(
        want.map((_, i) => `line ${i}`),
      )
      // No layer file is left but the manifest's and those it retired (the merge's inputs).
      const id = (k: string) => k.slice('layers/'.length).split('.')[0]!
      const files = new Set(
        (await store.list('runs/c1/layers/')).keys.map((k) => id(k.slice('runs/c1/'.length))),
      )
      const known = [
        ...m.layers.map((l) => l.id),
        ...m.retired.filter((r) => r.key.startsWith('layers/')).map((r) => id(r.key)),
      ]
      expect([...files].sort()).toEqual([...new Set(known)].sort())
    } finally {
      Object.assign(layoutConfig, saved)
    }
  })
})

describe('layered index reads', () => {
  it('find the same values a few keys or many at a time, newest layer winning', async () => {
    const store = memoryStore()
    const manifests = new ManifestStore(store, 'f')
    const layer = async (from: number, to: number, tag: string, level: number, seq: number) => {
      const w = new RunWriter(store, level)
      for (let i = from; i < to; i++) w.add(`${ids[i]}\u0000h${i % 7}`, `${tag}.${i}`)
      const files = await w.finish(seq)
      await manifests.update((m) => {
        m.layers.push(...files)
        return m
      })
    }
    await layer(0, 12_000, 'a', 1, 1)
    await layer(8_000, 20_000, 'b', 0, 2)
    await layer(5_000, 6_000, 'c', 0, 3)
    const index = new LayeredIndex(store, repoLru(8 << 20), 's', manifests)
    const m = await manifests.current()
    const key = (i: number) => `${ids[i]}\u0000h${i % 7}`
    const all = Array.from({ length: 200 }, (_, j) => 4_900 + j)
    const many = await index.values(m, all.map(key))
    expect(many.size).toBe(200)
    for (const i of [0, 1, 4_999, 5_000, 5_500, 7_999, 8_000, 11_999, 12_000, 19_999]) {
      const one = await index.values(m, [key(i)])
      expect(one.size).toBe(1)
      if (many.has(key(i))) expect(one.get(key(i))).toBe(many.get(key(i)))
    }
    // The newest layer's value wins where layers overlap.
    expect((await index.values(m, [key(5_500)])).get(key(5_500))).toMatch(/^c\./)
    expect(many.get(key(5_000))).toMatch(/^c\./)
    expect(many.get(key(4_999))).toMatch(/^a\./)
    // A key no layer holds.
    expect((await index.values(m, [`${ids[5]}\u0000nope`])).size).toBe(0)
  })
})

describe("layout F's reads and merges hold a bounded amount", () => {
  /** `store`, counting reads of keys matching `re` and the most at once. */
  const watched = (store: Store, re: RegExp) => {
    const n = { reads: 0, inFlight: 0, most: 0 }
    const s = new Proxy(store, {
      get(t, k) {
        const v = Reflect.get(t, k, t) as unknown
        if (k !== 'get' || typeof v !== 'function') return typeof v === 'function' ? v.bind(t) : v
        return async (key: string, ...rest: unknown[]) => {
          if (!re.test(key)) return (v as (...a: unknown[]) => unknown).call(t, key, ...rest)
          n.reads++
          n.most = Math.max(n.most, ++n.inFlight)
          try {
            return await (v as (...a: unknown[]) => Promise<unknown>).call(t, key, ...rest)
          } finally {
            n.inFlight--
          }
        }
      },
    })
    return { store: s, n }
  }

  it("reads a leaf of a small type without the large type's records between its ids", async () => {
    // As Crossref's: every type's ids are DOIs, so a small type's leaf spans
    // much of the id space a large type fills.
    const { store, n } = watched(memoryStore(), /\.ly$/)
    const layout = fLayout(store)
    const w = layout.writer()
    for (let i = 0; i < 20_000; i++)
      w.add('journal-article', { key: ids[i]!, hash: `h${i}`, size: 10 }, 'x'.repeat(100))
    const small = ids.filter((_, i) => i % 200 === 0)
    for (const [i, id] of small.entries())
      w.add('dataset', { key: id, hash: `d${i}`, size: 10 }, `dataset ${i}`)
    await w.finish()
    const entries = small.map((id, i) => ({ key: id, hash: `d${i}`, size: 10 }))
    const leaf = { hash: 'leaf', type: 'dataset', entries }
    expect(await layout.leafLines(leaf)).toEqual(small.map((_, i) => `dataset ${i}`))
    // The large type's 20,000 entries fill over a hundred pages; the leaf's are one or two.
    expect(n.reads).toBeLessThanOrEqual(3)
  })

  it('reads an index of many runs a few layers at a time, newest first', async () => {
    const { store, n } = watched(memoryStore(), /\.dir$/)
    const layout = fLayout(store)
    // Forty commits' runs, as a large push leaves before merges catch up.
    for (let r = 0; r < 40; r++) {
      const w = layout.writer()
      for (let i = r * 100; i < r * 100 + 100; i++)
        w.add('T', { key: ids[i]!, hash: `h${i}`, size: 10 }, `line ${i}`)
      await w.finish()
    }
    expect(runs((await layout.manifests.latest()).layers).length).toBe(40)
    // The oldest run's records: every layer is looked in.
    const entries = Array.from({ length: 100 }, (_, i) => ({
      key: ids[i]!,
      hash: `h${i}`,
      size: 10,
    }))
    n.most = 0
    expect(await layout.leafLines({ hash: 'leaf', type: 'T', entries })).toEqual(
      entries.map((_, i) => `line ${i}`),
    )
    // Sixteen at a time: never all forty.
    expect(n.most).toBeLessThanOrEqual(16)
  })

  it('plans a reclaim only once merges bring the runs down', async () => {
    const layout = fLayout()
    for (let r = 0; r <= RECLAIM_MAX_RUNS; r++) {
      const w = layout.writer()
      w.add('T', { key: ids[r]!, hash: `h${r}`, size: 10 }, `line ${r}`)
      await w.finish()
    }
    await expect(layout.reclaimPlan()).rejects.toThrow(TooManyRunsError)
    while (await layout.maintain());
    await layout.maintain()
    expect(runs((await layout.manifests.latest()).layers).length).toBeLessThanOrEqual(
      RECLAIM_MAX_RUNS,
    )
    await expect(layout.reclaimPlan()).resolves.toBeTruthy()
  })

  it("shares a merge's read budget among its inputs", () => {
    expect(mergeRead(1)).toBe(1024 * 1024)
    expect(mergeRead(16)).toBe(1024 * 1024)
    expect(mergeRead(128)).toBe(128 * 1024)
    // Never below a few pages, however many inputs.
    expect(mergeRead(1_000)).toBe(64 * 1024)
    expect(mergeRead(128) * 128).toBeLessThanOrEqual(MERGE_READ_BUDGET)
  })
})
