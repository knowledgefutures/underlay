import { afterAll, describe, expect, it } from 'vitest'

import * as schema from '../src/db/schema.js'
import { cleanup } from './harness.js'
import { setup } from './kf-app.js'
import { kfConsole } from './kf-console.js'

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

  it('answers the KF console with an org’s collections, with its token only', async () => {
    const { h, call, db } = await setup()
    await h.collection('c')
    await db.update(schema.organization).set({ kfOrgId: 'kf-1' })
    const url = '/api/kf/summary?kf_org_id=kf-1'

    expect((await call(url)).status).toBe(401)
    expect((await call(url, { consoleToken: 'wrong' })).status).toBe(401)
    // The old shared key, which the console still sends alongside, is no longer read.
    expect((await call(url, { authorization: 'Bearer internal-key' })).status).toBe(401)
    expect((await call('/api/kf/summary')).status).toBe(401)
    expect((await call('/api/kf/summary', { consoleToken: 'console-token' })).status).toBe(400)
    const res = await (await call(url, { consoleToken: 'console-token' })).json()
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
      consoleToken: 'console-token',
    })
    expect(await none.json()).toEqual({ orgs: [] })
  })

  it('checks a real console token against the registered summary URL', async () => {
    let t!: Awaited<ReturnType<typeof kfConsole>>
    const { h, call, db } = await setup({
      kf: async (h) => (t = await kfConsole(h.ports.db)).kf,
    })
    await h.collection('c')
    await db.update(schema.organization).set({ kfOrgId: 'kf-1' })
    const url = '/api/kf/summary?kf_org_id=kf-1'
    const warn = console.warn
    console.warn = () => {}
    try {
      const ok = await call(url, { consoleToken: await t.sign('http://test/api/kf/summary') })
      expect(ok.status).toBe(200)
      expect((await ok.json()).orgs).toHaveLength(1)
      // A token for another app's summary URL, or for another of this app's routes.
      for (const htu of ['https://www.pubpub.org/api/kf/summary', 'http://test/api/kf/other']) {
        expect((await call(url, { consoleToken: await t.sign(htu) })).status).toBe(401)
      }
    } finally {
      console.warn = warn
    }
  })
})
