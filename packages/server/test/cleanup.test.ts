import { createHash } from 'node:crypto'

import { fsck } from '@underlay/protocol'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { cleanupConfig, getRun } from '../src/cleanup/config.js'
import {
  closeWindow,
  FenceError,
  fenceConfig,
  openWindow,
  writeFence,
} from '../src/cleanup/fence.js'
import { cleanInternal } from '../src/cleanup/internal.js'
import { startRun } from '../src/cleanup/runs.js'
import * as schema from '../src/db/schema.js'
import { startUpload } from '../src/files/files.js'
import { commitVersion } from '../src/versions/commit.js'
import { cleanup, type Harness, harness } from './harness.js'

afterAll(cleanup)

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const Doc = { type: 'object', properties: { title: { type: 'string' }, pdf: { type: 'object' } } }
const DAY = 24 * 60 * 60 * 1000

beforeEach(() => {
  fenceConfig.slackMs = 50
  fenceConfig.pollMs = 10
})

/** Push records (and a file) to org/<slug>; returns the session id. */
async function push(h: Harness, user: string, slug: string, records: unknown[], file?: string) {
  const base = `/api/collections/org/${slug}`
  if (file) {
    const put = await h.request(`${base}/files/${sha(file)}`, { method: 'PUT', user, body: file })
    expect(put.status).toBeLessThan(300)
  }
  const open = await h.request(`${base}/push`, { method: 'POST', user, json: { schemas: { Doc } } })
  const sid = ((await open.json()) as { session_id: string }).session_id
  await h.request(`${base}/push/${sid}/records`, { method: 'POST', user, ndjson: records })
  const commit = await h.request(`${base}/push/${sid}/commit`, { method: 'POST', user })
  expect(commit.status).toBe(201)
  return sid
}

const docs = (prefix: string, n: number, file?: string) =>
  Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i}`,
    type: 'Doc',
    data: {
      title: `${prefix} ${i}`,
      ...(file && i === 0 ? { pdf: { $file: `sha256:${sha(file)}` } } : {}),
    },
  }))

/** Make every object in the bucket look old enough to sweep. */
function ageAll(h: Harness, ms = 3 * DAY) {
  for (const o of h.bucket.objects.values()) o.modified = Date.now() - ms
}

/** Backdate every tombstone past the grace period. */
async function pastGrace(h: Harness) {
  await h.ports.db
    .update(schema.collectionTombstones)
    .set({ deletedAt: new Date(Date.now() - cleanupConfig.tombstoneGraceMs - DAY) })
}

async function run(h: Harness, step: schema.CleanupStep, opts: { dryRun?: boolean } = {}) {
  const r = await startRun(h.ports, step, { trigger: 'manual', ...opts })
  await h.drain()
  return (await getRun(h.ports.db, r.id))!
}

const keys = (h: Harness, part: string) =>
  [...h.bucket.objects.keys()].filter((k) => k.includes(part))

async function healthy(h: Harness, collectionId: string) {
  const repo = await h.ports.stores.forCollection(collectionId)
  const report = await fsck(repo, {
    collectionId,
    trustedKeys: [h.signer.publicKey],
    fileBytes: true,
  })
  expect(report.errors).toEqual([])
  return report
}

describe('storage cleanup, step 1: sessions and uploads', () => {
  it('deletes finished sessions past their grace, and abandoned uploads', async () => {
    const h = await harness()
    const user = await h.member()
    const c = await h.collection('a')
    const done = await push(h, user, 'a', docs('d', 5))
    // An open session, untouched.
    const open = await h.request('/api/collections/org/a/push', {
      method: 'POST',
      user,
      json: { schemas: { Doc } },
    })
    const openId = ((await open.json()) as { session_id: string }).session_id
    expect(keys(h, `sessions/${done}/`).length).toBeGreaterThan(0)
    expect(keys(h, `sessions/${openId}/`).length).toBeGreaterThan(0)

    // Within the grace period nothing goes.
    expect((await cleanInternal(h.ports)).stats.deleted).toEqual({})
    await h.ports.db
      .update(schema.pushSessions)
      .set({ expiresAt: new Date(Date.now() - 2 * DAY) })
      .where(eq(schema.pushSessions.id, done))

    // A direct upload nobody completed.
    const ticket = await startUpload(h.ports, c.id, {
      hash: sha('never'),
      size: 5,
      mimeType: 'text/plain',
    })
    const [upload] = await h.ports.db
      .select()
      .from(schema.fileUploads)
      .where(eq(schema.fileUploads.id, ticket.id))
    await h.bucket.put(upload!.storageKey, 'never')
    await h.ports.db
      .update(schema.fileUploads)
      .set({ createdAt: new Date(Date.now() - 2 * DAY) })
      .where(eq(schema.fileUploads.id, ticket.id))

    // A dry run counts and leaves everything.
    const dry = await run(h, 'internal', { dryRun: true })
    expect(dry.stats!.deleted.sessions!.objects).toBeGreaterThan(0)
    expect(dry.stats!.deleted.uploads).toEqual({ objects: 1, bytes: 5 })
    expect(keys(h, `sessions/${done}/`).length).toBeGreaterThan(0)

    const r = await cleanInternal(h.ports)
    expect(r.done).toBe(true)
    expect(r.stats.deleted.sessions!.objects).toBeGreaterThan(0)
    expect(keys(h, `sessions/${done}/`)).toEqual([])
    expect(keys(h, `sessions/${openId}/`).length).toBeGreaterThan(0)
    expect(h.bucket.objects.has(upload!.storageKey)).toBe(false)
    const [s] = await h.ports.db
      .select()
      .from(schema.pushSessions)
      .where(eq(schema.pushSessions.id, done))
    expect(s!.cleanedAt).not.toBeNull()
    expect(
      await h.ports.db.select().from(schema.pushRuns).where(eq(schema.pushRuns.sessionId, done)),
    ).toEqual([])
    const [u] = await h.ports.db
      .select()
      .from(schema.fileUploads)
      .where(eq(schema.fileUploads.id, ticket.id))
    expect(u!.status).toBe('failed')
    // Nothing left to do.
    expect((await cleanInternal(h.ports)).stats.deleted).toEqual({})
  })
})

describe('storage cleanup, steps 2 and 3: mark and sweep', () => {
  it("frees a deleted collection's objects after its grace, and keeps what others share", async () => {
    const h = await harness()
    const user = await h.member()
    const a = await h.collection('a')
    await h.collection('c')
    await push(h, user, 'a', docs('a', 50, 'shared pdf'), 'shared pdf')
    // b is a fork of a: it shares a's trees outright.
    const fork = await h.request('/api/collections/org/a/fork', {
      method: 'POST',
      user,
      json: { targetOrg: 'org', slug: 'forked' },
    })
    expect(fork.status).toBeLessThan(300)
    const [b] = await h.ports.db
      .select()
      .from(schema.collections)
      .where(eq(schema.collections.slug, 'forked'))
    const cSession = await push(h, user, 'c', docs('c', 40, 'only c'), 'only c')
    const [cRow] = await h.ports.db
      .select()
      .from(schema.collections)
      .where(eq(schema.collections.slug, 'c'))
    expect(cSession).toBeTruthy()
    for (const slug of ['a', 'c']) {
      const del = await h.request(`/api/collections/org/${slug}`, { method: 'DELETE', user })
      expect(del.status).toBe(200)
    }
    ageAll(h)
    const before = h.bucket.objects.size
    const fileRows = async () =>
      (await h.ports.db.select({ hash: schema.files.hash }).from(schema.files)).map((f) => f.hash)
    expect((await fileRows()).sort()).toEqual([sha('only c'), sha('shared pdf')].sort())

    // In the grace period: nothing of a or c goes.
    const mark1 = await run(h, 'mark')
    expect(mark1.status).toBe('done')
    expect(mark1.stats!.collections).toBe(3) // b live; a and c from their logs
    const sweep1 = await run(h, 'sweep')
    expect(sweep1.status).toBe('done')
    expect(sweep1.stats!.deleted.files).toBeUndefined()
    expect(sweep1.stats!.deleted.roots).toBeUndefined()
    expect(sweep1.stats!.deleted.collections).toBeUndefined()
    expect(h.bucket.objects.has(`repo/files/${sha('only c')}`)).toBe(true)
    // Every version a deleted collection's log names still checks out in full. (Its
    // derived trees, file reference counts and the cumulative public files tree,
    // aren't kept: a restore rebuilds them.)
    const platform = await h.ports.stores.forLocation(schema.PLATFORM_LOCATION_ID)
    for (const id of [a.id, cRow!.id]) {
      const report = await fsck(platform, {
        collectionId: id,
        trustedKeys: [h.signer.publicKey],
        fileBytes: true,
      })
      expect(report.errors).toEqual([])
    }

    // Past it: a dry run counts, and deletes nothing.
    await pastGrace(h)
    await run(h, 'mark')
    const dry = await run(h, 'sweep', { dryRun: true })
    expect(dry.stats!.deleted.files).toMatchObject({ objects: 1 })
    expect(dry.stats!.deleted.nodes!.objects).toBeGreaterThan(0)
    expect(dry.stats!.deleted.collections!.objects).toBeGreaterThan(0)
    expect(dry.stats!.windows).toBe(0)
    expect(h.bucket.objects.has(`repo/files/${sha('only c')}`)).toBe(true)

    // The real sweep: c's own objects and file go; what b reaches stays.
    const sweep = await run(h, 'sweep')
    expect(sweep.status).toBe('done')
    expect(sweep.stats!.windows).toBeGreaterThan(0)
    expect(sweep.stats!.deleted.files).toMatchObject({ objects: 1 })
    expect(h.bucket.objects.has(`repo/files/${sha('only c')}`)).toBe(false)
    expect(h.bucket.objects.has(`repo/files/${sha('shared pdf')}`)).toBe(true)
    expect(await fileRows()).toEqual([sha('shared pdf')])
    expect(keys(h, `repo/collections/${cRow!.id}/`)).toEqual([])
    expect(keys(h, `repo/collections/${a.id}/`)).toEqual([])
    expect(h.bucket.objects.size).toBeLessThan(before)
    await healthy(h, b!.id)
    const read = await h.request('/api/collections/org/forked/versions/1/records.ndjson', { user })
    expect(read.status).toBe(200)
    expect((await read.text()).trim().split('\n')).toHaveLength(50)

    // Schemas are never swept; unknown shapes are counted and kept.
    expect(keys(h, 'repo/schemas/').length).toBeGreaterThan(0)
    await h.bucket.put('repo/nodes/not-a-hash', 'x')
    ageAll(h)
    await run(h, 'mark')
    const again = await run(h, 'sweep')
    expect(again.stats!.unknown).toBeGreaterThan(0)
    expect(h.bucket.objects.has('repo/nodes/not-a-hash')).toBe(true)
    expect(again.stats!.deleted.nodes).toBeUndefined()
  })

  it("keeps a deleted collection's leftovers that a later push reuses", async () => {
    const h = await harness()
    const user = await h.member()
    await h.collection('old')
    const records = docs('r', 30, 'the pdf')
    await push(h, user, 'old', records, 'the pdf')
    expect((await h.request('/api/collections/org/old', { method: 'DELETE', user })).status).toBe(
      200,
    )
    await pastGrace(h)
    // The mark runs while nothing uses old's objects.
    const mark = await run(h, 'mark')
    expect(mark.status).toBe('done')

    // Then a new collection pushes the same records and file: writers skip the
    // nodes, bodies and bytes that are already there.
    const fresh = await h.collection('new')
    const puts = h.bucket.puts
    await push(h, user, 'new', records, 'the pdf')
    expect(h.bucket.puts - puts).toBeLessThan(15) // mostly reused
    ageAll(h)

    const sweep = await run(h, 'sweep')
    expect(sweep.status).toBe('done')
    await healthy(h, fresh.id)
    expect(h.bucket.objects.has(`repo/files/${sha('the pdf')}`)).toBe(true)
  })

  it('waits while a push is committing', async () => {
    const h = await harness()
    const user = await h.member()
    await h.collection('gone')
    await push(h, user, 'gone', docs('g', 10))
    await h.request('/api/collections/org/gone', { method: 'DELETE', user })
    await pastGrace(h)
    const c = await h.collection('busy')
    const [session] = await h.ports.db
      .insert(schema.pushSessions)
      .values({
        collectionId: c.id,
        userId: user,
        kind: 'delta',
        status: 'committing',
        finalizeStartedAt: new Date(),
        expiresAt: new Date(Date.now() + DAY),
      })
      .returning()
    ageAll(h)
    await run(h, 'mark')
    const nodes = keys(h, 'repo/nodes/').length
    const waiting = await run(h, 'sweep')
    expect(waiting.status).toBe('waiting')
    expect(keys(h, 'repo/nodes/').length).toBe(nodes)

    await h.ports.db
      .update(schema.pushSessions)
      .set({ status: 'failed' })
      .where(eq(schema.pushSessions.id, session!.id))
    await h.ports.db.update(schema.jobs).set({ runAt: new Date() })
    await h.drain()
    const done = (await getRun(h.ports.db, waiting.id))!
    expect(done.status).toBe('done')
    expect(keys(h, 'repo/nodes/').length).toBeLessThan(nodes)
  })
})

describe('the write fence', () => {
  it('makes a write phase that spans a deletion window redo', async () => {
    const h = await harness()
    const user = await h.member()
    const c = await h.collection('m')
    await push(h, user, 'm', docs('m', 3))
    const stale = await writeFence(h.ports.db)
    const w = (await openWindow(h.ports.db, 'test', 10_000))!
    expect(w.epoch).toBe(stale + 1)
    // A second window can't open over it.
    expect(await openWindow(h.ports.db, 'other', 10_000)).toBeNull()
    await closeWindow(h.ports.db, w)

    // A commit whose writes began before the window can't publish.
    const [v] = await h.ports.db
      .select()
      .from(schema.versions)
      .where(eq(schema.versions.collectionId, c.id))
    await expect(
      commitVersion(h.ports, {
        collectionId: c.id,
        fence: stale,
        base: v!,
        types: [],
        metadata: { title: 'x' },
      }),
    ).rejects.toBeInstanceOf(FenceError)
    // The metadata route redoes its write under a fresh fence.
    const meta = await h.request('/api/collections/org/m/metadata', {
      method: 'POST',
      user,
      json: { title: 'After' },
    })
    expect(meta.status).toBe(201)
  })

  it('holds writers while a window is open', async () => {
    const h = await harness()
    const w = (await openWindow(h.ports.db, 'test', 80))!
    const t = Date.now()
    const epoch = await writeFence(h.ports.db)
    // Waited out the window (80 ms) and its slack (50 ms).
    expect(Date.now() - t).toBeGreaterThanOrEqual(100)
    expect(epoch).toBe(w.epoch)
    await closeWindow(h.ports.db, w)
    expect(await writeFence(h.ports.db)).toBe(w.epoch + 1)
  })

  it('puts back a file the sweep deleted when an upload reuses it', async () => {
    const h = await harness()
    const user = await h.member()
    await h.collection('f')
    const bytes = 'reused bytes'
    // A files row whose bytes the sweep deleted (rows first, then bytes, so
    // this only happens to a writer that read the row before the window).
    await h.request(`/api/collections/org/f/files/${sha(bytes)}`, {
      method: 'PUT',
      user,
      body: bytes,
    })
    const key = `repo/files/${sha(bytes)}`
    expect(h.bucket.objects.has(key)).toBe(true)
    await h.ports.db.delete(schema.files).where(eq(schema.files.hash, sha(bytes)))
    h.bucket.objects.delete(key)
    await h.request(`/api/collections/org/f/files/${sha(bytes)}`, {
      method: 'PUT',
      user,
      body: bytes,
    })
    expect(h.bucket.objects.has(key)).toBe(true)
    const [row] = await h.ports.db
      .select({ n: sql<number>`count(*)` })
      .from(schema.files)
      .where(eq(schema.files.hash, sha(bytes)))
    expect(row!.n).toBe(1)
  })
})

describe('cleanup for stewards', () => {
  it('lists runs, starts them, and switches the weekly run', async () => {
    const { setup } = await import('./kf-app.js')
    const { h, call, user } = await setup()
    await user('u1')
    await user('u2')
    expect((await call('/api/admin/cleanup', { user: 'u2' })).status).toBe(403)
    const start = await call('/api/admin/cleanup/runs', {
      method: 'POST',
      user: 'u1',
      json: { step: 'internal', dryRun: true },
    })
    expect(start.status).toBe(202)
    // No mark yet, so no sweep.
    const sweep = await call('/api/admin/cleanup/runs', {
      method: 'POST',
      user: 'u1',
      json: { step: 'sweep' },
    })
    expect(sweep.status).toBe(409)
    await h.drain()
    const auto = await call('/api/admin/cleanup/auto', {
      method: 'PUT',
      user: 'u1',
      json: { enabled: true },
    })
    expect(auto.status).toBe(200)
    const page = (await (await call('/api/admin/cleanup', { user: 'u1' })).json()) as {
      runs: { step: string; status: string; dryRun: boolean }[]
      auto: boolean
      fence: { windowOpen: boolean }
    }
    expect(page.auto).toBe(true)
    expect(page.fence.windowOpen).toBe(false)
    expect(page.runs[0]).toMatchObject({ step: 'internal', status: 'done', dryRun: true })
  })
})
