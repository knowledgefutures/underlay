import { afterAll, describe, expect, it } from 'vitest'

import * as schema from '../src/db/schema.js'
import { cleanup } from './harness.js'
import { setup } from './kf-app.js'

afterAll(cleanup)

// u1 is a steward in the fake KF Auth; u2 is not.
describe('steward, discussion and KF summary routes', () => {
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

  it('shows approved comments to all and pending ones to their author; stewards moderate', async () => {
    const { call, user } = await setup()
    await user('u1')
    await user('u2')
    await user('u3')
    const post = (u: string, json: unknown) =>
      call('/api/pages/protocol/comments', { method: 'POST', user: u, json })

    expect((await post('u2', { anchor: 's1' })).status).toBe(400)
    expect((await call('/api/pages/protocol/comments', { method: 'POST', json: {} })).status).toBe(
      401,
    )
    const made = await post('u2', { anchor: 's1', body: 'Why?', quote: 'the text' })
    expect(made.status).toBe(201)
    const { comment } = await made.json()

    const visible = async (u?: string) => {
      const r = await (await call('/api/pages/protocol/comments', u ? { user: u } : {})).json()
      return (r.comments.s1 ?? []).map((x: { body: string }) => x.body)
    }
    expect(await visible()).toEqual([])
    expect(await visible('u3')).toEqual([])
    expect(await visible('u2')).toEqual(['Why?'])

    const patch = (u: string, json: unknown) =>
      call(`/api/pages/protocol/comments/${comment.id}`, { method: 'PATCH', user: u, json })
    expect((await patch('u3', { body: 'hijack' })).status).toBe(403)
    expect((await patch('u2', { approve: true })).status).toBe(403)
    expect((await patch('u2', { body: 'Why not?' })).status).toBe(200)

    const queue = await (await call('/api/admin/discussion', { user: 'u1' })).json()
    expect(queue.pending.map((x: { body: string }) => x.body)).toEqual(['Why not?'])
    expect((await call('/api/admin/discussion', { user: 'u2' })).status).toBe(403)

    expect((await patch('u1', { approve: true, status: 'answered' })).status).toBe(200)
    expect(await visible()).toEqual(['Why not?'])
    // Approved: the author can no longer edit.
    expect((await patch('u2', { body: 'changed' })).status).toBe(403)

    // One level of replies only.
    const reply = await post('u3', { anchor: 's1', body: 'Re', parentId: comment.id })
    expect(reply.status).toBe(201)
    const { comment: r } = await reply.json()
    expect((await post('u3', { anchor: 's1', body: 'Re re', parentId: r.id })).status).toBe(400)

    const del = (u: string, id: string) =>
      call(`/api/pages/protocol/comments/${id}`, { method: 'DELETE', user: u })
    expect((await del('u3', comment.id)).status).toBe(403)
    expect((await del('u1', comment.id)).status).toBe(200)
    expect(await visible()).toEqual([])
  })

  it('limits comments per user per minute', async () => {
    const { call, user } = await setup()
    await user('u2')
    const post = () =>
      call('/api/pages/p/comments', {
        method: 'POST',
        user: 'u2',
        json: { anchor: 'a', body: 'x' },
      })
    for (let i = 0; i < 10; i++) expect((await post()).status).toBe(201)
    expect((await post()).status).toBe(429)
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
