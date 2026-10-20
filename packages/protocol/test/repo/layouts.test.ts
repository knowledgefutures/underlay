/**
 * Layout F's index pieces (repo/layouts): a layer's Bloom
 * filter holds every key it was built from, and a lookup through the filters
 * finds exactly what a range read of the same keys finds, newest layer winning.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  headConfig,
  HomeStore,
  KeyedLayout,
  layoutConfig,
  LiveHashes,
  memoryStore,
  type MergePlan,
} from '../../src/index.js'
import {
  buildFilter,
  filterHas,
  levelFor,
  LayeredIndex,
  ManifestStore,
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
const fLayout = (store = memoryStore(), home = 'c1', scope = 's') =>
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
      for (let i = from; i < to; i++) w.add(entry(i, v), line(i, v))
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
    for (const e of want) live.add(e.key, e.hash)
    expect(live.has(want[0]!.key, 'h1.0')).toBe(false)
    expect(live.has(want[0]!.key, want[0]!.hash)).toBe(true)

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
    for (const id of swapped!.rewrite) await layout.reclaimRewrite([id])

    const packs = await layout.allPacks()
    expect(packs.some((p) => swapped!.rewrite.includes(p.id))).toBe(false)
    expect(packs.reduce((s, p) => s + p.records, 0)).toBe(n)
    const lines = await layout.leafLines('leaf', want)
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
        for (let i = k * 100; i < k * 100 + 100; i++) w.add(entry(i), `line ${i}`)
        await w.finish()
      }),
    )
    expect((await layout.manifests.latest()).layers.length).toBe(12)
    await layout.maintain()
    const want = Array.from({ length: 1_200 }, (_, i) => entry(i))
    expect(await layout.leafLines('leaf', want)).toEqual(want.map((_, i) => `line ${i}`))
    expect((await layout.manifests.latest()).layers.length).toBeLessThan(12)
  })
})

describe('size-tiered index levels', () => {
  it('merge small commits with each other, leaving a large run alone', async () => {
    const layout = fLayout()
    const entry = (i: number) => ({ key: ids[i]!, hash: `h.${i}`, size: 10 })
    const write = async (from: number, n: number) => {
      const w = layout.writer()
      for (let i = from; i < from + n; i++) w.add(entry(i), `line ${i}`)
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
    expect(await layout.leafLines('leaf', want)).toEqual(
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
          w.add({ key: ids[i]!, hash: `h${v}.${i}`, size: 10 }, `line ${v}.${i}`)
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
      expect(await layout.leafLines('leaf', want)).toEqual(live.map(([i, v]) => `line ${v}.${i}`))
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
          w.add({ key: ids[i]!, hash: `h${v}.${i}`, size: 10 }, `line ${v}.${i}`)
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
      expect(await layout.leafLines('leaf', want)).toEqual(live.map(([i, v]) => `line ${v}.${i}`))
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
          w.add({ key: ids[i]!, hash: `h${v}.${i}`, size: 10 }, `line ${v}.${i}`)
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
    expect(await layout.leafLines('leaf', want)).toEqual(live.map(([i, v]) => `line ${v}.${i}`))
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
            w.add({ key: ids[next % ids.length]!, hash: `h${next}`, size: 10 }, `line ${next}`)
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
        for (let i = u * 50; i < u * 50 + 50; i++) w.add(rec(i), line(i))
        await w.finish()
      }),
    )
    expect([...writes].filter(([, n]) => n > 1)).toEqual([])
    // Readable before any merge folds them in: a reader that misses looks at pending runs.
    const all = Array.from({ length: 2000 }, (_, i) => i)
    expect(
      await layout.leafLines(
        'leaf',
        all.map((i) => rec(i)),
      ),
    ).toEqual(all.map((i) => line(i)))
    await layout.maintain()
    expect((await root.list('runs/c1/manifest/f/pending/')).keys).toEqual([])
    expect(
      await layout.leafLines(
        'leaf',
        all.map((i) => rec(i)),
      ),
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
        for (let i = from; i < to; i++) w.add(rec(i, v), line(i, v))
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
        await fork.leafLines(
          'leaf',
          base.map((i) => rec(i)),
        ),
      ).toEqual(base.map((i) => line(i)))
      // Both go on: the parent merges its runs and packs away, sweeping at once.
      for (let c = 0; c < 10; c++) {
        await commit(parent, c * 30, c * 30 + 30, 2)
        await commit(fork, 600 + c * 30, 600 + c * 30 + 30, 3)
      }
      expect(
        await fork.leafLines(
          'leaf',
          base.map((i) => rec(i)),
        ),
      ).toEqual(base.map((i) => line(i)))
      // The parent is deleted: what the fork reads stays, the rest goes.
      const gone = new Set<string>()
      const deleted = async (id: string) => gone.has(id)
      gone.add('p')
      const dropped = await KeyedLayout.dropCollection(root, 'p', deleted)
      expect(dropped.kept).toBeGreaterThan(0)
      const forkView = open('fork')
      expect(
        await forkView.leafLines(
          'leaf',
          base.map((i) => rec(i)),
        ),
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
        for (let i = u * 5; i < u * 5 + 5; i++) w.add(rec(i), line(i))
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
        await layout.leafLines(
          'leaf',
          all.map((i) => rec(i)),
        ),
      ).toEqual(all.map((i) => line(i)))
    } finally {
      Object.assign(layoutConfig, saved)
      pendingConfig.deletesPerUpdate = 500
      headConfig.intervalMs = 1000
    }
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
          w.add({ key: ids[i]!, hash: `h${i}`, size: 10 }, `line ${i}`)
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
      expect(await layout.leafLines('leaf', want)).toEqual(want.map((_, i) => `line ${i}`))
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

describe('layered index lookups', () => {
  it('find what a range read finds, newest layer winning', async () => {
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
    for (const i of [0, 1, 4_999, 5_000, 5_500, 7_999, 8_000, 11_999, 12_000, 19_999]) {
      const id = ids[i]!
      const looked = await index.lookup(m, [id])
      const ranged = await index.range(m, `${id}\u0000`, `${id}\u0000￿`)
      expect([...looked].sort()).toEqual([...ranged].sort())
      expect(looked.size).toBe(1)
    }
    const many = ids.slice(4_990, 5_010)
    const looked = await index.lookup(m, many)
    const ranged = await index.range(m, `${many[0]}\u0000`, `${many.at(-1)}\u0000￿`)
    expect([...looked].sort()).toEqual([...ranged].sort())
    // The newest layer's value wins where layers overlap.
    expect([...(await index.lookup(m, [ids[5_500]!])).values()][0]).toMatch(/^c\./)
  })
})
