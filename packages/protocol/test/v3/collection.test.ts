/** Collections, forks, storage accounting, and the deletion sweep. */
import { describe, expect, it } from 'vitest'

import {
  listAll,
  memoryStore,
  type MemoryStore,
  sha256Hex,
  type Store,
  v3,
} from '../../src/index.js'
import { dec, rec, rem, rng } from './helpers.js'
import { checkReads, commitRows, Model, randomUpload } from './model.js'

const line = (r: v3.WriteRow): v3.LineRow => {
  if (r.kind === 'w') throw new Error('no line')
  return { kind: r.kind, type: r.type, id: r.id, line: r.line as string }
}
async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of it) out.push(x)
  return out
}
const HOUR = 3_600_000
const DAY = 24 * HOUR

/** A collection with a few commits and a model of it. */
async function seeded(store: Store, id: string, seed: number, commits = 4) {
  const rand = rng(seed)
  const model = new Model()
  for (let c = 0; c < commits; c++) {
    const rows = randomUpload(rand)
    model.add(rows)
    await commitRows(store, id, rows)
  }
  return { model, rand }
}

const cloneModel = (m: Model, at: number): Model => {
  const out = new Model()
  for (const c of m.commits.slice(0, at)) out.commits.push(new Map(c))
  return out
}

describe('collections', () => {
  it('creates a collection once and deletes it', async () => {
    const store = memoryStore()
    const d = await v3.createCollection(store, 'c1', { name: 'One' }, () => new Date(0))
    expect(d).toEqual({ id: 'c1', name: 'One', createdAt: '1970-01-01T00:00:00.000Z' })
    expect(await v3.readDescription(store, 'c1')).toEqual(d)
    await expect(v3.createCollection(store, 'c1')).rejects.toThrow(/already exists/)
    await expect(v3.createCollection(store, 'a/b')).rejects.toThrow(/Bad collection id/)
    await seeded(store, 'c1', 1)
    expect(await v3.deleteCollection(store, 'c1')).toBeGreaterThan(4)
    expect(await collect(listAll(store, 'collections/'))).toEqual([])
    expect(await v3.readDescription(store, 'c1')).toBe(null)
    // Its files stay until a sweep.
    expect((await collect(listAll(store, 'records/'))).length).toBe(4)
  })
})

describe('forks', () => {
  it('copies only commits and the layout, and reads as its parent did', async () => {
    const store = memoryStore()
    await v3.createCollection(store, 'parent')
    const { model, rand } = await seeded(store, 'parent', 2, 6)
    await v3.rebuild(store, 'parent', { plan: (groups) => [groups.slice(0, 4)] })
    const records = await collect(listAll(store, 'records/'))
    const fork = await v3.forkCollection(store, 'parent', 'fork')
    // No sorted-record-file was written or copied.
    expect(await collect(listAll(store, 'records/'))).toEqual(records)
    // The description, six commits, the layout, and the two hints.
    expect(fork.objects).toBe(1 + 6 + 1 + 2)
    expect(fork.bytes).toBeLessThan(8000)
    const head = (await v3.findHead(store, 'parent'))!
    expect(fork.description).toMatchObject({
      id: 'fork',
      forkedFrom: { collection: 'parent', commit: 6, id: head.id },
      lineage: [['parent', 6]],
    })
    // The same history and version ids.
    expect((await v3.findHead(store, 'fork'))!.id).toBe(head.id)
    await checkReads(store, 'fork', model, rand)
    await v3.verifyLog(store, 'fork', { lineage: fork.description.lineage! })
    await expect(v3.forkCollection(store, 'parent', 'fork')).rejects.toThrow(/already exists/)
  })

  it('goes its own way after the fork, and so does its parent', async () => {
    const store = memoryStore()
    const { model: parent, rand } = await seeded(store, 'parent', 3, 5)
    await v3.rebuild(store, 'parent', { plan: v3.planAll })
    await v3.forkCollection(store, 'parent', 'fork')
    const fork = cloneModel(parent, 5)
    for (let i = 0; i < 3; i++) {
      const a = randomUpload(rand)
      parent.add(a)
      await commitRows(store, 'parent', a)
      const b = randomUpload(rand)
      fork.add(b)
      const made = await commitRows(store, 'fork', b)
      expect(made.commit.collection).toBe('fork')
    }
    await v3.rebuild(store, 'parent', { plan: v3.planAll })
    await v3.rebuild(store, 'fork', { plan: (groups) => [groups.slice(1)] })
    await checkReads(store, 'parent', parent, rand)
    await checkReads(store, 'fork', fork, rand)
    await v3.verifyLog(store, 'fork', { lineage: [['parent', 5]] })
    // A fork of the fork carries both ancestors.
    const second = await v3.forkCollection(store, 'fork', 'fork2')
    expect(second.description.lineage).toEqual([
      ['parent', 5],
      ['fork', 8],
    ])
    await v3.verifyLog(store, 'fork2', { lineage: second.description.lineage! })
    await checkReads(store, 'fork2', fork, rand, { versions: [5, 8] })
  })

  it('forks at an older commit only if no rebuilt file holds later rows', async () => {
    const store = memoryStore()
    const { model, rand } = await seeded(store, 'parent', 4, 6)
    await v3.rebuild(store, 'parent', { plan: (groups) => [groups.slice(0, 3)], adoptAfter: 99 })
    // The layout goes through commit 6 (it lists the later commits' files too).
    await expect(v3.forkCollection(store, 'parent', 'early', { at: 4 })).rejects.toThrow(
      /at commit 6 or later/,
    )
    const none = memoryStore()
    const m2 = await seeded(none, 'p', 4, 6)
    await v3.forkCollection(none, 'p', 'early', { at: 4 })
    await checkReads(none, 'early', cloneModel(m2.model, 4), m2.rand)
    expect((await v3.openView(none, 'early')).head).toBe(4)
    await expect(v3.forkCollection(none, 'p', 'x', { at: 7 })).rejects.toThrow(/no commit 7/)
    await checkReads(store, 'parent', model, rand)
  })
})

describe('storage accounting', () => {
  it('counts a shared file once for the location and once for each collection listing it', async () => {
    const store = memoryStore()
    await seeded(store, 'a', 5, 5)
    await v3.rebuild(store, 'a', { plan: v3.planAll })
    await v3.forkCollection(store, 'a', 'b')
    await commitRows(store, 'b', [line(rec('t', 'only-b', 1))])
    const a = await v3.collectionStats(store, 'a')
    const b = await v3.collectionStats(store, 'b')
    expect(a).toMatchObject({ head: 5, layout: 1, files: 1 })
    expect(b).toMatchObject({ head: 6, layout: 1, files: 2 })
    expect(b.storedBytes).toBeGreaterThan(a.storedBytes)
    const s = await v3.sweep(store, { now: () => 0 })
    expect(s.collections).toBe(2)
    expect(s.logical.get('a')).toEqual({ files: 1, bytes: a.storedBytes })
    expect(s.logical.get('b')).toEqual({ files: 2, bytes: b.storedBytes })
    // Physical: the shared file once, b's own file, and a's five originals not yet swept.
    expect(s.records.listed).toBe(2)
    expect(s.records.listedBytes).toBe(b.storedBytes)
    expect(s.records.listedBytes).toBeLessThan(a.storedBytes + b.storedBytes)
    expect(s.records.objects).toBe(7)
    expect(s.records.condemned).toBe(5)
  })
})

describe('the sweep', () => {
  it('condemns, then moves to trash after the grace period, then deletes', async () => {
    const store = memoryStore()
    const { model, rand } = await seeded(store, 'c', 6, 5)
    await v3.rebuild(store, 'c', { plan: v3.planAll })
    let t = 0
    const pass = () => v3.sweep(store, { now: () => t, graceMs: DAY, trashMs: 7 * DAY })
    const keys = async (prefix: string) => (await collect(listAll(store, prefix))).length

    const first = await pass()
    expect(first.records).toMatchObject({ objects: 6, listed: 1, condemned: 5, trashed: 0 })
    t += DAY - 1
    expect((await pass()).records).toMatchObject({ condemned: 5, trashed: 0 })
    t += 1
    const third = await pass()
    expect(third.records).toMatchObject({ objects: 1, condemned: 0, trashed: 5, inTrash: 5 })
    expect(third.records.trashedBytes).toBeGreaterThan(0)
    expect(await keys('records/')).toBe(1)
    expect(await keys('trash/records/')).toBe(5)
    await checkReads(store, 'c', model, rand)
    t += 7 * DAY - 1
    expect((await pass()).records).toMatchObject({ inTrash: 5, purged: 0 })
    t += 1
    const last = await pass()
    expect(last.records).toMatchObject({ inTrash: 0, purged: 5, objects: 1, listed: 1 })
    expect(last.records.purgedBytes).toBe(third.records.trashedBytes)
    expect(await keys('trash/')).toBe(0)
    expect(last.records.missing).toEqual([])
    await checkReads(store, 'c', model, rand)
    // The sweep keeps one ledger and no scratch.
    expect(await keys('tmp/')).toBe(0)
    expect(await collect(listAll(store, 'sweep/'))).toEqual(['sweep/ledger-00000005'])
  })

  it('reprieves a condemned file that is listed again, and restores one from trash', async () => {
    const store = memoryStore()
    await seeded(store, 'c', 7, 3)
    const orphan = await v3.buildFiles([rec('t', 'late', 1)], v3.storeTarget(store))
    const id = orphan[0]!.id
    let t = 0
    const pass = () => v3.sweep(store, { now: () => t, graceMs: DAY, trashMs: 7 * DAY })
    expect((await pass()).records.condemned).toBe(1)
    // A commit names it before the grace period is out: it is no longer condemned.
    const { size: _s, labeled: _l, commits: _c, ...ref } = orphan[0]!
    await v3.createCommit(store, 'c', { files: [ref], bump: 'minor' })
    t += 2 * DAY
    expect((await pass()).records).toMatchObject({ condemned: 0, trashed: 0, listed: 4 })

    // A file moved to trash that a collection lists (a fork that was slow to appear): it comes back.
    await store.put(`trash/records/${id}`, await (await store.get(`records/${id}`))!.bytes())
    await store.delete(`records/${id}`)
    const view = await v3.openView(store, 'c')
    // Until the next pass, a read finds it in trash.
    expect(dec.decode((await v3.getRecord(store, view, 't', 'late'))!.line!)).toContain('late')
    const back = await pass()
    expect(back.records).toMatchObject({ restored: 1, listed: 4, inTrash: 0 })
    expect(await store.head(`records/${id}`)).not.toBe(null)
    expect(await store.head(`trash/records/${id}`)).toBe(null)
  })

  it('reports a listed file that is nowhere, and deletes nothing because of it', async () => {
    const store = memoryStore()
    await seeded(store, 'c', 8, 3)
    const [gone] = await collect(listAll(store, 'records/'))
    await store.delete(gone!)
    const s = await v3.sweep(store, { now: () => 0 })
    expect(s.records.missing).toEqual([gone])
    expect(s.records).toMatchObject({ listed: 2, condemned: 0 })
  })

  it('keeps assets that a listed file names and reclaims the rest', async () => {
    const store = memoryStore()
    const put = async (text: string) => {
      const hash = sha256Hex(text)
      await store.put(`assets/${hash}`, text)
      return hash
    }
    const [a, b, c] = [await put('asset a'), await put('asset b'), await put('asset c')]
    const asset = (hash: string) => rec('$asset', hash, { size: 7, mediaType: null })
    await commitRows(
      store,
      'x',
      [line(asset(a)), line(asset(b)), line(rec('t', '1', 1))].sort(v3.compareKey),
    )
    // `b` is removed from x, but an older version still lists it: it stays.
    await commitRows(store, 'x', [line(rem('$asset', b))])
    await commitRows(store, 'y', [line(asset(b))])
    expect((await collect(v3.listedAssets(store, 'x'))).map((r) => r.hash)).toEqual([a])
    expect(
      (await collect(v3.listedAssets(store, 'x', { version: 1 }))).map((r) => r.hash).sort(),
    ).toEqual([a, b].sort())
    let t = 0
    const pass = () => v3.sweep(store, { now: () => t, graceMs: DAY, trashMs: DAY })
    const first = await pass()
    expect(first.assets).toMatchObject({ objects: 3, listed: 2, condemned: 1 })
    t += DAY
    expect((await pass()).assets).toMatchObject({ objects: 2, trashed: 1 })
    expect(await store.head(`assets/${c}`)).toBe(null)
    // Deleting x leaves `b` listed by y, and `a` by nothing.
    await v3.deleteCollection(store, 'x')
    t += DAY
    await pass()
    t += DAY
    const last = await pass()
    expect(last.assets).toMatchObject({ objects: 1, listed: 1 })
    expect(await store.head(`assets/${b}`)).not.toBe(null)
    expect(await store.head(`assets/${a}`)).toBe(null)
  })

  it('reclaims a deleted collection but not what a fork still lists', async () => {
    const store = memoryStore()
    const { model, rand } = await seeded(store, 'parent', 9, 5)
    await v3.rebuild(store, 'parent', { plan: v3.planAll })
    await v3.forkCollection(store, 'parent', 'fork')
    await commitRows(store, 'parent', [line(rec('t', 'parent-only', 1))])
    let t = 0
    const pass = () => v3.sweep(store, { now: () => t, graceMs: HOUR, trashMs: HOUR })
    await pass()
    await v3.deleteCollection(store, 'parent')
    for (let i = 0; i < 4; i++) {
      t += HOUR
      await pass()
    }
    const left = await collect(listAll(store, 'records/'))
    expect(left.length).toBe(1)
    expect(await collect(listAll(store, 'trash/'))).toEqual([])
    await checkReads(store, 'fork', model, rand)
  })

  it('gives the same answer when its sort has to spill', async () => {
    const store = memoryStore()
    for (let i = 0; i < 40; i++) await seeded(store, `c${String(i).padStart(2, '0')}`, 100 + i, 3)
    const roomy = await v3.sweep(store, { now: () => 0 })
    const tight = await v3.sweep(store, { now: () => 0, memoryBytes: 2000, concurrency: 3 })
    expect(tight.collections).toBe(40)
    expect(tight.records).toEqual(roomy.records)
    expect([...tight.logical]).toEqual([...roomy.logical])
    expect((await collect(listAll(store, 'tmp/'))).length).toBe(0)
  })
})

/** A store whose calls yield a varying number of turns first, so concurrent jobs interleave. */
function interleaving(inner: MemoryStore, rand: () => number): Store {
  const hop = async () => {
    for (let n = Math.floor(rand() * 4); n > 0; n--) await new Promise((r) => setImmediate(r))
  }
  return {
    get: async (k, r) => (await hop(), inner.get(k, r)),
    head: async (k) => (await hop(), inner.head(k)),
    put: async (k, b, o) => (await hop(), inner.put(k, b, o)),
    create: async (k, b, o) => (await hop(), inner.create(k, b, o)),
    list: async (p, c) => (await hop(), inner.list(p, c)),
    delete: async (k) => (await hop(), inner.delete(k)),
    copy: async (f, t) => (await hop(), inner.copy(f, t)),
  }
}

describe('the sweep under concurrent work (randomized)', () => {
  it('never loses a file that a collection lists', async () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rand = rng(seed * 31)
      const inner = memoryStore()
      const store = interleaving(inner, rand)
      const alive = new Map<string, Model>()
      let made = 0
      let t = 0
      const grace = HOUR
      const fresh = () => `c${String(made++).padStart(3, '0')}`
      const first = fresh()
      alive.set(first, (await seeded(store, first, seed, 2)).model)

      /** Every file an alive collection lists is in the folder, or in trash on its way back. */
      const listedAreSafe = async (strict: boolean) => {
        for (const id of alive.keys()) {
          const { files } = await v3.currentFiles(inner, id)
          for (const f of files) {
            const kept = await inner.head(v3.recordKey(f.id))
            const trashed = await inner.head(`trash/${v3.recordKey(f.id)}`)
            expect(kept ?? trashed, `seed ${seed}: ${id} lists ${f.id}`).not.toBe(null)
            if (strict) expect(kept, `seed ${seed}: ${id} lists ${f.id}`).not.toBe(null)
          }
        }
      }

      for (let round = 0; round < 10; round++) {
        const jobs: Promise<unknown>[] = []
        const busy = new Set<string>()
        const pick = () => {
          const free = [...alive.keys()].filter((id) => !busy.has(id))
          return free[Math.floor(rand() * free.length)]
        }
        for (let n = 2 + Math.floor(rand() * 4); n > 0; n--) {
          const id = pick()
          if (!id) break
          const roll = rand()
          if (roll < 0.4) {
            busy.add(id)
            const rows = randomUpload(rand)
            alive.get(id)!.add(rows)
            jobs.push(commitRows(store, id, rows))
          } else if (roll < 0.65) {
            busy.add(id)
            jobs.push(
              v3.rebuild(store, id, {
                ...(rand() < 0.5 ? { plan: v3.planAll } : {}),
                tiers: { ratio: 2, baseBytes: 1500 },
                adoptAfter: 1,
              }),
            )
          } else if (roll < 0.85) {
            // A fork of a collection that may be committing or rebuilding at the same time.
            const fork = fresh()
            const parent = alive.get(id)!
            jobs.push(
              v3.forkCollection(store, id, fork).then(
                (f) => {
                  alive.set(fork, cloneModel(parent, f.description.forkedFrom!.commit))
                },
                (err) => {
                  // Its parent was deleted under it: the fork fails whole and leaves nothing.
                  if (!(err instanceof v3.CollectionError) || alive.has(id)) throw err
                },
              ),
            )
          } else if (alive.size > 1) {
            busy.add(id)
            alive.delete(id)
            jobs.push(v3.deleteCollection(store, id))
          }
        }
        jobs.push(v3.sweep(store, { now: () => t, graceMs: grace, trashMs: grace, concurrency: 3 }))
        const settled = await Promise.allSettled(jobs)
        for (const s of settled) if (s.status === 'rejected') throw s.reason
        await listedAreSafe(false)
        t += [0, grace / 2, grace, 2 * grace][Math.floor(rand() * 4)]!
      }

      // Quiet now: a pass puts back anything in trash that is listed, and everything reads.
      t += grace
      const quiet = await v3.sweep(inner, { now: () => t, graceMs: grace, trashMs: grace })
      expect(quiet.records.missing, `seed ${seed}`).toEqual([])
      await listedAreSafe(true)
      for (const [id, model] of alive) {
        await checkReads(inner, id, model, rand, {
          versions: [model.head],
          keys: model.allKeys().slice(0, 8),
        })
      }
      // With time, everything unlisted goes, and nothing else.
      for (let i = 0; i < 4; i++) {
        t += grace
        await v3.sweep(inner, { now: () => t, graceMs: grace, trashMs: grace })
      }
      const listed = new Set<string>()
      for (const id of alive.keys()) {
        for (const f of (await v3.currentFiles(inner, id)).files) listed.add(v3.recordKey(f.id))
      }
      expect(new Set(await collect(listAll(inner, 'records/'))), `seed ${seed}`).toEqual(listed)
      expect(await collect(listAll(inner, 'trash/'))).toEqual([])
    }
  }, 300_000)
})
