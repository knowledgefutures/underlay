import { hashRecord, hashSchema } from '@underlay/protocol'
import { afterAll, describe, expect, it } from 'vitest'

import * as schema from '../src/db/schema.js'
import { cleanup, type Harness, harness } from './harness.js'

afterAll(cleanup)

const Doc = { type: 'object', properties: { title: { type: 'string' } } }
const doc = (id: string, title: string) => ({ id, type: 'Doc', data: { title } })

async function push(
  h: Harness,
  user: string,
  base: string,
  open: object,
  records: object[],
  deletes: object[] = [],
) {
  const sid = (
    (await (await h.request(`${base}/push`, { method: 'POST', user, json: open })).json()) as {
      session_id: string
    }
  ).session_id
  if (records.length)
    await h.request(`${base}/push/${sid}/records`, { method: 'POST', user, ndjson: records })
  if (deletes.length)
    await h.request(`${base}/push/${sid}/deletes`, { method: 'POST', user, ndjson: deletes })
  expect((await h.request(`${base}/push/${sid}/commit`, { method: 'POST', user })).status).toBe(201)
  await h.drain()
}

describe('read features', () => {
  it('reads a record by type and id, its history, and where it first appeared', async () => {
    const h = await harness()
    const user = await h.member()
    await h.collection('docs')
    await h.ports.db.update(schema.collections).set({ public: true })
    const base = '/api/collections/org/docs'
    await push(h, user, base, { schemas: { Doc } }, [doc('a', 'A'), doc('b', 'B')])
    await push(h, user, base, {}, [doc('a', 'A2')])
    await push(h, user, base, {}, [], [{ type: 'Doc', id: 'b' }])
    await push(h, user, base, {}, [doc('b', 'B')])

    const one = await (await h.request(`${base}/versions/v1.0.0/records/Doc/a`)).json()
    expect(one).toMatchObject({ id: 'a', type: 'Doc', data: { title: 'A' }, semver: 'v1.0.0' })
    expect((await h.request(`${base}/versions/latest/records/Doc/zzz`)).status).toBe(404)

    const history = async (id: string) =>
      (
        (await (await h.request(`${base}/records/Doc/${id}/history`)).json()) as {
          changes: { semver: string; change: string }[]
        }
      ).changes.map((x) => `${x.semver}:${x.change}`)
    const semvers = (
      (await (await h.request(`${base}/versions`)).json()) as { semver: string; seq?: number }[]
    )
      .map((v) => v.semver)
      .reverse()
    expect(await history('a')).toEqual([`${semvers[0]}:added`, `${semvers[1]}:updated`])
    expect(await history('b')).toEqual([
      `${semvers[0]}:added`,
      `${semvers[2]}:removed`,
      `${semvers[3]}:added`,
    ])
    expect((await h.request(`${base}/records/Doc/nope/history`)).status).toBe(404)

    const hashB = hashRecord('b', 'Doc', { title: 'B' }).hash
    const first = await (await h.request(`/api/records/${hashB}/first`)).json()
    expect(first).toMatchObject({
      kind: 'record',
      owner: 'org',
      collection: 'docs',
      semver: semvers[0],
      id: 'b',
    })

    // Private: a stranger finds nothing; a member does.
    await h.ports.db.update(schema.collections).set({ public: false })
    expect((await h.request(`/api/records/${hashB}/first`)).status).toBe(404)
    expect((await h.request(`/api/records/${hashB}/first`, { user })).status).toBe(200)
  })

  it('shows members where their private collections use a schema', async () => {
    const h = await harness()
    const user = await h.member()
    await h.collection('secret')
    const base = '/api/collections/org/secret'
    await push(h, user, base, { schemas: { Doc } }, [doc('a', 'A')])
    const id = hashSchema(Doc)
    const mine = (await (await h.request(`/api/schemas/${id}`, { user })).json()) as {
      usage: { collection: string }[]
    }
    expect(mine.usage.map((u) => u.collection)).toEqual(['org/secret'])
    expect((await h.request(`/api/schemas/${id}`)).status).toBe(404)
  })
})
