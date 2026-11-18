/**
 * Links in record data and `ul:ver:` version ids on the server (record-references.md):
 * a malformed `$link` is refused at push, a well-formed one is stored as data, and a version
 * answers to its id in every form a person may give it, before and after the D1 backfill.
 */
import { and, eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'

import * as schema from '../src/db/schema.js'
import { backfillVersionIds } from '../src/v3/version-ids.js'
import { cleanup, type Harness, harness } from './harness.js'
import { onV3 } from './layouts.js'

afterAll(cleanup)

const Work = {
  type: 'object',
  properties: { title: { type: 'string' }, derivedFrom: {}, cover: {} },
  required: ['title'],
}
const json = async (r: Response) => (await r.json()) as Record<string, any>
const hex = (c: string) => c.repeat(64)

async function setup() {
  const h = await harness({ newCollections: 'v3' })
  const user = await h.member()
  const c = await h.collection('lib', { recordLayout: 'v3' })
  await h.ports.db
    .update(schema.collections)
    .set({ public: true })
    .where(eq(schema.collections.id, c.id))
  return { h, user, c, base: '/api/collections/org/lib' }
}

async function push(h: Harness, user: string, base: string, records: object[]) {
  const opened = await h.request(`${base}/push`, {
    method: 'POST',
    user,
    json: { schemas: { Work } },
  })
  if (opened.status !== 200) return opened
  const sid = (await json(opened)).session_id as string
  const r = await h.request(`${base}/push/${sid}/records`, {
    method: 'POST',
    user,
    ndjson: records,
  })
  if (r.status !== 200) return r
  const res = await h.request(`${base}/push/${sid}/commit`, { method: 'POST', user })
  await h.drain()
  return res
}

describe.skipIf(!onV3)('record links and version ids', () => {
  it('stores well-formed links as data and refuses a pasted hash', async () => {
    const { h, user, base } = await setup()
    const data = {
      title: 'Derived',
      derivedFrom: [
        { $link: `ul:rec:${hex('a')}`, collection: 'c-1', type: 'work', id: '10.1/x', rel: 'copy' },
      ],
      cover: { $link: `ul:asset:${hex('b')}` },
    }
    const res = await push(h, user, base, [{ id: 'w1', type: 'Work', data }])
    expect(res.status).toBe(201)
    const got = await json(await h.request(`${base}/versions/latest/records/Work/w1`))
    expect(got.data).toEqual(data)

    const bad = await push(h, user, base, [
      { id: 'w2', type: 'Work', data: { title: 'Bad', derivedFrom: { $link: hex('a') } } },
    ])
    expect(bad.status).toBeGreaterThanOrEqual(400)
    expect(JSON.stringify(await json(bad))).toMatch(/\$link at \/derivedFrom is bare hex/)
  })

  it('finds a version by ul:ver:, bare hex, or ulv3:, before and after the backfill', async () => {
    const { h, user, c, base } = await setup()
    const res = await push(h, user, base, [{ id: 'w1', type: 'Work', data: { title: 'One' } }])
    expect(res.status).toBe(201)
    const id = (await json(res)).hash as string
    expect(id).toMatch(/^ul:ver:[0-9a-f]{64}$/)
    const h64 = id.slice('ul:ver:'.length)
    const semverOf = async (v: string) =>
      (await json(await h.request(`${base}/versions/${encodeURIComponent(v)}`))).semver
    for (const v of [id, h64, `ulv3:${h64}`, h64.toUpperCase()])
      expect(await semverOf(v)).toBe('v1.0.0')
    expect((await h.request(`${base}/versions/ul:rec:${h64}`)).status).toBe(404)

    // A row as written before 2026-11-18: still found by every form, then moved.
    const where = and(eq(schema.versions.collectionId, c.id), eq(schema.versions.seq, 1))
    await h.ports.db
      .update(schema.versions)
      .set({ hash: `ulv3:${h64}` })
      .where(where)
    expect(await semverOf(id)).toBe('v1.0.0')
    expect(await semverOf(`ulv3:${h64}`)).toBe('v1.0.0')
    expect(await backfillVersionIds(h.ports)).toBeGreaterThanOrEqual(1)
    const [row] = await h.ports.db.select().from(schema.versions).where(where)
    expect(row!.hash).toBe(id)
    expect(await backfillVersionIds(h.ports)).toBe(0)

    // A second push follows the first, its commit naming it by bare hex.
    const two = await push(h, user, base, [{ id: 'w2', type: 'Work', data: { title: 'Two' } }])
    expect(two.status).toBe(201)
    // A link followed to where it can be read.
    const go = (q: string) =>
      h.request(`/api/links/resolve?${q}`, { headers: { accept: 'application/json' } })
    expect(await json(await go(`to=${id}&collection=${c.id}`))).toEqual({ url: '/org/lib/v/1.0.0' })
    expect(await json(await go(`to=ul:rec:${h64}&collection=${c.id}&type=Work&id=w%201`))).toEqual({
      url: `/org/lib/v/latest/records/Work/w%201?hash=${h64}`,
    })
    expect(await json(await go(`to=ul:asset:${h64}&collection=${c.id}`))).toEqual({
      url: `/api/collections/_/${c.id}/files/${h64}`,
    })
    expect(await json(await go(`to=ul:rec:${h64}`))).toEqual({ url: `/records/${h64}` })
    expect((await go(`to=${h64}`)).status).toBe(400)
    expect((await go(`to=${id}`)).status).toBe(404)
    expect((await go(`to=${id}&collection=nope`)).status).toBe(404)
    const redirect = await h.request(`/api/links/resolve?to=${id}&collection=${c.id}`)
    expect(redirect.status).toBe(302)
    expect(redirect.headers.get('location')).toBe('/org/lib/v/1.0.0')

    const log = await json(await h.request(`${base}/commits?after=0`, { user }))
    expect(JSON.parse(log.commits[1].commit).previous).toBe(h64)
  })
})
