import { createHash } from 'node:crypto'

import {
  boundaryBytes,
  recordTree,
  RepoSource,
  trailingZeros,
  verifyTree,
} from '@underlay/protocol'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

import * as schema from '../src/db/schema.js'
import { assembleParallel, parallelConfig } from '../src/push/parallel.js'
import { isMark } from '../src/push/runs.js'
import { cleanup, type Harness, harness } from './harness.js'

afterAll(cleanup)
const defaults = { ...parallelConfig }
afterEach(() => Object.assign(parallelConfig, defaults))

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
      ? { above: 0, unitEntries: 400, baseLevel: 0, ...(parallel === true ? {} : parallel) }
      : { above: Infinity },
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
    const pa = await push(h, user, pathA, {}, second, deletes, { unitEntries: 1 })
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
    Object.assign(parallelConfig, { above: 0, unitEntries: 1, baseLevel: 0 })
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

  it('stays serial when a type changes schema', async () => {
    const h = await harness()
    const user = await h.member()
    await h.collection('pc')
    const path = '/api/collections/org/pc'
    const batch = [Array.from({ length: 50 }, (_, i) => rec(`x${i}`, `n${i}`))]
    await push(h, user, path, { schemas: { Author } }, batch, [], false)
    const Author2 = {
      ...Author,
      properties: { name: { type: 'string' }, born: { type: 'integer' } },
    }
    Object.assign(parallelConfig, { above: 0 })
    const res = await h.request(`${path}/push`, {
      method: 'POST',
      user,
      json: { schemas: { Author: Author2 } },
    })
    const sid = ((await res.json()) as { session_id: string }).session_id
    await h.request(`${path}/push/${sid}/records`, { method: 'POST', user, ndjson: batch[0]! })
    const commit = await h.request(`${path}/push/${sid}/commit`, { method: 'POST', user })
    expect(commit.status).toBe(201)
  })
})

// Keep the helper honest: marks are natural leaf boundaries.
it('marks are natural boundaries', () => {
  for (const k of markIds('q', 3))
    expect(trailingZeros(boundaryBytes(k))).toBeGreaterThanOrEqual(13)
})
