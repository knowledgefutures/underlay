import { afterAll, describe, expect, it } from 'vitest'

import * as schema from '../src/db/schema.js'
import { cleanup } from './harness.js'
import { setup } from './kf-app.js'

afterAll(cleanup)

const Author = { type: 'object', properties: { name: { type: 'string' } } }

// u1 is a steward in the fake KF Auth; u2 is not.
describe('admin stats', () => {
  it('reports the instance, per org, corpus, billing and operations to stewards only', async () => {
    const { h, call, db, user } = await setup()
    await user('u1')
    await user('u2')
    const col = await h.collection('authors')
    await db.insert(schema.member).values({ organizationId: 'org1', userId: 'u1', role: 'owner' })
    const base = '/api/collections/org/authors'
    const sid = (
      (await (
        await h.request(`${base}/push`, {
          method: 'POST',
          user: 'u1',
          json: { schemas: { Author } },
        })
      ).json()) as { session_id: string }
    ).session_id
    await h.request(`${base}/push/${sid}/records`, {
      method: 'POST',
      user: 'u1',
      ndjson: [
        { id: 'a', type: 'Author', data: { name: 'A' } },
        { id: 'b', type: 'Author', data: { name: 'B' }, private: true },
      ],
    })
    expect(
      (await h.request(`${base}/push/${sid}/commit`, { method: 'POST', user: 'u1' })).status,
    ).toBe(201)
    const today = new Date().toISOString().slice(0, 10)
    await db.insert(schema.usageRollups).values([
      { day: today, accountId: 'org1', collectionId: col.id, metric: 'api_calls', amount: 7 },
      {
        day: today,
        accountId: 'org1',
        collectionId: col.id,
        metric: 'response_bytes',
        amount: 900,
      },
      {
        day: '2001-01-01',
        accountId: 'org1',
        collectionId: col.id,
        metric: 'api_calls',
        amount: 99,
      },
    ])

    const get = async (path: string, u = 'u1') => {
      const res = await call(path, { user: u })
      expect(res.status, path).toBe(200)
      return (await res.json()) as any
    }
    expect((await call('/api/admin/stats/overview')).status).toBe(401)
    expect((await call('/api/admin/stats/orgs', { user: 'u2' })).status).toBe(403)

    const overview = await get('/api/admin/stats/overview?days=7')
    expect(overview.totals).toMatchObject({
      users: 2,
      orgs: 1,
      personalOrgs: 2,
      collections: 1,
      records: 2,
      publicRecords: 1,
      versions: 1,
    })
    expect(overview.totals.latestBytes).toBeGreaterThan(0)
    expect(overview.daily).toHaveLength(7)
    expect(overview.daily.at(-1)).toMatchObject({ day: today, api_calls: 7 })
    expect(overview.usage).toMatchObject({ api_calls: 7, response_bytes: 900 })
    expect(overview.attention).toMatchObject({ openReports: 0, failedPushes: 0 })

    const { orgs } = await get('/api/admin/stats/orgs')
    const org = orgs.find((o: any) => o.slug === 'org')
    expect(org).toMatchObject({ personal: false, members: 1, collections: 1, records: 2 })
    expect(org.usage.api_calls).toBe(7)
    expect(orgs.find((o: any) => o.slug === 'u1')).toMatchObject({ personal: true, records: 0 })

    const detail = await get('/api/admin/stats/orgs/org?days=30')
    expect(detail.collections).toEqual([
      expect.objectContaining({
        slug: 'authors',
        records: 2,
        usage: expect.objectContaining({ api_calls: 7 }),
      }),
    ])
    expect(detail.members).toEqual([{ name: 'u1', email: 'u1@example.org', role: 'owner' }])
    expect((await call('/api/admin/stats/orgs/nope', { user: 'u1' })).status).toBe(404)

    const corpus = await get('/api/admin/stats/corpus')
    expect(corpus.types).toEqual([{ type: 'Author', records: 2, publicRecords: 1, collections: 1 }])
    expect(corpus.sharedSchemas[0]).toMatchObject({ type: 'Author', collections: 1 })
    expect(corpus.largest[0]).toMatchObject({ owner: 'org', slug: 'authors', records: 2 })
    expect(corpus.growth).toEqual([
      expect.objectContaining({ month: today.slice(0, 7), versions: 1, added: 2 }),
    ])

    const billing = await get(`/api/admin/stats/billing?month=${today.slice(0, 7)}`)
    expect(billing.orgs).toEqual([
      expect.objectContaining({ slug: 'org', usage: expect.objectContaining({ api_calls: 7 }) }),
    ])
    expect(billing.reconcile).toMatchObject({ collections: 1, never: 1, corrected: [] })
    expect((await call('/api/admin/stats/billing?month=2026', { user: 'u1' })).status).toBe(400)
    expect((await get('/api/admin/stats/billing?month=2001-01')).orgs[0].usage.api_calls).toBe(99)

    const ops = await get('/api/admin/stats/operations')
    expect(ops.sessions).toEqual([{ status: 'committed', n: 1 }])
    expect(ops.failedPushes).toEqual([])
    expect(ops.locations).toEqual([])
  })
})
