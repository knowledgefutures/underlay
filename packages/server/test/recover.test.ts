/**
 * Commits that stop moving: the maintenance sweep queues their next step again,
 * and fails one that can't finish with a reason, instead of leaving it
 * committing forever (2026-10-15: a session sat at 20 of 34 units for 80 min).
 */
import { and, eq } from 'drizzle-orm'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

import { committing } from '../src/cleanup/sweep.js'
import * as schema from '../src/db/schema.js'
import { drainSqliteJobs } from '../src/jobs.js'
import { compactConfig, compactPiece } from '../src/push/compact.js'
import { parallelConfig, unitLimits } from '../src/push/parallel.js'
import { recoverCommits, recoverConfig } from '../src/push/recover.js'
import { isMark, MERGE_FAN_IN } from '../src/push/runs.js'
import { cleanup, type Harness, harness } from './harness.js'

afterAll(cleanup)
const defaults = {
  parallel: { ...parallelConfig },
  units: { ...unitLimits },
  recover: { ...recoverConfig },
  compact: { ...compactConfig },
}
afterEach(() => {
  Object.assign(parallelConfig, defaults.parallel)
  Object.assign(unitLimits, defaults.units)
  Object.assign(recoverConfig, defaults.recover)
  Object.assign(compactConfig, defaults.compact)
})

const Author = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
const rec = (id: string) => ({ id, type: 'Author', data: { name: id } })

function ids(n: number): string[] {
  const out: string[] = []
  for (let i = 0; out.length < n; i++) {
    const id = `a${String(i).padStart(7, '0')}`
    if (isMark(id) || i % 50 === 0) out.push(id)
  }
  return out
}

async function json(res: Response) {
  return (await res.json()) as any
}

/** Open a session and upload `batches`; its id. */
async function upload(h: Harness, user: string, path: string, batches: object[][]) {
  const sid = (
    await json(
      await h.request(`${path}/push`, { method: 'POST', user, json: { schemas: { Author } } }),
    )
  ).session_id as string
  for (const b of batches)
    expect(
      (await h.request(`${path}/push/${sid}/records`, { method: 'POST', user, ndjson: b })).status,
    ).toBe(200)
  return sid
}

const dropJobs = (h: Harness, type: string) =>
  h.ports.db.delete(schema.jobs).where(eq(schema.jobs.type, type))

/** Run every job but those of `type`, which are lost as they're queued. */
async function drainLosing(h: Harness, type: string) {
  for (;;) {
    await dropJobs(h, type)
    if ((await drainSqliteJobs(h.ports, { max: 1 })) === 0) return
  }
}

const session = async (h: Harness, sid: string) =>
  (await h.ports.db.select().from(schema.pushSessions).where(eq(schema.pushSessions.id, sid)))[0]!

describe('recovering stalled commits', () => {
  it('queues lost units again, and the commit finishes', async () => {
    const h = await harness()
    const user = await h.member()
    await h.collection('lost')
    const path = '/api/collections/org/lost'
    const sid = await upload(h, user, path, [ids(400).map(rec)])
    Object.assign(parallelConfig, { aboveBytes: 0, unitBytes: 1, baseLevel: 0 })
    expect((await h.request(`${path}/push/${sid}/commit`, { method: 'POST', user })).status).toBe(
      202,
    )
    // Plan the units, losing every unit job.
    await drainLosing(h, 'commit.unit')
    expect((await session(h, sid)).status).toBe('committing')

    Object.assign(recoverConfig, { stallMs: -1 })
    Object.assign(unitLimits, { staleMs: -1 })
    await recoverCommits(h.ports)
    await h.drain()
    expect((await session(h, sid)).status).toBe('committed')
  })

  it('fails a commit whose unit used up its attempts, naming the unit', async () => {
    const h = await harness()
    const user = await h.member()
    await h.collection('spent')
    const path = '/api/collections/org/spent'
    const sid = await upload(h, user, path, [ids(400).map(rec)])
    Object.assign(parallelConfig, { aboveBytes: 0, unitBytes: 1, baseLevel: 0 })
    await h.request(`${path}/push/${sid}/commit`, { method: 'POST', user })
    await drainLosing(h, 'commit.unit')
    // One unit has been tried as often as it may be.
    const [unit] = await h.ports.db
      .select()
      .from(schema.commitUnits)
      .where(and(eq(schema.commitUnits.sessionId, sid), eq(schema.commitUnits.status, 'pending')))
    await h.ports.db
      .update(schema.commitUnits)
      .set({ attempts: unitLimits.maxAttempts, queuedAt: new Date(0) })
      .where(eq(schema.commitUnits.id, unit!.id))
    Object.assign(recoverConfig, { stallMs: -1 })
    await recoverCommits(h.ports)
    const s = await session(h, sid)
    expect(s.status).toBe('failed')
    expect(s.error?.error).toMatch(/commit unit failed 4 times \(type Author/)
    const status = await json(await h.request(`${path}/push/${sid}`, { user }))
    expect(status.status).toBe('failed')

    // The failure was the server's: the same session commits again, from its uploads.
    const again = await h.request(`${path}/push/${sid}/commit`, { method: 'POST', user })
    expect(again.status).toBe(202)
    await h.drain()
    const retried = await json(await h.request(`${path}/push/${sid}`, { user }))
    expect(retried).toMatchObject({ status: 'committed', error: null })
    expect(retried.result.recordCount).toBe(400)
  })

  it('refuses to commit again a session that failed for a reason the client must fix', async () => {
    const h = await harness()
    const user = await h.member()
    await h.collection('refused')
    const path = '/api/collections/org/refused'
    const sid = await upload(h, user, path, [ids(5).map(rec)])
    await h.ports.db
      .update(schema.pushSessions)
      .set({ status: 'failed', error: { statusCode: 422, error: 'Schema validation failed' } })
      .where(eq(schema.pushSessions.id, sid))
    const res = await h.request(`${path}/push/${sid}/commit`, { method: 'POST', user })
    expect(res.status).toBe(409)
    expect((await json(res)).error).toMatch(/new session/)
  })

  it('holds storage cleanup for a long commit while it makes progress', async () => {
    const h = await harness()
    const user = await h.member()
    await h.collection('long')
    const path = '/api/collections/org/long'
    const sid = await upload(h, user, path, [ids(5).map(rec)])
    const hours = (n: number) => new Date(Date.now() - n * 60 * 60 * 1000)
    const set = (v: Partial<typeof schema.pushSessions.$inferInsert>) =>
      h.ports.db.update(schema.pushSessions).set(v).where(eq(schema.pushSessions.id, sid))
    await set({ status: 'committing', finalizeStartedAt: hours(30), progressAt: hours(0.2) })
    expect(await committing(h.ports)).toBe(true)
    await set({ progressAt: hours(7) })
    expect(await committing(h.ports)).toBe(false)
  })

  it('nudges a lost commit job, and fails one that never moves', async () => {
    const h = await harness()
    const user = await h.member()
    await h.collection('nudge')
    const path = '/api/collections/org/nudge'
    const sid = await upload(h, user, path, [ids(20).map(rec)])
    const commit = await h.request(`${path}/push/${sid}/commit?async=true`, {
      method: 'POST',
      user,
    })
    expect(commit.status).toBe(202)
    await dropJobs(h, 'push.commit')
    Object.assign(recoverConfig, { stallMs: -1 })
    // Nudged up to maxStalls times: each queues push.commit again; lose those too.
    for (let i = 0; i < recoverConfig.maxStalls; i++) {
      await recoverCommits(h.ports)
      expect((await session(h, sid)).stalls).toBe(i + 1)
      await dropJobs(h, 'push.commit')
    }
    await recoverCommits(h.ports)
    const s = await session(h, sid)
    expect(s.status).toBe('failed')
    expect(s.error?.error).toMatch(/stopped making progress while committing/)

    // A second session: one nudge, and the job runs this time.
    const sid2 = await upload(h, user, path, [ids(20).map(rec)])
    await h.request(`${path}/push/${sid2}/commit?async=true`, { method: 'POST', user })
    await dropJobs(h, 'push.commit')
    await recoverCommits(h.ports)
    await h.drain()
    expect((await session(h, sid2)).status).toBe('committed')
  })

  it('queues a lost compaction again', async () => {
    const h = await harness()
    const user = await h.member()
    await h.collection('compact')
    const path = '/api/collections/org/compact'
    const all = ids(MERGE_FAN_IN * 5)
    const batches = Array.from({ length: MERGE_FAN_IN }, (_, i) =>
      all.slice(i * 5, i * 5 + 5).map(rec),
    )
    const sid = await upload(h, user, path, batches)
    // The 16th upload claimed a compaction; lose its job.
    await dropJobs(h, 'push.compact')
    const claimed = () =>
      h.ports.db.select().from(schema.pushRuns).where(eq(schema.pushRuns.sessionId, sid))
    expect((await claimed()).every((r) => r.mergingInto !== null)).toBe(true)
    Object.assign(recoverConfig, { stallMs: -1 })
    await recoverCommits(h.ports)
    await h.drain()
    const runs = await claimed()
    expect(runs.map((r) => [r.tier, r.mergingInto])).toEqual([[1, null]])
    // And the session still commits.
    Object.assign(compactConfig, { commitRuns: 1 })
    const res = await h.request(`${path}/push/${sid}/commit`, { method: 'POST', user })
    expect(res.status).toBe(201)
  })

  it('leaves a long compaction alone while its pieces keep finishing', async () => {
    const h = await harness()
    const user = await h.member()
    await h.collection('pieces')
    const path = '/api/collections/org/pieces'
    // Every compaction splits into pieces, one per input part.
    Object.assign(compactConfig, { pieceBytes: 1 })
    const all = ids(MERGE_FAN_IN * 5)
    const batches = Array.from({ length: MERGE_FAN_IN }, (_, i) =>
      all.slice(i * 5, i * 5 + 5).map(rec),
    )
    const sid = await upload(h, user, path, batches)
    const jobs = (type: string) =>
      h.ports.db.select().from(schema.jobs).where(eq(schema.jobs.type, type))
    // Run the compaction job alone: it plans the pieces and queues them.
    while ((await jobs('push.compactPiece')).length === 0)
      expect(await drainSqliteJobs(h.ports, { max: 1 })).toBe(1)
    const runs = () =>
      h.ports.db.select().from(schema.pushRuns).where(eq(schema.pushRuns.sessionId, sid))
    const seq = (await runs())[0]!.mergingInto!
    // The claim is older than the stall window, but a piece has just finished.
    const old = new Date(Date.now() - 2 * recoverConfig.stallMs)
    await h.ports.db
      .update(schema.pushRuns)
      .set({ claimedAt: old })
      .where(eq(schema.pushRuns.sessionId, sid))
    await compactPiece(h.ports, sid, seq, 0)
    expect((await runs()).every((r) => r.claimedAt! > old)).toBe(true)
    await dropJobs(h, 'push.compact')
    await recoverCommits(h.ports)
    expect(await jobs('push.compact')).toEqual([])
    // Once nothing has finished within the window, it is queued again, and completes.
    await h.ports.db
      .update(schema.pushRuns)
      .set({ claimedAt: old })
      .where(eq(schema.pushRuns.sessionId, sid))
    await dropJobs(h, 'push.compactPiece')
    await recoverCommits(h.ports)
    expect((await jobs('push.compact')).length).toBe(1)
    await h.drain()
    expect((await runs()).map((r) => [r.tier, r.mergingInto])).toEqual([[1, null]])
  })
})
