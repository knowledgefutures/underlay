/**
 * A large push session's v3 commit built in key-range parts (v3/session-build.ts): the same
 * records and counts as a build in one job, on an empty collection and on a head it partly
 * changes; files its records reference; a lost part queued again by the sweep; and a part
 * that belongs to an earlier attempt doing nothing.
 */
import { createHash } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

import * as schema from '../src/db/schema.js'
import { drainSqliteJobs, runJob } from '../src/jobs.js'
import { recoverCommits, recoverConfig } from '../src/push/recover.js'
import { headView, lastRow, rowsOfType } from '../src/v3/catalog.js'
import { buildPart, sessionBuildConfig } from '../src/v3/session-build.js'
import { cleanup, type Harness, harness } from './harness.js'
import { onV3 } from './layouts.js'

afterAll(cleanup)
const defaults = { build: { ...sessionBuildConfig }, recover: { ...recoverConfig } }
afterEach(() => {
  Object.assign(sessionBuildConfig, defaults.build)
  Object.assign(recoverConfig, defaults.recover)
  vi.restoreAllMocks()
})

const Author = {
  type: 'object',
  properties: { name: { type: 'string' }, bio: { type: 'string' }, photo: { type: 'object' } },
  required: ['name'],
}
const Book = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] }
const schemas = { Author, Book }
const json = async (r: Response) => (await r.json()) as Record<string, any>
const sha = (b: string) => createHash('sha256').update(b).digest('hex')

const author = (i: number, name = `Author ${i}`) => ({
  id: `a${String(i).padStart(5, '0')}`,
  type: 'Author',
  data: { name, bio: 'x'.repeat(i % 40) },
})
const book = (i: number) => ({
  id: `b${String(i).padStart(5, '0')}`,
  type: 'Book',
  data: { title: `Book ${i}` },
})

async function setup(slug = 'lib') {
  const h = await harness({ newCollections: 'v3' })
  const user = await h.member()
  const c = await h.collection(slug, { recordLayout: 'v3' })
  return { h, user, c, base: `/api/collections/org/${slug}` }
}

/** Open a session and upload records in shuffled batches (overlapping runs); its id. */
async function upload(
  h: Harness,
  user: string,
  base: string,
  body: object,
  records: object[],
  batch = 300,
) {
  const opened = await h.request(`${base}/push`, { method: 'POST', user, json: body })
  expect(opened.status).toBe(200)
  const sid = (await json(opened)).session_id as string
  // Interleave the batches, so every run spans the whole key range.
  const stride = Math.ceil(records.length / batch)
  for (let s = 0; s < stride; s++) {
    const rows = records.filter((_, i) => i % stride === s)
    const r = await h.request(`${base}/push/${sid}/records`, { method: 'POST', user, ndjson: rows })
    expect(r.status).toBe(200)
  }
  return sid
}

const commit = (h: Harness, user: string, base: string, sid: string) =>
  h.request(`${base}/push/${sid}/commit`, { method: 'POST', user, json: { async: true } })

const status = async (h: Harness, user: string, base: string, sid: string) =>
  json(await h.request(`${base}/push/${sid}`, { user }))

/** Every record line of the head, by type. */
async function contents(h: Harness, collectionId: string) {
  const view = (await headView(h.ports.stores.v3, collectionId))!
  const out: Record<string, string[]> = {}
  for (const type of ['Author', 'Book']) {
    out[type] = []
    for await (const r of rowsOfType(h.ports.stores.v3, view, type, {}))
      out[type].push(new TextDecoder().decode(r.line!))
  }
  return { out, files: view.files.length }
}

/** The part events logged while `run` ran. */
async function partEvents(run: () => Promise<unknown>) {
  const events: Record<string, any>[] = []
  vi.spyOn(console, 'log').mockImplementation((e: any) => {
    if (e && typeof e === 'object' && e.event === 'push.commit') events.push(e)
  })
  await run()
  vi.restoreAllMocks()
  return events
}

describe.skipIf(!onV3)('v3 session commits in parts', () => {
  const records = [
    ...Array.from({ length: 1500 }, (_, i) => author(i)),
    ...Array.from({ length: 700 }, (_, i) => book(i)),
  ]

  it('commits the same records and counts as one job, in more files', async () => {
    // Whole: one job.
    const one = await setup('whole')
    let sid = await upload(one.h, one.user, one.base, { schemas }, records)
    expect((await commit(one.h, one.user, one.base, sid)).status).toBe(202)
    await one.h.drain()
    expect((await status(one.h, one.user, one.base, sid)).status).toBe('committed')

    // In parts of about 16 KB of run lines.
    sessionBuildConfig.partBytes = 16 * 1024
    const parts = await setup('parts')
    sid = await upload(parts.h, parts.user, parts.base, { schemas }, records)
    expect((await commit(parts.h, parts.user, parts.base, sid)).status).toBe(202)
    const events = await partEvents(() => parts.h.drain())
    const ended = events.filter((e) => e.step === 'v3.part' && e.at === 'end')
    expect(ended.length).toBeGreaterThan(4)
    expect(ended.reduce((n, e) => n + e.rows, 0)).toBe(records.length)
    const s = await status(parts.h, parts.user, parts.base, sid)
    expect(s.status).toBe('committed')
    expect(s.result).toMatchObject({ semver: 'v1.0.0', recordCount: records.length })
    expect(s.result.changes).toMatchObject({ added: records.length, removed: 0, updated: 0 })

    const a = await contents(one.h, one.c.id)
    const b = await contents(parts.h, parts.c.id)
    expect(b.out).toEqual(a.out)
    expect(b.files).toBeGreaterThan(a.files)
    const [ra, rb] = [
      (await lastRow(one.h.ports, one.c.id))!,
      (await lastRow(parts.h.ports, parts.c.id))!,
    ]
    expect(rb.typeCounts).toEqual(ra.typeCounts)
    expect(rb.totalBytes).toBe(ra.totalBytes)
    expect(rb.recordCount).toBe(records.length)
  })

  it('checks each part against the head: unchanged rows are left out, the rest counted', async () => {
    const { h, user, c, base } = await setup()
    let sid = await upload(h, user, base, { schemas }, records)
    await commit(h, user, base, sid)
    await h.drain()
    sessionBuildConfig.partBytes = 16 * 1024
    // Every record again, a tenth of the authors renamed, and 100 new books.
    const again = [
      ...Array.from({ length: 1500 }, (_, i) =>
        i % 10 === 0 ? author(i, `Renamed ${i}`) : author(i),
      ),
      ...Array.from({ length: 800 }, (_, i) => book(i)),
    ]
    sid = await upload(h, user, base, { schemas, base: 'v1.0.0' }, again)
    await commit(h, user, base, sid)
    await h.drain()
    const s = await status(h, user, base, sid)
    expect(s.status).toBe('committed')
    expect(s.result).toMatchObject({ semver: 'v1.1.0', recordCount: 2300 })
    expect(s.result.changes).toEqual({ added: 100, removed: 0, updated: 150 })
    const { out } = await contents(h, c.id)
    expect(out.Book).toHaveLength(800)
    expect(out.Author!.filter((l) => l.includes('Renamed'))).toHaveLength(150)
  })

  it('keeps the files its records reference, and reopens for one not uploaded', async () => {
    const { h, user, base } = await setup()
    sessionBuildConfig.partBytes = 16 * 1024
    const photo = 'a photo'
    const never = 'never uploaded'
    expect(
      (await h.request(`${base}/files/${sha(photo)}`, { method: 'PUT', user, body: photo })).status,
    ).toBe(201)
    const withPhoto = (i: number, f: string) => ({
      ...author(i),
      data: { ...author(i).data, photo: { $file: `sha256:${sha(f)}` } },
    })
    const rows = records.map((r, i) =>
      i === 100 ? withPhoto(100, photo) : i === 900 ? withPhoto(900, never) : r,
    )
    const sid = await upload(h, user, base, { schemas }, rows)
    await commit(h, user, base, sid)
    await h.drain()
    let s = await status(h, user, base, sid)
    expect(s.status).toBe('open')
    expect(s.error).toMatchObject({ error: 'Missing files', filesNeeded: [sha(never)] })
    // Uploaded now: the next commit is a new attempt, planned afresh.
    expect(
      (await h.request(`${base}/files/${sha(never)}`, { method: 'PUT', user, body: never })).status,
    ).toBe(201)
    await commit(h, user, base, sid)
    await h.drain()
    s = await status(h, user, base, sid)
    expect(s.status).toBe('committed')
    expect(s.result).toMatchObject({ recordCount: records.length, fileCount: 2 })
  })

  it('queues a lost part again from the sweep, and finishes', async () => {
    const { h, user, base } = await setup()
    sessionBuildConfig.partBytes = 16 * 1024
    const sid = await upload(h, user, base, { schemas }, records)
    await commit(h, user, base, sid)
    // The commit plans and queues its parts; one part is lost.
    expect(await drainSqliteJobs(h.ports, { max: 1 })).toBe(1)
    const parts = await h.ports.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.type, 'v3.sessionPart'))
    expect(parts.length).toBeGreaterThan(4)
    await h.ports.db.delete(schema.jobs).where(eq(schema.jobs.id, parts[2]!.id))
    await h.drain()
    let s = await status(h, user, base, sid)
    expect(s.status).toBe('committing')
    expect(s.progress.phase).toBe('building')
    expect(s.commit_step).toMatch(/^v3\.parts: \d+ of \d+ parts built$/)

    // Stalled: the sweep nudges it, and the commit queues the missing part.
    await h.ports.db
      .update(schema.pushSessions)
      .set({ progressAt: new Date(Date.now() - 2 * recoverConfig.stallMs) })
      .where(eq(schema.pushSessions.id, sid))
    await partEvents(() => recoverCommits(h.ports))
    await h.drain()
    s = await status(h, user, base, sid)
    expect(s.status).toBe('committed')
    expect(s.result).toMatchObject({ recordCount: records.length })
  })

  it('with a pool, builds the parts while the commit waits, and assembles once', async () => {
    const { h, user, base } = await setup()
    sessionBuildConfig.partBytes = 16 * 1024
    // The pool runs each job here, as the pool's objects would, with their own ports.
    const inPool = { ...h.ports }
    h.ports.pool = (job) => runJob(job, inPool)
    const sid = await upload(h, user, base, { schemas }, records)
    await commit(h, user, base, sid)
    const events = await partEvents(() => h.drain())
    const s = await status(h, user, base, sid)
    expect(s.status).toBe('committed')
    expect(s.result).toMatchObject({ recordCount: records.length })
    expect(events.filter((e) => e.step === 'v3.part' && e.at === 'end').length).toBeGreaterThan(4)
    expect(events.filter((e) => e.step === 'v3.land' && e.at === 'start')).toHaveLength(1)
    expect(events.filter((e) => e.step === 'v3.assets' && e.at === 'start')).toHaveLength(1)
  })

  it('fails a build whose parts never finish, after the nudges, saying where', async () => {
    const { h, user, base } = await setup()
    sessionBuildConfig.partBytes = 16 * 1024
    const sid = await upload(h, user, base, { schemas }, records)
    await commit(h, user, base, sid)
    const loseParts = async () => {
      for (;;) {
        await h.ports.db.delete(schema.jobs).where(eq(schema.jobs.type, 'v3.sessionPart'))
        if ((await drainSqliteJobs(h.ports, { max: 1 })) === 0) return
      }
    }
    await loseParts()
    for (let nudge = 0; nudge <= recoverConfig.maxStalls; nudge++) {
      await h.ports.db
        .update(schema.pushSessions)
        .set({ progressAt: new Date(Date.now() - 2 * recoverConfig.stallMs) })
        .where(eq(schema.pushSessions.id, sid))
      await partEvents(() => recoverCommits(h.ports))
      await loseParts()
    }
    const s = await status(h, user, base, sid)
    expect(s.status).toBe('failed')
    expect(s.error.error).toMatch(/while building the commit's files in parts/)
    expect(s.error.error).toMatch(/last step: v3\.parts: 0 of \d+ parts built/)
  })

  it('does nothing for a part of an earlier attempt', async () => {
    const { h, user, base } = await setup()
    sessionBuildConfig.partBytes = 16 * 1024
    const sid = await upload(h, user, base, { schemas }, records)
    await commit(h, user, base, sid)
    await drainSqliteJobs(h.ports, { max: 1 })
    const [session] = await h.ports.db
      .select()
      .from(schema.pushSessions)
      .where(eq(schema.pushSessions.id, sid))
    const attempt = session!.finalizeStartedAt!.getTime()
    await buildPart(h.ports, sid, attempt - 1, 0)
    const { keys } = await h.ports.stores.internal.list(`sessions/${sid}/v3-build/`)
    expect(keys.filter((k) => k.includes('/part-'))).toEqual([])
    await h.drain()
    expect((await status(h, user, base, sid)).status).toBe('committed')
  })
})
