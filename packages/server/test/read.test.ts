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
      removed: [{ id: 'b1', type: 'Book' }],
      meta: { schemaChanged: false },
    })
    expect(diff.updated[0]).toMatchObject({ id: 'b0', data: { title: 'Changed' } })
    // Without ?from=, a version is compared with the one before it; the first with nothing.
    expect(await json(await h.request(`${base}/versions/v1.1.0/diff`))).toEqual(diff)
    const first = await json(await h.request(`${base}/versions/v1.0.0/diff?limit=5000`))
    expect(first).toMatchObject({ from: null, to: 'v1.0.0', updated: [], removed: [] })
    expect(first.added).toHaveLength(1380)
    // Diff paging resumes without skipping or repeating.
    const p1 = await json(await h.request(`${base}/versions/v1.1.0/diff?from=v1.0.0&limit=2`))
    const p2 = await json(
      await h.request(
        `${base}/versions/v1.1.0/diff?from=v1.0.0&limit=2&cursor=${p1.pagination.nextCursor}`,
      ),
    )
    const ids = [
      ...p1.added,
      ...p1.updated,
      ...p1.removed,
      ...p2.added,
      ...p2.updated,
      ...p2.removed,
    ].map((x: any) => x.id)
    expect(ids.sort()).toEqual(['b0', 'b1', 'b999'])
  })

  it('lists moves between sets in a manifest delta, by who may read which set', async () => {
    const { h, user, base } = await setup()
    // a0000 private → public, a0001 public → private, both unchanged; a0010 private, changed.
    await pushDelta(h, user, base, { base: 'v1.0.0' }, [
      { id: 'a0000', type: 'Author', data: { name: 'Author 0' } },
      { id: 'a0001', type: 'Author', data: { name: 'Author 1' }, private: true },
      { id: 'a0010', type: 'Author', data: { name: 'Renamed' }, private: true },
    ])
    const since = (as?: string) =>
      h.request(`${base}/versions/v1.1.0/manifest?since=v1.0.0`, as ? { user: as } : {}).then(json)
    const member = (await since(user)).delta
    expect(member.added).toEqual([])
    expect(member.removed).toEqual([])
    const [a0, a1, a10] = member.updated
    expect(a0).toMatchObject({ id: 'a0000', previousPrivate: true })
    expect(a0.private).toBeUndefined()
    expect(a0.hash).toBe(a0.previousHash)
    expect(a1).toMatchObject({ id: 'a0001', private: true, previousPrivate: false })
    expect(a1.hash).toBe(a1.previousHash)
    expect(a10).toMatchObject({ id: 'a0010', private: true })
    expect(a10.hash).not.toBe(a10.previousHash)
    expect(a10.previousPrivate).toBeUndefined()
    // A public reader sees only the public set: one appeared, one left.
    const anon = (await since()).delta
    expect(anon.added).toEqual([{ id: 'a0000', type: 'Author', hash: a0.hash }])
    expect(anon.removed).toEqual([{ id: 'a0001', type: 'Author', hash: a1.hash }])
    expect(anon.updated).toEqual([])
  })

  it('marks members’ private lines in NDJSON and resumes a stream after a (type, id)', async () => {
    const { h, user, base } = await setup()
    const stream = async (query: string, as?: string) => {
      const res = await h.request(`${base}/versions/latest/records.ndjson${query}`, {
        ...(as ? { user: as } : {}),
      })
      expect(res.status).toBe(200)
      const text = await res.text()
      const lines = text ? text.trim().split('\n') : []
      // The count is exactly the lines sent.
      expect(Number(res.headers.get('x-underlay-record-count'))).toBe(lines.length)
      return lines
    }
    const all = await stream('', user)
    expect(all).toHaveLength(1501)
    const parsed = all.map((l) => JSON.parse(l))
    expect(parsed.filter((r) => r.private).length).toBe(121)
    expect(parsed[0]).toMatchObject({ id: 'a0000', type: 'Author', private: true })
    expect(parsed[0].hash).toMatch(/^[0-9a-f]{64}$/)
    expect(all[0]!.endsWith(`,"hash":"${parsed[0].hash}","private":true}`)).toBe(true)
    expect(parsed[1].private).toBeUndefined()
    expect(parsed.at(-1)).toMatchObject({ id: 's1', type: 'Secret', private: true })
    const anon = await stream('')
    expect(anon).toHaveLength(1380)
    expect(anon.some((l) => l.includes('"private"'))).toBe(false)

    // Resuming after any line continues with the next one, through later types.
    for (const [lines, as] of [
      [all, user],
      [anon, undefined],
    ] as const) {
      for (const i of [0, 1099, 1200, lines.length - 2, lines.length - 1]) {
        const r = JSON.parse(lines[i]!)
        const rest = await stream(`?after_type=${r.type}&after=${encodeURIComponent(r.id)}`, as)
        expect(rest).toEqual(lines.slice(i + 1))
      }
    }
    // An id that isn't there resumes at the next one after it.
    expect(await stream('?after_type=Author&after=a1199z')).toEqual(
      anon.filter((l) => JSON.parse(l).type === 'Book'),
    )
    // Within a type, as before.
    const books = anon.filter((l) => JSON.parse(l).type === 'Book')
    expect(await stream('?type=Book&after=b5')).toEqual(
      books.filter((l) => JSON.parse(l).id > 'b5'),
    )
    // `after` alone is ambiguous across types.
    const bad = await h.request(`${base}/versions/latest/records.ndjson?after=b5`)
    expect(bad.status).toBe(400)
    expect((await bad.json()).error).toMatch(/after_type/)
    expect((await h.request(`${base}/versions/latest/records.ndjson?after_type=Book`)).status).toBe(
      400,
    )
  })

  it('hides private collections entirely', async () => {
    const { h, base } = await setup()
    await h.ports.db.update(schema.collections).set({ public: false })
    expect((await h.request(base)).status).toBe(404)
    expect((await h.request(`${base}/versions/latest/records`)).status).toBe(404)
    expect((await json(await h.request('/api/collections'))).collections).toEqual([])
  })
})
