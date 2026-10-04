import { afterAll, describe, expect, it } from 'vitest'

import * as schema from '../src/db/schema.js'
import { cleanup } from './harness.js'
import { setup } from './kf-app.js'

afterAll(cleanup)

// u1 is a steward in the fake KF Auth; u2 is not.
describe('steward and KF summary routes', () => {
  it('lets only stewards read and set the featured explore lists', async () => {
    const { call, user } = await setup()
    await user('u1')
    await user('u2')
    for (const [path, field] of [
      ['/api/admin/explore-tags', 'tags'],
      ['/api/admin/explore-collections', 'collections'],
    ] as const) {
      expect((await call(path)).status).toBe(401)
      expect((await call(path, { user: 'u2' })).status).toBe(403)
      expect(await (await call(path, { user: 'u1' })).json()).toEqual({ [field]: [] })
      const put = (json: unknown, u = 'u1') => call(path, { method: 'PUT', user: u, json })
      expect((await put({ [field]: ['a/b'] }, 'u2')).status).toBe(403)
      expect((await put({ [field]: [1] })).status).toBe(422)
      expect((await put({ [field]: ['org/c', 'x'] })).status).toBe(200)
      expect(await (await call(path, { user: 'u1' })).json()).toEqual({ [field]: ['org/c', 'x'] })
    }
  })

  it('answers KF Auth with an org’s collections, with the internal key only', async () => {
    const { h, call, db } = await setup()
    await h.collection('c')
    await db.update(schema.organization).set({ kfOrgId: 'kf-1' })
    const url = '/api/kf/summary?kf_org_id=kf-1'

    expect((await call(url)).status).toBe(401)
    expect((await call(url, { authorization: 'Bearer wrong' })).status).toBe(401)
    expect((await call('/api/kf/summary', { authorization: 'Bearer internal-key' })).status).toBe(
      400,
    )
    const res = await (await call(url, { authorization: 'Bearer internal-key' })).json()
    expect(res.orgs).toEqual([
      {
        id: 'org1',
        slug: 'org',
        name: 'Org',
        url: 'http://test/org',
        collections: [
          expect.objectContaining({
            slug: 'c',
            url: 'http://test/org/c',
            stats: { versions: 0, records: 0, files: 0, bytes: 0 },
          }),
        ],
      },
    ])
    const none = await call('/api/kf/summary?kf_org_id=kf-none', {
      authorization: 'Bearer internal-key',
    })
    expect(await none.json()).toEqual({ orgs: [] })
  })
})
