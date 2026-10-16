/**
 * Getting a large commit through after it failed (staging, 2026-10-16): units
 * capped by entries as well as bytes, and a commit that rebases on the head.
 */
import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'

import * as schema from '../src/db/schema.js'
import { planRanges } from '../src/push/parallel.js'
import type { RunPart } from '../src/push/runs.js'
import { cleanup, type Harness, harness } from './harness.js'

afterAll(cleanup)

const Author = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
const rec = (id: string) => ({ id, type: 'Author', data: { name: id } })

async function json(res: Response) {
  return (await res.json()) as any
}

describe('unit planning', () => {
  const candidates = Array.from({ length: 9 }, (_, i) => `k${i + 1}`)
  // One part of 1,000 tiny entries across the whole key range.
  const part: RunPart = {
    part: 0,
    first: 'Author\u0000k0',
    last: 'Author\u0000k9z',
    count: 1_000,
    bytes: 1_000,
    length: 100,
  }
  const base = { nodes: [], leafBytes: 1 }

  it('closes a unit at the entry cap when bytes are far under theirs', () => {
    const units = (cap?: number) =>
      planRanges('Author', candidates, [part], base, 1e12, cap).filter((r) => !r.gap)
    expect(units()).toHaveLength(1)
    expect(units(300)).toHaveLength(4)
  })
})

describe('commit with rebase', () => {
  async function open(h: Harness, user: string, path: string, ids: string[]) {
    const sid = (
      await json(
        await h.request(`${path}/push`, { method: 'POST', user, json: { schemas: { Author } } }),
      )
    ).session_id as string
    const res = await h.request(`${path}/push/${sid}/records`, {
      method: 'POST',
      user,
      ndjson: ids.map(rec),
    })
    expect(res.status).toBe(200)
    return sid
  }

  it('commits a session on a head that moved since it opened', async () => {
    const h = await harness()
    const user = await h.member()
    await h.collection('moved')
    const path = '/api/collections/org/moved'
    const a = await open(h, user, path, ['a1', 'a2'])
    const b = await open(h, user, path, ['b1'])
    expect(
      (await h.request(`${path}/push/${b}/commit`, { method: 'POST', user, json: {} })).status,
    ).toBe(201)
    // Without rebase the moved base is refused, and the session fails.
    const refused = await h.request(`${path}/push/${a}/commit`, { method: 'POST', user, json: {} })
    expect(refused.status).toBe(409)

    const c = await open(h, user, path, ['c1', 'c2', 'c3'])
    const d = await open(h, user, path, ['d1'])
    await h.request(`${path}/push/${d}/commit`, { method: 'POST', user, json: {} })
    const res = await h.request(`${path}/push/${c}/commit`, {
      method: 'POST',
      user,
      json: { rebase: true },
    })
    expect(res.status).toBe(201)
    expect((await json(res)).recordCount).toBe(5)
  })

  it('rebases a failed session committed again', async () => {
    const h = await harness()
    const user = await h.member()
    await h.collection('retry')
    const path = '/api/collections/org/retry'
    const a = await open(h, user, path, ['a1', 'a2'])
    // A commit that failed on the server's side (as a unit out of attempts does).
    await h.ports.db
      .update(schema.pushSessions)
      .set({ status: 'failed', error: { statusCode: 500, error: 'A commit unit failed 4 times' } })
      .where(eq(schema.pushSessions.id, a))
    const b = await open(h, user, path, ['b1'])
    await h.request(`${path}/push/${b}/commit`, { method: 'POST', user, json: {} })
    const res = await h.request(`${path}/push/${a}/commit`, {
      method: 'POST',
      user,
      json: { rebase: true },
    })
    expect(res.status).toBe(201)
    expect((await json(res)).recordCount).toBe(3)
  })

  it('refuses a rebase that is not a boolean', async () => {
    const h = await harness()
    const user = await h.member()
    await h.collection('bad')
    const path = '/api/collections/org/bad'
    const a = await open(h, user, path, ['a1'])
    const res = await h.request(`${path}/push/${a}/commit`, {
      method: 'POST',
      user,
      json: { rebase: 'yes' },
    })
    expect(res.status).toBe(400)
  })
})
