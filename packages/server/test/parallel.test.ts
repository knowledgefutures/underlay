import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'

import {
  boundaryBytes,
  iterate,
  recordTree,
  RepoSource,
  trailingZeros,
  verifyTree,
} from '@underlay/protocol'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

import * as schema from '../src/db/schema.js'
import { drainSqliteJobs } from '../src/jobs.js'
import {
  assemblyLimits,
  assembleParallel,
  parallelConfig,
  unitLimits,
} from '../src/push/parallel.js'
import { isMark } from '../src/push/runs.js'
import { cleanup, type Harness, harness } from './harness.js'

afterAll(cleanup)
const defaults = { ...parallelConfig }
const unitDefaults = { ...unitLimits }
const assemblyDefaults = { ...assemblyLimits }
afterEach(() => {
  Object.assign(parallelConfig, defaults)
  Object.assign(unitLimits, unitDefaults)
  Object.assign(assemblyLimits, assemblyDefaults)
})

const Author = {
  type: 'object',
  properties: { name: { type: 'string' }, pic: { type: 'object' } },
  required: ['name'],
}
const rec = (id: string, name: string, extra: Record<string, unknown> = {}) => {
  const { pic, ...rest } = extra
  return {
    id,
    type: 'Author',
    data: { name, ...(pic ? { pic: { $file: `sha256:${sha(String(pic))}` } } : {}) },
    ...rest,
  }
}
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

/** Ids that are run marks (split-key candidates), found by search. */
function markIds(prefix: string, n: number): string[] {
  const out: string[] = []
  for (let i = 0; out.length < n; i++) if (isMark(`${prefix}${i}`)) out.push(`${prefix}${i}`)
  return out
}

/** One delta push: upload in batches, commit, and wait for the jobs a parallel commit queues. */
async function push(
  h: Harness,
  user: string,
  base: string,
  open: Record<string, unknown>,
  upserts: unknown[][],
  deletes: string[][],
  parallel: boolean | Partial<typeof parallelConfig>,
) {
  const res = await h.request(`${base}/push`, { method: 'POST', user, json: open })
  expect(res.status).toBe(200)
  const sid = ((await res.json()) as { session_id: string }).session_id
  for (const batch of upserts) {
    const r = await h.request(`${base}/push/${sid}/records`, {
      method: 'POST',
      user,
      ndjson: batch,
    })
    expect(r.status).toBe(200)
  }
  for (const batch of deletes) {
    const r = await h.request(`${base}/push/${sid}/deletes`, {
      method: 'POST',
      user,
      ndjson: batch.map((id) => ({ type: 'Author', id })),
    })
    expect(r.status).toBe(200)
  }
  Object.assign(
    parallelConfig,
    parallel
      ? { aboveBytes: 0, unitBytes: 64_000, baseLevel: 0, ...(parallel === true ? {} : parallel) }
      : { aboveBytes: Infinity },
  )
  const commit = await h.request(`${base}/push/${sid}/commit`, { method: 'POST', user })
  expect(commit.status).toBe(parallel ? 202 : 201)
  await h.drain()
  const status = (await (await h.request(`${base}/push/${sid}`, { user })).json()) as {
    status: string
    result: Record<string, unknown>
  }
  expect(status.status).toBe('committed')
  return { sid, result: status.result }
}

async function trees(h: Harness, collectionId: string) {
  const [c] = await h.ports.db
    .select()
    .from(schema.collections)
    .where(eq(schema.collections.id, collectionId))
  const [v] = await h.ports.db
    .select()
    .from(schema.versions)
    .where(eq(schema.versions.id, c!.headVersionId!))
  const repo = await h.ports.stores.forCollection(collectionId)
  const root = await repo.root(v!.hash)
  const priv = root.private ? await repo.privateSet(root.private) : null
  const { root: pr, count: pc, bytes: pb } = root.public.types.Author!
  const p = priv?.types.Author
  return {
    repo,
    files: { public: root.public.files, private: priv?.files ?? null },
    version: { recordCount: v!.recordCount, changes: v!.changes, fileCount: v!.fileCount },
    public: { root: pr, count: pc, bytes: pb },
    private: p ? { root: p.root, count: p.count, bytes: p.bytes } : null,
  }
}

describe('parallel commit', () => {
  it('keeps at most a window of units on the queue, and still commits', async () => {
    const h = await harness()
    const user = await h.member()
    await h.collection('win')
    const path = '/api/collections/org/win'
    const m = markIds('w', 12)
    Object.assign(unitLimits, { perSession: 3, perAccount: 3 })
    Object.assign(parallelConfig, { aboveBytes: 0, unitBytes: 1 })
    const res = await h.request(`${path}/push`, {
      method: 'POST',
      user,
      json: { schemas: { Author } },
    })
    const sid = ((await res.json()) as { session_id: string }).session_id
    await h.request(`${path}/push/${sid}/records`, {
      method: 'POST',
      user,
      ndjson: [
        ...Array.from({ length: 300 }, (_, i) => rec(`r${i}`, `n${i}`)),
        ...m.map((k) => rec(k, k)),
      ],
    })
    expect((await h.request(`${path}/push/${sid}/commit`, { method: 'POST', user })).status).toBe(
      202,
    )
    const queuedUnits = async () =>
      (await h.ports.db.select().from(schema.jobs)).filter(
        (j) => j.type === 'commit.unit' && j.status !== 'failed',
      ).length
    let most = 0
    for (;;) {
      most = Math.max(most, await queuedUnits())
      if ((await drainSqliteJobs(h.ports, { max: 1 })) === 0) break
    }
    // Rows are written by the plan's chunk jobs, so they're counted after.
    const planned = await h.ports.db.select().from(schema.commitUnits)
    expect(planned.filter((u) => !u.gap).length).toBeGreaterThan(3)
    expect(most).toBeLessThanOrEqual(3)
    const status = (await (await h.request(`${path}/push/${sid}`, { user })).json()) as {
      status: string
    }
    expect(status.status).toBe('committed')
  })

  it("names a commit's records in layout F's index once a tree, not once a unit", async () => {
    // A unit's runs went in a pending object each: a 30M push left ~3,300, and a cold
    // isolate's first manifest read reads them all.
    const h = await harness({ newCollections: 'f' })
    const user = await h.member()
    const c = await h.collection('fh')
    const path = '/api/collections/org/fh'
    const id = (i: number) => `r${String(i).padStart(5, '0')}`
    const pending: string[] = []
    const put = h.bucket.put.bind(h.bucket)
    h.bucket.put = (key, body, opts) => {
      if (key.startsWith(`repo/runs/${c.id}/`) && key.includes('/manifest/f/pending/'))
        pending.push(key)
      return put(key, body, opts)
    }
    // Marks are where units can be cut: a dozen units.
    const m = markIds('fm', 12)
    const records = [
      ...Array.from({ length: 6000 }, (_, i) => rec(id(i), `n${i}`)),
      ...m.map((k) => rec(k, k)),
    ]
    const { sid } = await push(h, user, path, { schemas: { Author } }, [records], [], {
      unitBytes: 1,
    })
    h.bucket.put = put
    const units = await h.ports.db
      .select()
      .from(schema.commitUnits)
      .where(eq(schema.commitUnits.sessionId, sid))
    expect(units.filter((u) => !u.gap).length).toBeGreaterThan(4)
    // One type in one set: one object, however many units.
    expect(pending.length).toBe(1)
    const t = await trees(h, c.id)
    expect(t.public.count).toBe(6012)
    let n = 0
    for await (const e of iterate(
      new RepoSource(recordTree, t.repo, { set: 'public' }),
      t.public.root,
      {
        payloads: true,
      },
    ))
      if (e.body) n++
    expect(n).toBe(6012)
  })

  it('builds the same trees as the serial commit', async () => {
    const h = await harness()
    const user = await h.member()
    const a = await h.collection('pa')
    const b = await h.collection('pb')
    const pathA = '/api/collections/org/pa'
    const pathB = '/api/collections/org/pb'
    const m = markIds('m', 8)
    const id = (i: number) => `r${String(i).padStart(5, '0')}`
    const files = ['f1', 'f2', 'f3']
    for (const path of [pathA, pathB]) {
      for (const f of files) {
        const r = await h.request(`${path}/files/${sha(f)}`, { method: 'PUT', user, body: f })
        expect(r.status).toBe(201)
      }
    }

    // Push 1, no base: 12,000 records and the first five marks.
    const first = [
      Array.from({ length: 6000 }, (_, i) =>
        rec(id(i), `n${i}`, i % 1000 === 0 ? { pic: 'f1' } : {}),
      ),
      [
        ...Array.from({ length: 6000 }, (_, i) => rec(id(6000 + i), `n${6000 + i}`)),
        ...m.slice(0, 5).map((k) => rec(k, k)),
      ],
    ]
    await push(h, user, pathA, { schemas: { Author } }, first, [], true)
    await push(h, user, pathB, { schemas: { Author } }, first, [], false)
    expect(await trees(h, a.id).then((t) => t.public)).toEqual(
      await trees(h, b.id).then((t) => t.public),
    )

    // Push 2: a cluster of updates, scattered deletes, appends, a few records
    // made private, new marks (one added and then deleted in the same session),
    // and two base marks deleted. r03000–r09999 stays untouched: gaps.
    // Separate batches, so no run block spans the untouched region.
    const second = [
      [
        ...Array.from({ length: 300 }, (_, i) =>
          rec(id(1000 + i), `u${i}`, i % 50 === 1 ? { pic: 'f2' } : {}),
        ),
        ...m.slice(5).map((k) => rec(k, `${k}!`)),
      ],
      Array.from({ length: 50 }, (_, i) =>
        rec(id(10_000 + i), `p${i}`, { private: true, ...(i === 0 ? { pic: 'f3' } : {}) }),
      ),
      Array.from({ length: 2000 }, (_, i) => rec(`s${String(i).padStart(5, '0')}`, `s${i}`)),
    ]
    const deletes = [Array.from({ length: 40 }, (_, i) => id(10_500 + i * 13)), [m[3]!, m[6]!]]
    // One interval per unit, so every deleted candidate is some unit's `through`.
    const pa = await push(h, user, pathA, {}, second, deletes, { unitBytes: 1 })
    const pb = await push(h, user, pathB, {}, second, deletes, false)
    expect(pa.result.changes).toEqual(pb.result.changes)

    const ta = await trees(h, a.id)
    const tb = await trees(h, b.id)
    expect(ta.public).toEqual(tb.public)
    expect(ta.private).toEqual(tb.private)
    expect(ta.private?.count).toBe(50)
    expect(ta.version).toEqual(tb.version)
    expect(ta.files).toEqual(tb.files)
    // f1 is still public elsewhere, f2 entered the public set, f3 the private one.
    expect(ta.files.public.count).toBe(2)
    expect(ta.files.private?.count).toBe(1)
    const v = await verifyTree(new RepoSource(recordTree, ta.repo), ta.public.root!)
    expect(v.errors).toEqual([])

    // The plan had gaps, several units, and merged the units whose split key was deleted.
    const units = await h.ports.db
      .select()
      .from(schema.commitUnits)
      .where(eq(schema.commitUnits.sessionId, pa.sid))
    // A gap inside the untouched r03000–r09999.
    expect(
      units.some((u) => u.gap && u.after !== null && u.after > id(3000) && u.after < id(9999)),
    ).toBe(true)
    expect(units.filter((u) => !u.gap && u.status === 'done').length).toBeGreaterThan(3)
    expect(units.some((u) => u.status === 'superseded')).toBe(true)
  }, 30_000)

  it('builds the same trees as the serial commit when units split at base leaves', async () => {
    // Skewed record sizes, base level 1, and every level-1 node read for its leaves
    // (expandRatio 0), so units end at leaf boundaries that aren't run marks.
    const h = await harness()
    const user = await h.member()
    const a = await h.collection('la')
    const b = await h.collection('lb')
    const pathA = '/api/collections/org/la'
    const pathB = '/api/collections/org/lb'
    const id = (i: number) => `r${String(i).padStart(5, '0')}`
    const name = (i: number, v: string) => (i >= 4000 && i < 7000 ? v.repeat(400) : v)
    const first = [
      Array.from({ length: 6000 }, (_, i) => rec(id(i), name(i, `n${i}`))),
      Array.from({ length: 6000 }, (_, i) => rec(id(6000 + i), name(6000 + i, `n${6000 + i}`))),
    ]
    await push(h, user, pathA, { schemas: { Author } }, first, [], true)
    await push(h, user, pathB, { schemas: { Author } }, first, [], false)

    // Push 2: every 7th record updated, a few made private, scattered deletes.
    const second = [
      Array.from({ length: 12_000 / 7 }, (_, k) => {
        const i = k * 7
        return rec(id(i), name(i, `u${i}`), i % 700 === 0 ? { private: true } : {})
      }),
    ]
    const deletes = [Array.from({ length: 30 }, (_, k) => id(k * 397 + 3))]
    const pa = await push(h, user, pathA, {}, second, deletes, {
      unitBytes: 1,
      baseLevel: 1,
      expandRatio: 0,
    })
    const pb = await push(h, user, pathB, {}, second, deletes, false)
    expect(pa.result.changes).toEqual(pb.result.changes)

    const ta = await trees(h, a.id)
    const tb = await trees(h, b.id)
    expect(ta.public).toEqual(tb.public)
    expect(ta.private).toEqual(tb.private)
    expect(ta.version).toEqual(tb.version)
    expect(ta.files).toEqual(tb.files)
    const v = await verifyTree(new RepoSource(recordTree, ta.repo), ta.public.root!)
    expect(v.errors).toEqual([])

    // Some unit ended at a base leaf's last key that is no run mark.
    const units = await h.ports.db
      .select()
      .from(schema.commitUnits)
      .where(eq(schema.commitUnits.sessionId, pa.sid))
    const leafOnly = (k: string | null) => {
      if (k === null) return false
      const z = trailingZeros(boundaryBytes(k))
      return z >= 10 && z < 13
    }
    expect(units.some((u) => !u.gap && leafOnly(u.through))).toBe(true)
  }, 60_000)

  it('keeps large base records as pointers when units rewrite their leaves', async () => {
    // Pointers in leaf bodies: today's layout's (F keeps records out of leaves).
    const h = await harness({ newCollections: 'today' })
    const user = await h.member()
    const a = await h.collection('ka')
    const b = await h.collection('kb')
    const pathA = '/api/collections/org/ka'
    const pathB = '/api/collections/org/kb'
    for (const path of [pathA, pathB]) {
      const r = await h.request(`${path}/files/${sha('f1')}`, { method: 'PUT', user, body: 'f1' })
      expect(r.status).toBe(201)
    }
    const id = (i: number) => `r${String(i).padStart(5, '0')}`
    // Every 20th record is over OUT_OF_LINE_BYTES; every 40th of those references f1.
    const name = (i: number, v: string) => (i % 20 === 0 ? `${v}`.padEnd(70_000, 'x') : v)
    const record = (i: number, v: string) =>
      rec(id(i), name(i, v), i % 800 === 0 ? { pic: 'f1' } : {})
    // Batches of 200, under the records endpoint's body limit.
    const first = Array.from({ length: 15 }, (_, j) =>
      Array.from({ length: 200 }, (_, i) => record(j * 200 + i, `n${j * 200 + i}`)),
    )
    await push(h, user, pathA, { schemas: { Author } }, first, [], true)
    await push(h, user, pathB, { schemas: { Author } }, first, [], false)

    // Push 2 touches every leaf: small records updated, large ones deleted
    // (two of them referenced f1), and one large record updated.
    const second = [
      [...Array.from({ length: 60 }, (_, k) => record(k * 50 + 1, `u${k}`)), record(40, 'big!')],
    ]
    const deletes = [[id(0), id(800), id(1620)]]
    const parallel = { unitBytes: 1, baseLevel: 1, expandRatio: 0 }
    const pa = await push(h, user, pathA, {}, second, deletes, parallel)
    const pb = await push(h, user, pathB, {}, second, deletes, false)
    expect(pa.result.changes).toEqual(pb.result.changes)

    const ta = await trees(h, a.id)
    const tb = await trees(h, b.id)
    expect(ta.public).toEqual(tb.public)
    expect(ta.version).toEqual(tb.version)
    expect(ta.files).toEqual(tb.files)
    expect(ta.files.public.count).toBe(1) // id(1600) and id(2400) still reference f1
    const v = await verifyTree(new RepoSource(recordTree, ta.repo), ta.public.root!)
    expect(v.errors).toEqual([])

    // The longest line in any leaf body: units keep large base records as
    // pointers (they used to read each one and write it inline). Bodies are
    // shared by leaf hash and written once, so the serial commit, which still
    // resolves them, finds these already written: only the units' are checked.
    const longestLine = async (t: Awaited<ReturnType<typeof trees>>) => {
      let longest = 0
      const walk = async (hash: string): Promise<void> => {
        const node = await t.repo.decoded(recordTree, hash)
        if (node.kind === 'leaf') {
          const text = gunzipSync(await t.repo.rawBody(hash)).toString()
          for (const line of text.split('\n')) longest = Math.max(longest, line.length)
        } else for (const c of node.children) await walk(c.hash)
      }
      await walk(t.public.root!)
      return longest
    }
    expect(await longestLine(ta)).toBeLessThan(1000)
  }, 60_000)

  it('assembles one tree per invocation when out of time, and keeps the trees built', async () => {
    const h = await harness()
    const user = await h.member()
    const a = await h.collection('ra')
    const b = await h.collection('rb')
    const pathA = '/api/collections/org/ra'
    const pathB = '/api/collections/org/rb'
    for (const path of [pathA, pathB]) {
      const r = await h.request(`${path}/files/${sha('f1')}`, { method: 'PUT', user, body: 'f1' })
      expect(r.status).toBe(201)
    }
    const Paper = { type: 'object', properties: { title: { type: 'string' } } }
    const paper = (i: number) => ({ id: `p${i}`, type: 'Paper', data: { title: `t${i}` } })
    const batch = (from: number, n: number, v: string) => [
      ...Array.from({ length: n }, (_, i) =>
        rec(`a${from + i}`, `${v}${i}`, i % 100 === 0 ? { pic: 'f1' } : {}),
      ),
      ...Array.from({ length: n }, (_, i) => paper(from + i)),
      ...Array.from({ length: 20 }, (_, i) => rec(`q${from + i}`, v, { private: true })),
    ]
    await push(h, user, pathA, { schemas: { Author, Paper } }, [batch(0, 1000, 'n')], [], true)
    await push(h, user, pathB, { schemas: { Author, Paper } }, [batch(0, 1000, 'n')], [], false)

    // Every tree past the first is out of time: each assembly builds one tree,
    // then queues the next attempt, which takes the trees already built.
    assemblyLimits.budgetMs = -1
    const enqueue = vi.spyOn(h.ports.jobs, 'enqueue')
    const log = vi.spyOn(console, 'log')
    const pa = await push(h, user, pathA, {}, [batch(500, 1000, 'u')], [], { unitBytes: 1 })
    const built = log.mock.calls.filter((c) => String(c[0]).startsWith('[assemble]'))
    const assemblies = enqueue.mock.calls.filter((c) => c[0].type === 'commit.assemble')
    log.mockRestore()
    enqueue.mockRestore()
    const pb = await push(h, user, pathB, {}, [batch(500, 1000, 'u')], [], false)
    expect(pa.result.changes).toEqual(pb.result.changes)

    const heads = async (collectionId: string) => {
      const [c] = await h.ports.db
        .select()
        .from(schema.collections)
        .where(eq(schema.collections.id, collectionId))
      const [v] = await h.ports.db
        .select()
        .from(schema.versions)
        .where(eq(schema.versions.id, c!.headVersionId!))
      const repo = await h.ports.stores.forCollection(collectionId)
      const root = await repo.root(v!.hash)
      const priv = root.private ? await repo.privateSet(root.private) : null
      return {
        version: { recordCount: v!.recordCount, changes: v!.changes, fileCount: v!.fileCount },
        public: root.public,
        // The private set's salt is per collection; its trees and files aren't.
        private: priv ? { types: priv.types, files: priv.files } : null,
      }
    }
    const ha = await heads(a.id)
    expect(ha).toEqual(await heads(b.id))
    expect(Object.keys(ha.public.types).sort()).toEqual(['Author', 'Paper'])
    expect(ha.private?.types.Author?.count).toBe(40)

    // Four trees (each type, public and private), each built once, one per
    // assembly: the last unit's assembly and the three it and its successors queued.
    const names = built.map((c) => / (\w+\/\w+): /.exec(String(c[0]))![1])
    expect(names.sort()).toEqual([
      'Author/private',
      'Author/public',
      'Paper/private',
      'Paper/public',
    ])
    expect(assemblies.length).toBeGreaterThanOrEqual(4)
  }, 30_000)

  it('survives duplicate and early jobs', async () => {
    const h = await harness()
    const user = await h.member()
    const c = await h.collection('pd')
    const path = '/api/collections/org/pd'
    const open = await h.request(`${path}/push`, {
      method: 'POST',
      user,
      json: { schemas: { Author } },
    })
    const sid = ((await open.json()) as { session_id: string }).session_id
    const batch = [...markIds('d', 4), ...Array.from({ length: 3000 }, (_, i) => `x${i}`)]
    await h.request(`${path}/push/${sid}/records`, {
      method: 'POST',
      user,
      ndjson: batch.map((k) => rec(k, k)),
    })
    Object.assign(parallelConfig, { aboveBytes: 0, unitBytes: 1, baseLevel: 0 })
    expect((await h.request(`${path}/push/${sid}/commit`, { method: 'POST', user })).status).toBe(
      202,
    )
    // An assembly before any unit ran, and duplicate deliveries of both jobs.
    await assembleParallel(h.ports, sid)
    await h.ports.jobs.enqueue({ type: 'push.commit', sessionId: sid })
    await h.ports.jobs.enqueue({ type: 'commit.assemble', sessionId: sid })
    await h.drain()
    const [session] = await h.ports.db
      .select()
      .from(schema.pushSessions)
      .where(eq(schema.pushSessions.id, sid))
    expect(session!.status).toBe('committed')
    const versions = await h.ports.db
      .select()
      .from(schema.versions)
      .where(eq(schema.versions.collectionId, c.id))
    expect(versions.map((v) => v.recordCount)).toEqual([batch.length])
  })

  it('reopens a session refused for missing files, and plans again on the next commit', async () => {
    const h = await harness()
    const user = await h.member()
    const c = await h.collection('pm')
    const path = '/api/collections/org/pm'
    const open = await h.request(`${path}/push`, {
      method: 'POST',
      user,
      json: { schemas: { Author } },
    })
    const sid = ((await open.json()) as { session_id: string }).session_id
    const batch = [...markIds('m', 4), ...Array.from({ length: 1000 }, (_, i) => `x${i}`)]
    await h.request(`${path}/push/${sid}/records`, {
      method: 'POST',
      user,
      ndjson: [...batch.map((k) => rec(k, k)), rec('withpic', 'P', { pic: 'portrait' })],
    })
    Object.assign(parallelConfig, { aboveBytes: 0, unitBytes: 1, baseLevel: 0 })
    const commit = async () => {
      const res = await h.request(`${path}/push/${sid}/commit`, { method: 'POST', user })
      expect(res.status).toBe(202)
      await h.drain()
      return (await (await h.request(`${path}/push/${sid}`, { user })).json()) as Record<
        string,
        any
      >
    }
    let status = await commit()
    expect(status).toMatchObject({
      status: 'open',
      error: { error: 'Missing files', filesNeeded: [sha('portrait')] },
    })
    const [s] = await h.ports.db
      .select()
      .from(schema.pushSessions)
      .where(eq(schema.pushSessions.id, sid))
    expect(s!.commitPlan).toBeNull()

    // Upload the file, and one more record: the new plan covers it.
    await h.request(`${path}/files/${sha('portrait')}`, { method: 'PUT', user, body: 'portrait' })
    await h.request(`${path}/push/${sid}/records`, {
      method: 'POST',
      user,
      ndjson: [rec('late', 'L')],
    })
    status = await commit()
    expect(status).toMatchObject({ status: 'committed', error: null })
    const versions = await h.ports.db
      .select()
      .from(schema.versions)
      .where(eq(schema.versions.collectionId, c.id))
    expect(versions.map((v) => [v.recordCount, v.fileCount])).toEqual([[batch.length + 2, 1]])
  })
})

// Keep the helper honest: marks are natural leaf boundaries.
it('marks are natural boundaries', () => {
  for (const k of markIds('q', 3))
    expect(trailingZeros(boundaryBytes(k))).toBeGreaterThanOrEqual(13)
})
