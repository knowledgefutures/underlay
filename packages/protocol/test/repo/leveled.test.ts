/**
 * Layout F's leveled packs (layouts/levels.ts): merges take level 0 down to the base
 * and each level into the next, every level's packs apart in key order, replaced
 * versions in history packs, and every record readable through the index throughout.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  headConfig,
  HomeStore,
  KeyedLayout,
  layoutConfig,
  memoryStore,
  type PackInfo,
  type Store,
} from '../../src/index.js'
import { levelConfig, MAX_LEVEL } from '../../src/repo/layouts/levels.js'
import { repoLru } from '../../src/repo/repo.js'
import { compareUtf8 } from '../../src/utf8.js'

const saved = { level: { ...levelConfig }, layout: { ...layoutConfig } }
beforeEach(() => {
  headConfig.intervalMs = 1
  layoutConfig.graceMs = 0
  // Small sizes, so a few hundred records make several levels of several packs.
  Object.assign(levelConfig, {
    minRaw: 1_000,
    level0Packs: 4,
    level0Raw: 4_000,
    level0MergeRaw: 8_000,
    packRaw: 3_000,
    shardPacks: 3,
    staleEntries: 50,
  })
})
afterEach(() => {
  headConfig.intervalMs = 1000
  Object.assign(levelConfig, saved.level)
  Object.assign(layoutConfig, saved.layout)
})

const layout = (store: Store = memoryStore(), home = 'c1') =>
  new KeyedLayout(new HomeStore(store, home), repoLru(8 << 20), home)

const leveledLayout = async (store?: Store, home?: string) => {
  const l = layout(store, home)
  await l.markLeveled()
  return l
}

const ids = Array.from(
  { length: 400 },
  (_, i) => `10.${1000 + (i % 7)}/w${String(i).padStart(4, '0')}`,
).sort()
const line = (id: string, v: number) => `${id} v${v} ${'x'.repeat(80)}`

/**
 * Every level's packs by level key (`1`…, the history's `h1`…), checked apart and in
 * key order; and the level each says it's in.
 */
async function levelPacks(l: KeyedLayout) {
  const m = await l.manifests.latest()
  const out = new Map<string, PackInfo[]>()
  for (const [lv, shards] of Object.entries(m.levels ?? {})) {
    const ps = await l.levels.packs(shards)
    for (let i = 1; i < ps.length; i++)
      expect(compareUtf8(ps[i]!.lo!, ps[i - 1]!.hi!), `level ${lv} overlaps`).toBeGreaterThan(0)
    for (const p of ps) expect(p.level).toBe(Number(lv.replace('h', '')))
    for (const s of shards) {
      const mine = await l.levels.read(s.id)
      expect(s.lo).toBe(mine[0]!.lo)
      expect(s.hi).toBe(mine.at(-1)!.hi)
    }
    if (ps.length) out.set(lv, ps)
  }
  return { m, levels: out }
}

/** Commits of a few records each, some ids new, some changed; their versions. */
async function commits(l: KeyedLayout, n: number, seed = 1) {
  let s = seed
  const rnd = () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
  const current = new Map<string, number>()
  const all: [string, number][] = []
  for (let c = 0; c < n; c++) {
    const w = l.writer()
    const picked = new Set<string>()
    while (picked.size < 20) picked.add(ids[Math.floor(rnd() * ids.length)]!)
    for (const id of [...picked].sort()) {
      const v = (current.get(id) ?? 0) + 1
      current.set(id, v)
      all.push([id, v])
      w.add('T', { key: id, hash: `h${v}`, size: 10 }, line(id, v))
    }
    await w.finish()
    while (await l.maintain());
    await l.maintain()
  }
  return { current, all }
}

async function readAll(l: KeyedLayout, versions: Iterable<[string, number]>) {
  const vs = [...versions].sort((a, b) => compareUtf8(a[0], b[0]) || a[1] - b[1])
  const got = await l.leafLines({
    hash: 'leaf',
    type: 'T',
    entries: vs.map(([id, v]) => ({ key: id, hash: `h${v}`, size: 10 })),
  })
  expect(got).toEqual(vs.map(([id, v]) => line(id, v)))
}

describe('leveled packs', () => {
  it('merge down level by level, each level apart, every record readable', async () => {
    const l = await leveledLayout()
    const { current, all } = await commits(l, 40)
    const { m, levels } = await levelPacks(l)
    // Data went below level 0, into more than one level, and a level holds several packs.
    expect(levels.size).toBeGreaterThan(1)
    expect([...levels.values()].some((ps) => ps.length > 1)).toBe(true)
    expect(m.stats.levelMerges).toBeGreaterThan(0)
    expect(m.packs.length).toBeLessThan(levelConfig.level0Packs)
    // The current versions, and every older one, through the index.
    await readAll(l, current)
    await readAll(l, all)
  })

  it('move replaced versions to history packs, out of the levels', async () => {
    const l = await leveledLayout()
    const { current } = await commits(l, 40)
    const { levels } = await levelPacks(l)
    const history = (await l.allPacks()).filter((p) => p.history)
    expect(history.length).toBeGreaterThan(0)
    expect(history.every((p) => p.history === new Date().toISOString().slice(0, 7))).toBe(true)
    // The levels hold about one version an id: the newest, or one a merge hasn't met yet.
    const inLevels = [...levels]
      .filter(([lv]) => !lv.startsWith('h'))
      .flatMap(([, ps]) => ps)
      .reduce((n, p) => n + p.records, 0)
    expect(inLevels).toBeLessThan(current.size * 1.5)
  })

  it('take a load sent in key order as the bottom level, as written', async () => {
    const l = await leveledLayout()
    const w = l.uploadWriter()
    for (const id of ids) w.append({ type: 'T', id, hash: 'h1', line: line(id, 1) })
    // Sent in two parts, so the load is two packs that don't overlap.
    const packs = [...(await w.finish())]
    const w2 = l.uploadWriter()
    for (const id of ids) w2.append({ type: 'U', id, hash: 'h1', line: line(id, 1) })
    packs.push(...(await w2.finish()))
    expect(packs).toHaveLength(2)
    await l.adoptPacks('load', packs)
    const { m, levels } = await levelPacks(l)
    expect(m.packs).toEqual([])
    expect(
      levels
        .get(String(MAX_LEVEL))!
        .map((p) => p.id)
        .sort(),
    ).toEqual(packs.map((p) => p.id).sort())
    // A retry lists nothing again.
    await l.adoptPacks('load', packs)
    expect((await levelPacks(l)).levels.get(String(MAX_LEVEL))!.length).toBe(packs.length)
    // An upload out of order into a collection holding data goes to level 0.
    const u = l.uploadWriter()
    for (const id of [ids[5]!, ids[1]!]) u.append({ type: 'T', id, hash: 'h2', line: line(id, 2) })
    const more = await u.finish()
    await l.adoptPacks('more', more)
    expect((await l.manifests.latest()).packs.map((p) => p.id).sort()).toEqual(
      more.map((p) => p.id).sort(),
    )
  })

  it('keep every record readable while commits land during merges', async () => {
    const l = await leveledLayout()
    const current = new Map<string, number>()
    for (let c = 0; c < 30; c++) {
      const w = l.writer()
      const batch = ids.slice((c * 13) % 380, ((c * 13) % 380) + 12)
      for (const id of batch) {
        const v = (current.get(id) ?? 0) + 1
        current.set(id, v)
        w.add('T', { key: id, hash: `h${v}`, size: 10 }, line(id, v))
      }
      await Promise.all([w.finish(), l.maintain(), l.maintain()])
    }
    while (await l.maintain());
    await levelPacks(l)
    await readAll(l, current)
  })

  it('reclaim drops what nothing keeps, from the levels and history alike', async () => {
    const l = await leveledLayout()
    const { current, all } = await commits(l, 40)
    const before = (await l.allPacks()).length
    // Keep the current versions only: older ones (mostly in history) are dropped.
    const stats = await l.reclaim({
      records: [...current].map(([id, v]) => `T\u0000${id}\u0000h${v}`),
    } as never)
    expect(stats.recordsDropped).toBe(all.length - current.size)
    while (await l.maintain());
    await levelPacks(l)
    await readAll(l, current)
    expect((await l.allPacks()).length).toBeLessThan(before)
  })

  it("keep the index to level 0, finding what the levels hold through each pack's own index", async () => {
    const l = await leveledLayout()
    const { all } = await commits(l, 40)
    const { m, levels } = await levelPacks(l)
    expect([...levels.values()].flat().every((p) => p.indexed)).toBe(true)
    // Tiered, the index has an entry a copy; here only what level 0 held since the last index merge.
    expect(m.layers.reduce((n, x) => n + x.entries, 0)).toBeLessThan(all.length / 4)
    // The history is leveled too.
    expect([...levels.keys()].some((k) => k.startsWith('h'))).toBe(true)
    await readAll(l, all)
  })

  it('reclaim copies a mostly-dead level pack within its level', async () => {
    const l = await leveledLayout()
    const { current, all } = await commits(l, 40)
    // The current versions and every third older one: history packs end up under half live.
    const kept = all.filter(([id, v], i) => current.get(id) === v || i % 3 === 0)
    const stats = await l.reclaim({
      records: kept.map(([id, v]) => `T\u0000${id}\u0000h${v}`),
    } as never)
    expect(stats.recordsDropped).toBe(all.length - kept.length)
    expect(stats.packsRewritten).toBeGreaterThan(0)
    expect((await l.manifests.latest()).stats.levelRewrites).toBe(stats.packsRewritten)
    while (await l.maintain());
    await levelPacks(l)
    await readAll(l, kept)
    const records = (await l.allPacks()).reduce((n, p) => n + p.records, 0)
    expect(records).toBeLessThan(all.length)
    expect(records).toBeGreaterThanOrEqual(kept.length)
  })

  it('keep the index entries of an upload not yet adopted through index merges', async () => {
    const l = await leveledLayout()
    await commits(l, 10)
    // An upload's packs are written, and its commit's entries indexed, before the packs are listed.
    const fresh = ids.slice(0, 40).map((id) => `${id}u`)
    const w = l.uploadWriter()
    const places = fresh.map((id) => w.append({ type: 'T', id, hash: 'h1', line: line(id, 1) }))
    const packs = await w.finish()
    const before = new Set((await l.manifests.latest()).layers.map((x) => x.id))
    const cw = l.writer()
    fresh.forEach((id, i) => cw.addPlaced('T', { key: id, hash: 'h1', size: 10 }, places[i]!))
    await cw.finish()
    const run = (await l.manifests.latest()).layers.filter((x) => !before.has(x.id))
    expect(run.length).toBeGreaterThan(0)
    // Index merges meanwhile take that run in (once the runs after it add up to its size).
    await commits(l, 30, 3)
    const now = new Set((await l.manifests.latest()).layers.map((x) => x.id))
    expect(run.some((x) => now.has(x.id))).toBe(false)
    await l.adoptPacks('late', packs)
    // In level 0 now, found through the index (before merges carry them down, after which
    // their packs' own indexes would find them whatever the index held).
    const versions = fresh.map((id) => [id, 1] as [string, number])
    await readAll(l, versions)
    while (await l.maintain());
    await readAll(l, versions)
  })

  it('sweep a pack that went down only once no index run names it', async () => {
    const store = memoryStore()
    const l = await leveledLayout(store)
    // No merge of every run yet: the index may still name packs level 0 merged down.
    levelConfig.staleEntries = 1e9
    await commits(l, 12)
    const m = await l.manifests.latest()
    expect(m.stats.levelMerges).toBeGreaterThan(0)
    const held = m.retired.filter((r) => r.key.endsWith('.pk'))
    expect(held.length).toBeGreaterThan(0)
    for (const r of held) expect(await store.head(`runs/c1/${r.key}`)).not.toBeNull()
    // Once one runs, they go.
    levelConfig.staleEntries = 50
    while (await l.maintain());
    await l.maintain()
    const after = await l.manifests.latest()
    expect(after.stats.indexSettledAt).toBeGreaterThan(0)
    for (const r of held) expect(await store.head(`runs/c1/${r.key}`)).toBeNull()
  })

  it('merge away the index entries of a sorted load once it is the bottom level', async () => {
    const l = await leveledLayout()
    const w = l.uploadWriter()
    const places = ids.map((id) => w.append({ type: 'T', id, hash: 'h1', line: line(id, 1) }))
    const packs = await w.finish()
    const cw = l.writer()
    ids.forEach((id, i) => cw.addPlaced('T', { key: id, hash: 'h1', size: 10 }, places[i]!))
    await cw.finish()
    await l.adoptPacks('load', packs)
    expect((await l.manifests.latest()).stats.indexStale).toBe(ids.length)
    await l.maintain()
    const m = await l.manifests.latest()
    expect(m.layers.reduce((n, x) => n + x.entries, 0)).toBe(0)
    expect(m.stats.indexStale).toBe(0)
    await readAll(
      l,
      ids.map((id) => [id, 1] as [string, number]),
    )
  })

  it('fork as leveled, the fork reading its parent and its merges leaving the parent alone', async () => {
    const root = memoryStore()
    const parent = await leveledLayout(root, 'p')
    const { current } = await commits(parent, 20)
    const fork = layout(root, 'f')
    await parent.forkInto(fork)
    expect(await fork.leveled()).toBe(true)
    await readAll(fork, current)
    // The fork changes and merges; the parent reads as before.
    const more = await commits(fork, 20, 7)
    await levelPacks(fork)
    await readAll(parent, current)
    const merged = new Map(current)
    for (const [id, v] of more.current) merged.set(id, Math.max(v, merged.get(id) ?? 0))
    expect((await levelPacks(parent)).levels.size).toBeGreaterThan(0)
  })

  it('level an empty collection at its first write once switched on, but not one holding packs', async () => {
    const root = memoryStore()
    const older = layout(root, 'old')
    await commits(older, 3)
    layoutConfig.levelNew = true
    try {
      // Opened again (a new isolate): it held packs before leveling, so it stays tiered.
      expect(await layout(root, 'old').leveled()).toBe(false)
      const fresh = layout(root, 'new')
      const { current } = await commits(fresh, 30)
      expect(await layout(root, 'new').leveled()).toBe(true)
      expect((await levelPacks(fresh)).levels.size).toBeGreaterThan(0)
      await readAll(fresh, current)
    } finally {
      layoutConfig.levelNew = false
    }
  })

  it('leave a collection that is not leveled tiered, as before', async () => {
    const l = layout()
    await commits(l, 10)
    const m = await l.manifests.latest()
    expect(m.levels).toBeUndefined()
    expect(await l.leveled()).toBe(false)
  })
})
