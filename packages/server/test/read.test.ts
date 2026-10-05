import { afterAll, describe, expect, it } from 'vitest'

import * as schema from '../src/db/schema.js'
import { cleanup, type Harness, harness } from './harness.js'

afterAll(cleanup)

const Author = { type: 'object', properties: { name: { type: 'string' } } }
const Book = { type: 'object', properties: { title: { type: 'string' } } }
const Secret = { type: 'object', private: true, properties: { note: { type: 'string' } } }

async function json(res: Response) {
  expect(res.headers.get('content-type') ?? '').toMatch(/json/)
  return (await res.json()) as any
}

async function pushDelta(
  h: Harness,
  user: string,
  base: string,
  body: object,
  records: object[],
  deletes: object[] = [],
) {
  const sid = (await json(await h.request(`${base}/push`, { method: 'POST', user, json: body })))
    .session_id
  for (let i = 0; i < records.length; i += 5000) {
    const r = await h.request(`${base}/push/${sid}/records`, {
      method: 'POST',
      user,
      ndjson: records.slice(i, i + 5000),
    })
    expect(r.status).toBe(200)
  }
  if (deletes.length)
    await h.request(`${base}/push/${sid}/deletes`, { method: 'POST', user, ndjson: deletes })
  const res = await h.request(`${base}/push/${sid}/commit`, { method: 'POST', user })
  expect(res.status).toBe(201)
  return json(res)
}

async function setup() {
  const h = await harness()
  const user = await h.member()
  const c = await h.collection('lib')
  await h.ports.db.update(schema.collections).set({ public: true })
  const base = '/api/collections/org/lib'
  const authors = Array.from({ length: 1200 }, (_, i) => ({
    id: `a${String(i).padStart(4, '0')}`,
    type: 'Author',
    data: { name: `Author ${i}` },
    ...(i % 10 === 0 ? { private: true } : {}),
  }))
  const books = Array.from({ length: 300 }, (_, i) => ({
    id: `b${i}`,
    type: 'Book',
    data: { title: `Book ${i}` },
  }))
  const secrets = [{ id: 's1', type: 'Secret', data: { note: 'hidden' } }]
  await pushDelta(
    h,
    user,
    base,
    {
      schemas: { Author, Book, Secret },
      metadata: { title: 'Library', description: 'Books', tags: ['lit'] },
    },
    [...authors, ...books, ...secrets],
  )
  return { h, user, c, base }
}

describe('read API', () => {
  it('serves collections and versions with owner and public views', async () => {
    const { h, user, base } = await setup()
    const anon = await json(await h.request(base))
    expect(anon).toMatchObject({
      slug: 'lib',
      ownerSlug: 'org',
      description: 'Books',
      versionCount: 1,
    })
    expect(anon.latestVersion).toMatchObject({
      semver: 'v1.0.0',
      recordCount: 1380,
      metadata: { title: 'Library' },
    })
    expect(anon.latestVersion.typeCounts).toEqual([
      { type: 'Author', count: 1080 },
      { type: 'Book', count: 300 },
    ])
    const owner = await json(await h.request(base, { user }))
    expect(owner.latestVersion.recordCount).toBe(1501)

    const list = await json(await h.request('/api/collections'))
    expect(list.collections[0]).toMatchObject({
      slug: 'lib',
      tags: ['lit'],
      latestVersion: 'v1.0.0',
      recordCount: 1380,
    })
    expect(list.facets.tags).toEqual([{ name: 'lit', count: 1 }])

    const v = await json(await h.request(`${base}/versions/v1.0.0`))
    expect(Object.keys(v.schemas)).toEqual(['Author', 'Book'])
    expect(v.typeCounts).toEqual({ Author: 1080, Book: 300 })
    const vOwner = await json(await h.request(`${base}/versions/latest`, { user }))
    expect(Object.keys(vOwner.schemas)).toEqual(['Author', 'Book', 'Secret'])
    expect((await json(await h.request(`${base}/versions`)))[0]).toMatchObject({ semver: 'v1.0.0' })
  })

  it('serves a records page in the version call, with only its type’s schema', async () => {
    const { h, user, base } = await setup()
    const first = await json(await h.request(`${base}/versions/latest?records=&limit=10`, { user }))
    expect(Object.keys(first.schemas)).toEqual(['Author'])
    expect(Object.keys(first.typeCounts).sort()).toEqual(['Author', 'Book', 'Secret'])
    expect(first.recordsPage).toMatchObject({ type: 'Author', total: 1200 })
    expect(first.recordsPage.records).toHaveLength(10)
    const books = await json(
      await h.request(`${base}/versions/latest?records=Book&offset=295&limit=10`),
    )
    expect(Object.keys(books.schemas)).toEqual(['Book'])
    expect(books.recordsPage.records).toHaveLength(5)
    // Without ?records, every schema as before, and no page.
    const plain = await json(await h.request(`${base}/versions/latest`))
    expect(Object.keys(plain.schemas).sort()).toEqual(['Author', 'Book'])
    expect(plain.recordsPage).toBeUndefined()
  })

  it('pages records by offset and by cursor, within and across types', async () => {
    const { h, user, base } = await setup()
    // Offset deep in a type (v1 refused offsets past 10k; here it's a seek).
    let r = await json(
      await h.request(`${base}/versions/latest/records?type=Author&offset=1000&limit=5`),
    )
    expect(r.records.map((x: any) => x.id)).toEqual(['a1112', 'a1113', 'a1114', 'a1115', 'a1116'])
    expect(r.pagination.total).toBe(1080)
    r = await json(
      await h.request(`${base}/versions/latest/records?type=Author&offset=1000&limit=5`, { user }),
    )
    expect(r.records.map((x: any) => x.id)).toEqual(['a1000', 'a1001', 'a1002', 'a1003', 'a1004'])

    // Cursor paging across types visits every visible record once, in (type, id) order.
    const seen: string[] = []
    let cursor: string | null = null
    do {
      const page: any = await json(
        await h.request(
          `${base}/versions/latest/records?limit=400${cursor ? `&cursor=${cursor}` : ''}`,
        ),
      )
      seen.push(...page.records.map((x: any) => `${x.type}/${x.id}`))
      cursor = page.pagination.nextCursor
    } while (cursor)
    expect(seen.length).toBe(1380)
    expect(new Set(seen).size).toBe(1380)
    expect(seen.some((s) => s.startsWith('Secret/'))).toBe(false)
    // An offset across types lands in the second type.
    r = await json(await h.request(`${base}/versions/latest/records?offset=1081&limit=1`))
    expect(r.records[0]).toMatchObject({ type: 'Book', id: 'b1' })
    expect(r.records[0].hash).toMatch(/^[0-9a-f]{64}$/)

    // Members' private records say so; public ones don't carry the field.
    r = await json(await h.request(`${base}/versions/latest/records?type=Author&limit=2`, { user }))
    expect(r.records.map((x: any) => [x.id, x.private])).toEqual([
      ['a0000', true],
      ['a0001', undefined],
    ])
  })

  it('streams NDJSON, and serves manifests (full and delta) and diffs', async () => {
    const { h, user, base } = await setup()
    const res = await h.request(`${base}/versions/latest/records.ndjson?type=Book`)
    expect(res.headers.get('x-underlay-record-count')).toBe('300')
    const lines = (await res.text())
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(lines.length).toBe(300)
    expect(lines[0]).toMatchObject({ id: 'b0', type: 'Book', data: { title: 'Book 0' } })

    const pages: any[] = []
    let cursor: string | null = null
    do {
      const m: any = await json(
        await h.request(
          `${base}/versions/latest/manifest?limit=500${cursor ? `&cursor=${cursor}` : ''}`,
          { user },
        ),
      )
      pages.push(m)
      cursor = m.pagination.nextCursor
    } while (cursor)
    const entries = pages.flatMap((p) => p.records)
    expect(entries.length).toBe(1501)
    expect(entries.filter((e) => e.private).length).toBe(121)

    // Second version: one update, one delete, one add.
    await pushDelta(
      h,
      user,
      base,
      { base: 'v1.0.0' },
      [
        { id: 'b0', type: 'Book', data: { title: 'Changed' } },
        { id: 'b999', type: 'Book', data: { title: 'New' } },
      ],
      [{ type: 'Book', id: 'b1' }],
    )
    const delta = await json(await h.request(`${base}/versions/v1.1.0/manifest?since=v1.0.0`))
    expect(delta.delta.updated.map((x: any) => x.id)).toEqual(['b0'])
    expect(delta.delta.removed.map((x: any) => x.id)).toEqual(['b1'])
    expect(delta.delta.added.map((x: any) => x.id)).toEqual(['b999'])
    const diff = await json(await h.request(`${base}/versions/v1.1.0/diff?from=v1.0.0`))
    expect(diff).toMatchObject({
      from: 'v1.0.0',
      to: 'v1.1.0',
      removed: ['b1'],
      meta: { schemaChanged: false },
    })
    expect(diff.updated[0]).toMatchObject({ id: 'b0', data: { title: 'Changed' } })
    // Diff paging resumes without skipping or repeating.
    const p1 = await json(await h.request(`${base}/versions/v1.1.0/diff?from=v1.0.0&limit=2`))
    const p2 = await json(
      await h.request(
        `${base}/versions/v1.1.0/diff?from=v1.0.0&limit=2&cursor=${p1.pagination.nextCursor}`,
      ),
    )
    const ids = [...p1.added, ...p1.updated, ...p2.added, ...p2.updated]
      .map((x: any) => x.id)
      .concat(p1.removed, p2.removed)
    expect(ids.sort()).toEqual(['b0', 'b1', 'b999'])
  })

  it('hides private collections entirely', async () => {
    const { h, base } = await setup()
    await h.ports.db.update(schema.collections).set({ public: false })
    expect((await h.request(base)).status).toBe(404)
    expect((await h.request(`${base}/versions/latest/records`)).status).toBe(404)
    expect((await json(await h.request('/api/collections'))).collections).toEqual([])
  })
})
