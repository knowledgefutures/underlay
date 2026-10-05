import { hashSchema } from '@underlay/protocol'
import { afterAll, describe, expect, it } from 'vitest'

import * as schema from '../src/db/schema.js'
import { cleanup, harness } from './harness.js'
import { setup } from './kf-app.js'

afterAll(cleanup)

const Author = { type: 'object', properties: { name: { type: 'string' } } }
const Secret = { type: 'object', private: true, properties: { note: { type: 'string' } } }

async function json(res: Response) {
  return (await res.json()) as any
}

describe('schemas', () => {
  it('lists collection schemas and global schemas by visibility, with labels', async () => {
    const h = await harness()
    const user = await h.member()
    await h.collection('lib')
    await h.ports.db.update(schema.collections).set({ public: true })
    const base = '/api/collections/org/lib'
    const sid = (
      await json(
        await h.request(`${base}/push`, {
          method: 'POST',
          user,
          json: { schemas: { Author, Secret } },
        }),
      )
    ).session_id
    await h.request(`${base}/push/${sid}/records`, {
      method: 'POST',
      user,
      ndjson: [
        { id: 'a', type: 'Author', data: { name: 'A' } },
        { id: 's', type: 'Secret', data: { note: 'n' } },
      ],
    })
    expect((await h.request(`${base}/push/${sid}/commit`, { method: 'POST', user })).status).toBe(
      201,
    )

    const anon = await json(await h.request(`${base}/schemas`))
    expect(anon.schemas.map((s: any) => s.slug)).toEqual(['Author'])
    expect(anon.schemas[0]).toMatchObject({ schemaHash: hashSchema(Author), schema: Author })
    const owner = await json(await h.request(`${base}/schemas`, { user }))
    expect(owner.schemas.map((s: any) => s.slug)).toEqual(['Author', 'Secret'])

    // Global: the private type's schema is visible to members only.
    expect((await h.request(`/api/schemas/${hashSchema(Secret)}`)).status).toBe(404)
    expect((await h.request(`/api/schemas/${hashSchema(Secret)}`, { user })).status).toBe(200)
    const detail = await json(await h.request(`/api/schemas/${hashSchema(Author)}`))
    expect(detail.usage).toEqual([{ slug: 'Author', semver: 'v1.0.0', collection: 'org/lib' }])

    expect(
      (
        await h.request(`/api/schemas/${hashSchema(Author)}/labels`, {
          method: 'POST',
          user,
          json: { label: 'person' },
        })
      ).status,
    ).toBe(201)
    const byLabel = await json(await h.request('/api/schemas?label=pers'))
    expect(byLabel.map((s: any) => s.labels)).toEqual([['person']])
    const labelled = await json(await h.request(`${base}/schemas`))
    expect(labelled.schemas[0].schema['x-underlay-labels']).toEqual(['person'])
    expect((await json(await h.request('/api/schemas?q=Auth'))).length).toBe(1)
  })

  it('lets only stewards remove a label, with a session or a non-read key', async () => {
    const { call, db, user } = await setup()
    await user('u1') // a steward in the fake KF Auth
    await user('u2')
    const hash = hashSchema(Author)
    await db.insert(schema.schemas).values({ hash })
    await db.insert(schema.schemaLabels).values({ schemaHash: hash, label: 'person' })
    const remove = (u?: string, key?: string) =>
      call(`/api/schemas/${hash}/labels/person`, {
        method: 'DELETE',
        ...(u ? { user: u } : {}),
        ...(key ? { key } : {}),
      })
    const labels = async () => (await db.select().from(schema.schemaLabels)).length

    expect((await remove()).status).toBe(401)
    // Anyone can mint an admin key: it doesn't make them a steward.
    expect((await remove('u2', 'admin')).status).toBe(403)
    expect((await remove('u2')).status).toBe(403)
    // A steward's read key, or a key confined to a collection or owned by an org, isn't enough.
    expect((await remove('u1', 'read')).status).toBe(401)
    expect((await remove('u1', 'scoped')).status).toBe(401)
    expect(await labels()).toBe(1)
    expect((await remove('u1', 'write')).status).toBe(200)
    expect(await labels()).toBe(0)
    await db.insert(schema.schemaLabels).values({ schemaHash: hash, label: 'person' })
    expect((await remove('u1')).status).toBe(200)
    expect(await labels()).toBe(0)
  })
})
