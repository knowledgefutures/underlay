/**
 * Where a commit is (push/trace.ts): each step logged as it starts and ends, progress in a
 * long step, the step and the last error kept on the session and shown by the status route,
 * and the sweep naming the last step when it fails a commit that stopped moving
 * (2026-11-13: a 5.5M-record push into a v3 collection stalled with nothing in the logs).
 */
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

import * as schema from '../src/db/schema.js'
import { recoverCommits, recoverConfig } from '../src/push/recover.js'
import { traceConfig } from '../src/push/trace.js'
import { cleanup, type Harness, harness } from './harness.js'
import { onV3 } from './layouts.js'

afterAll(cleanup)
const defaults = { trace: { ...traceConfig }, recover: { ...recoverConfig } }
afterEach(() => {
  Object.assign(traceConfig, defaults.trace)
  Object.assign(recoverConfig, defaults.recover)
  vi.restoreAllMocks()
})

const Author = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
const rec = (i: number) => ({
  id: `a${String(i).padStart(6, '0')}`,
  type: 'Author',
  data: { name: `n${i}` },
})
const json = async (r: Response) => (await r.json()) as Record<string, any>

async function setup() {
  const h = await harness({ newCollections: 'v3' })
  const user = await h.member()
  await h.collection('lib', { recordLayout: 'v3' })
  return { h, user, base: '/api/collections/org/lib' }
}

/** Open a session and upload `n` records in batches of `batch`; its id. */
async function upload(h: Harness, user: string, base: string, n: number, batch = 500) {
  const opened = await h.request(`${base}/push`, {
    method: 'POST',
    user,
    json: { schemas: { Author } },
  })
  const sid = (await json(opened)).session_id as string
  for (let i = 0; i < n; i += batch) {
    const rows = Array.from({ length: Math.min(batch, n - i) }, (_, j) => rec(i + j))
    const r = await h.request(`${base}/push/${sid}/records`, { method: 'POST', user, ndjson: rows })
    expect(r.status).toBe(200)
  }
  return sid
}

/** The commit events logged while `run` ran. */
async function commitEvents(run: () => Promise<void>) {
  const events: Record<string, any>[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    const [first] = args
    if (first && typeof first === 'object' && (first as any).event === 'push.commit')
      events.push(first as Record<string, any>)
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    await run()
  } finally {
    spy.mockRestore()
  }
  return events
}

const sessionRow = async (h: Harness, sid: string) =>
  (await h.ports.db.select().from(schema.pushSessions).where(eq(schema.pushSessions.id, sid)))[0]!

describe.skipIf(!onV3)('commit tracing (v3)', () => {
  it('logs each step, reports progress, and keeps the last step on the session', async () => {
    const { h, user, base } = await setup()
    traceConfig.progressMs = 0
    const sid = await upload(h, user, base, 3000)
    const events = await commitEvents(async () => {
      const res = await h.request(`${base}/push/${sid}/commit`, {
        method: 'POST',
        user,
        json: { async: true },
      })
      expect(res.status).toBe(202)
      await h.drain()
    })
    const status = await json(await h.request(`${base}/push/${sid}`, { user }))
    expect(status.status).toBe('committed')
    expect(status.commit_step).toBe('v3.commit (done)')
    expect(status.commit_last_error).toBeNull()

    const steps = (at: string) => events.filter((e) => e.at === at).map((e) => e.step)
    for (const step of ['compact.check', 'v3.commit', 'v3.sync', 'v3.assets', 'v3.build']) {
      expect(steps('start')).toContain(step)
      expect(steps('end')).toContain(step)
    }
    expect(steps('start')).toContain('v3.land')
    expect(events.filter((e) => e.at === 'end').every((e) => typeof e.ms === 'number')).toBe(true)
    // The build reports rows as it reads them, ending with all of them (and the $schema row).
    const built = events.filter((e) => e.at === 'progress' && e.step === 'v3.build')
    expect(built.length).toBeGreaterThan(1)
    expect(built.at(-1)).toMatchObject({ rows_read: 3001, rows_total: 3001, rows_changed: 3001 })
    expect(events.every((e) => e.session === sid)).toBe(true)
  })

  it('keeps the step that threw and its error, and the sweep names them when it fails', async () => {
    const { h, user, base } = await setup()
    const sid = await upload(h, user, base, 1000)
    // The run's blocks are gone (its index stays): the first pass over the runs throws.
    const store = h.ports.stores.internal
    const { keys } = await store.list(`sessions/${sid}/runs/`)
    for (const k of keys.filter((k) => !k.endsWith('index.json'))) await store.delete(k)

    const events = await commitEvents(async () => {
      await h.request(`${base}/push/${sid}/commit`, { method: 'POST', user, json: { async: true } })
      await h.drain()
    })
    const errors = events.filter((e) => e.at === 'error')
    expect(errors.map((e) => e.step)).toEqual(['v3.assets', 'v3.commit'])
    let status = await json(await h.request(`${base}/push/${sid}`, { user }))
    expect(status.status).toBe('committing')
    expect(status.commit_step).toBe('v3.assets')
    expect(status.commit_last_error).toMatchObject({ step: 'v3.assets' })
    expect(status.progress.step).toBe('v3.assets')

    // The commit stops moving; past the nudges the sweep fails it, saying where it was.
    await h.ports.db
      .update(schema.pushSessions)
      .set({ progressAt: new Date(Date.now() - 2 * recoverConfig.stallMs), stalls: 3 })
      .where(eq(schema.pushSessions.id, sid))
    const swept = await commitEvents(() => recoverCommits(h.ports))
    expect(swept).toContainEqual(
      expect.objectContaining({ at: 'sweep', action: 'fail', step: 'v3.assets', session: sid }),
    )
    status = await json(await h.request(`${base}/push/${sid}`, { user }))
    expect(status.status).toBe('failed')
    expect(status.error.error).toMatch(/last step: v3\.assets/)
    expect(status.error.error).toMatch(/last error in v3\.assets/)
    expect(status.commit_last_error).toMatchObject({ step: 'v3.assets' })
  })

  it('a nudge is logged, and starting a step dates progress without clearing nudges', async () => {
    const { h, user, base } = await setup()
    const sid = await upload(h, user, base, 200)
    // Committing, with no job queued (as when the job is lost): the sweep nudges it.
    await h.ports.db
      .update(schema.pushSessions)
      .set({
        status: 'committing',
        finalizeStartedAt: new Date(Date.now() - 2 * recoverConfig.stallMs),
        progressAt: new Date(Date.now() - 2 * recoverConfig.stallMs),
        stalls: 1,
      })
      .where(eq(schema.pushSessions.id, sid))
    const swept = await commitEvents(() => recoverCommits(h.ports))
    expect(swept).toContainEqual(
      expect.objectContaining({ at: 'sweep', action: 'nudge', stalls: 1, session: sid }),
    )
    expect((await sessionRow(h, sid)).stalls).toBe(2)
    // The nudged job commits: a step that ends clears the count.
    await commitEvents(() => h.drain().then(() => {}))
    const s = await sessionRow(h, sid)
    expect(s.status).toBe('committed')
    expect(s.stalls).toBe(0)
  })
})
