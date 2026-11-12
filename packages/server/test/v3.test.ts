/**
 * What is particular to a v3 collection (v3-deploy-plan.md, Phase 1): the read routes end
 * to end on a public collection, privacy by collection, rows that change nothing, a type
 * dropped, a schema tightened, assets, the rebuild and sweep jobs, and D1 catching up
 * with the log. Runs on the v3 project only; the rest of the suite runs on every layout.
 */
import { createHash } from 'node:crypto'

import { hashRecord, memoryStore, v3 } from '@underlay/protocol'
import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'

import * as schema from '../src/db/schema.js'
import { lastRow, syncCatalog } from '../src/v3/catalog.js'
import { v3JobConfig } from '../src/v3/jobs.js'
import { landCommit, type Landing } from '../src/v3/landing.js'
import { durableQueue, serially } from '../src/v3/queue.js'
import { scanConfig } from '../src/v3/scans.js'
import { cleanup, type Harness, harness } from './harness.js'
import { onV3 } from './layouts.js'

afterAll(cleanup)

const Author = {
  type: 'object',
  properties: { name: { type: 'string' }, born: { type: 'integer' } },
  required: ['name'],
}
const Book = {
  type: 'object',
  properties: { title: { type: 'string' }, cover: { type: 'object' } },
  required: ['title'],
}
const json = async (r: Response) => (await r.json()) as Record<string, any>
const sha = (b: string) => createHash('sha256').update(b).digest('hex')
const author = (id: string, name: string, extra: object = {}) => ({
  id,
  type: 'Author',
  data: { name },
  ...extra,
})

async function setup(opts: { public?: boolean } = {}) {
  const h = await harness({ newCollections: 'v3' })
  const user = await h.member()
  const c = await h.collection('lib', { recordLayout: 'v3' })
  if (opts.public ?? true) {
    await h.ports.db
      .update(schema.collections)
      .set({ public: true })
      .where(eq(schema.collections.id, c.id))
  }
  return { h, user, c, base: '/api/collections/org/lib' }
}

/** Open a session, send records and deletes, commit; the commit's response. */
async function push(
  h: Harness,
  user: string,
  base: string,
  body: object,
  records: object[] = [],
  deletes: object[] = [],
) {
  const opened = await h.request(`${base}/push`, { method: 'POST', user, json: body })
  if (opened.status !== 200) return opened
  const sid = (await json(opened)).session_id as string
  for (let i = 0; i < records.length; i += 5000) {
    const r = await h.request(`${base}/push/${sid}/records`, {
      method: 'POST',
      user,
      ndjson: records.slice(i, i + 5000),
    })
    if (r.status !== 200) return r
  }
  if (deletes.length) {
    const r = await h.request(`${base}/push/${sid}/deletes`, {
      method: 'POST',
      user,
      ndjson: deletes,
    })
    if (r.status !== 200) return r
  }
  const res = await h.request(`${base}/push/${sid}/commit`, { method: 'POST', user })
  await h.drain()
  return res
}

describe.skipIf(!onV3)('v3 collections', () => {
  it('commits to the log in the bucket and records each version in D1', async () => {
    const { h, user, c, base } = await setup()
    const authors = Array.from({ length: 120 }, (_, i) =>
      author(`a${String(i).padStart(3, '0')}`, `Author ${i}`),
    )
    let res = await push(
      h,
      user,
      base,
      { schemas: { Author, Book }, metadata: { title: 'Library' } },
      [...authors, { id: 'b1', type: 'Book', data: { title: 'One' } }],
    )
    expect(res.status).toBe(201)
    const v1 = await json(res)
    expect(v1).toMatchObject({ semver: 'v1.0.0', recordCount: 121, changes: { added: 121 } })
    expect(v1.hash).toMatch(/^ulv3:[0-9a-f]{64}$/)

    // The bucket has the commit; its id is the D1 row's.
    const head = await v3.findHead(h.ports.stores.v3, c.id)
    expect(head?.id).toBe(v1.hash)
    expect(head?.commit.changes[0]?.keyId).toBeNull()
    expect(head?.commit.keyId).not.toBeNull()

    // An update, a removal, and a removal of something never there.
    res = await push(
      h,
      user,
      base,
      { base: 'v1.0.0' },
      [author('a000', 'Ada')],
      [
        { type: 'Author', id: 'a001' },
        { type: 'Author', id: 'nobody' },
      ],
    )
    expect(res.status).toBe(201)
    expect(await json(res)).toMatchObject({
      semver: 'v1.1.0',
      recordCount: 120,
      changes: { added: 0, removed: 1, updated: 1 },
    })
    const row = (await lastRow(h.ports, c.id))!
    expect(row).toMatchObject({ seq: 2, typeCounts: { Author: 119, Book: 1 }, hasPrivate: false })
    const [col] = await h.ports.db
      .select()
      .from(schema.collections)
      .where(eq(schema.collections.id, c.id))
    expect(col!.headVersionId).toBe(row.id)
    expect(col!.versionCount).toBe(2)
    expect(col!.summary).toMatchObject({ title: 'Library' })

    // The same records again change nothing: refused, and nothing is committed.
    res = await push(h, user, base, { base: 'v1.1.0' }, [author('a000', 'Ada')])
    expect(res.status).toBe(409)
    expect(await json(res)).toMatchObject({ error: 'No changes detected' })
    expect(await v3.headNumber(h.ports.stores.v3, c.id)).toBe(2)
  })

  it('serves every read route from the log', async () => {
    const { h, user, base } = await setup()
    const authors = Array.from({ length: 30 }, (_, i) =>
      author(`a${String(i).padStart(2, '0')}`, `Author ${i}`),
    )
    const books = Array.from({ length: 5 }, (_, i) => ({
      id: `b${i}`,
      type: 'Book',
      data: { title: `B${i}` },
    }))
    expect(
      (
        await push(h, user, base, { schemas: { Author, Book }, metadata: { title: 'L' } }, [
          ...authors,
          ...books,
        ])
      ).status,
    ).toBe(201)
    expect(
      (
        await push(
          h,
          user,
          base,
          { base: 'v1.0.0' },
          [author('a05', 'Renamed')],
          [{ type: 'Book', id: 'b0' }],
        )
      ).status,
    ).toBe(201)

    const detail = await json(await h.request(`${base}/versions/latest?records=Book&limit=2`))
    expect(detail).toMatchObject({
      semver: 'v1.1.0',
      metadata: { title: 'L' },
      typeCounts: { Author: 30, Book: 4 },
      recordsPage: { type: 'Book', total: 4 },
    })
    expect(Object.keys(detail.schemas)).toEqual(['Book'])
    expect(detail.recordsPage.records.map((r: { id: string }) => r.id)).toEqual(['b1', 'b2'])

    // Pages across types: by offset, then by cursor, in (type, id) order.
    let page = await json(await h.request(`${base}/versions/latest/records?limit=20&offset=25`))
    expect(page.records.map((r: { id: string }) => r.id)).toEqual([
      'a25',
      'a26',
      'a27',
      'a28',
      'a29',
      'b1',
      'b2',
      'b3',
      'b4',
    ])
    expect(page.pagination).toMatchObject({ hasMore: false, total: 34 })
    page = await json(await h.request(`${base}/versions/latest/records?type=Author&limit=10`))
    const seen = page.records.map((r: { id: string }) => r.id)
    page = await json(
      await h.request(
        `${base}/versions/latest/records?type=Author&limit=100&cursor=${page.pagination.nextCursor}`,
      ),
    )
    seen.push(...page.records.map((r: { id: string }) => r.id))
    expect(seen).toEqual(authors.map((a) => a.id))

    // One record, at a version and at another; its history.
    const one = await json(await h.request(`${base}/versions/v1.0.0/records/Author/a05`))
    expect(one).toMatchObject({ data: { name: 'Author 5' }, semver: 'v1.0.0' })
    expect(one.hash).toBe(hashRecord('a05', 'Author', { name: 'Author 5' }).hash)
    expect((await h.request(`${base}/versions/latest/records/Book/b0`)).status).toBe(404)
    const history = await json(await h.request(`${base}/records/Author/a05/history`))
    expect(
      history.changes.map((x: { change: string; semver: string }) => [x.change, x.semver]),
    ).toEqual([
      ['added', 'v1.0.0'],
      ['updated', 'v1.1.0'],
    ])

    // NDJSON, whole and resumed after a key.
    let res = await h.request(`${base}/versions/latest/records.ndjson`)
    expect(res.headers.get('x-underlay-record-count')).toBe('34')
    let lines = (await res.text())
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(lines).toHaveLength(34)
    expect(lines[0]).toMatchObject({ id: 'a00', type: 'Author', hash: expect.any(String) })
    res = await h.request(`${base}/versions/latest/records.ndjson?after_type=Author&after=a28`)
    lines = (await res.text())
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(lines.map((l) => l.id)).toEqual(['a29', 'b1', 'b2', 'b3', 'b4'])
    expect(res.headers.get('x-underlay-record-count')).toBe('5')

    // The diff: one updated, one removed, nothing about the schemas.
    const diff = await json(await h.request(`${base}/versions/latest/diff`))
    expect(diff).toMatchObject({
      from: 'v1.0.0',
      to: 'v1.1.0',
      added: [],
      removed: [{ id: 'b0', type: 'Book' }],
      meta: { schemaChanged: false, metadataChanged: false, filesAdded: 0 },
    })
    expect(diff.updated).toEqual([{ id: 'a05', type: 'Author', data: { name: 'Renamed' } }])
    // The first version against nothing, a page at a time.
    const first = await json(await h.request(`${base}/versions/v1.0.0/diff?limit=20`))
    expect(first.added).toHaveLength(20)
    expect(first.meta.schemaChanged).toBe(true)
    const rest = await json(
      await h.request(
        `${base}/versions/v1.0.0/diff?limit=20&cursor=${first.pagination.nextCursor}`,
      ),
    )
    expect(rest.added).toHaveLength(15)
    expect(rest.pagination.hasMore).toBe(false)

    // By id, too; the versions list; what v3 does not serve yet says so.
    const row = await json(await h.request(`${base}/versions/latest`))
    expect((await json(await h.request(`${base}/versions/${row.hash}`))).semver).toBe('v1.1.0')
    expect(
      (await json(await h.request(`${base}/versions`))).map((v: { semver: string }) => v.semver),
    ).toEqual(['v1.1.0', 'v1.0.0'])

    // The manifest: ids and hashes in key order, paged; and what changed since a version.
    let m = await json(await h.request(`${base}/versions/latest/manifest?limit=20`))
    expect(m.records).toHaveLength(20)
    expect(m.records[0]).toEqual({
      id: 'a00',
      type: 'Author',
      hash: hashRecord('a00', 'Author', { name: 'Author 0' }).hash,
    })
    expect(Object.keys(m.schemas)).toEqual(['Author', 'Book'])
    const listed = m.records.map((r: { id: string }) => r.id)
    m = await json(
      await h.request(
        `${base}/versions/latest/manifest?limit=20&cursor=${m.pagination.nextCursor}`,
      ),
    )
    listed.push(...m.records.map((r: { id: string }) => r.id))
    expect(listed).toHaveLength(34)
    expect(m.pagination.hasMore).toBe(false)
    m = await json(await h.request(`${base}/versions/latest/manifest?since=v1.0.0`))
    expect(m.delta).toMatchObject({
      added: [],
      updated: [{ id: 'a05', type: 'Author', previousHash: one.hash }],
      removed: [{ id: 'b0', type: 'Book' }],
    })

    // What v3 does not serve yet says so.
    res = await h.request(`${base}/versions/latest/records.ndjson.gz`)
    expect(res.status).toBe(501)
    expect(await json(res)).toMatchObject({ code: 'not_on_v3' })
  })

  it('keeps no private records or types in a public collection, and takes them in a private one', async () => {
    const { h, user, base } = await setup()
    let res = await push(h, user, base, { schemas: { Author: { ...Author, private: true } } })
    expect(res.status).toBe(422)
    expect((await json(res)).error).toMatch(/public, and keeps no private types: Author/)
    res = await push(h, user, base, { schemas: { Author } }, [author('a', 'A', { private: true })])
    expect(res.status).toBe(422)
    expect((await json(res)).error).toMatch(/keeps no private records/)

    const priv = await setup({ public: false })
    res = await push(priv.h, priv.user, priv.base, { schemas: { Author } }, [
      author('a', 'A', { private: true }),
    ])
    expect(res.status).toBe(201)
    // A private collection is all hidden from others, and all there for members.
    expect((await priv.h.request(`${priv.base}/versions/latest`)).status).toBe(404)
    expect(
      (await priv.h.request(`${priv.base}/versions/latest/records/Author/a`, { user: priv.user }))
        .status,
    ).toBe(200)
  })

  it('drops a type with its records, and checks the records a tightened schema keeps', async () => {
    const { h, user, c, base } = await setup()
    await push(h, user, base, { schemas: { Author, Book } }, [
      author('a', 'A'),
      author('b', 'B'),
      { id: 'x', type: 'Book', data: { title: 'X' } },
    ])
    // Tighten Author so the records already there fail it: refused, with the reason.
    const strict = { ...Author, required: ['name', 'born'] }
    let res = await push(h, user, base, { base: 'v1.0.0', schemas: { Author: strict, Book } })
    expect(res.status).toBe(422)
    expect(JSON.stringify(await json(res))).toMatch(/does not satisfy the new schema/)
    // Drop Book: its schema and its record go, as a major version.
    res = await push(h, user, base, { base: 'v1.0.0', schemas: { Author } })
    expect(res.status).toBe(201)
    expect(await json(res)).toMatchObject({
      semver: 'v2.0.0',
      recordCount: 2,
      changes: { removed: 1 },
    })
    expect((await lastRow(h.ports, c.id))!.typeCounts).toEqual({ Author: 2 })
    const usage = await h.ports.db
      .select()
      .from(schema.schemaUsage)
      .where(eq(schema.schemaUsage.collectionId, c.id))
    expect(usage.find((u) => u.typeSlug === 'Book')?.toSeq).toBe(2)
    expect(usage.filter((u) => u.toSeq === null).map((u) => u.typeSlug)).toEqual(['Author'])
  })

  it('keeps declared and referenced files as assets in the v3 area, and lists them', async () => {
    const { h, user, c, base } = await setup()
    const cover = 'a cover'
    const loose = 'a loose file'
    const never = 'never uploaded'
    for (const f of [cover, loose])
      expect(
        (await h.request(`${base}/files/${sha(f)}`, { method: 'PUT', user, body: f })).status,
      ).toBe(201)
    let res = await push(
      h,
      user,
      base,
      { schemas: { Book }, files: { add: [sha(loose), sha(never)] } },
      [{ id: 'x', type: 'Book', data: { title: 'X', cover: { $file: `sha256:${sha(cover)}` } } }],
    )
    expect(res.status).toBe(422)
    expect(await json(res)).toMatchObject({ error: 'Missing files', filesNeeded: [sha(never)] })

    res = await push(h, user, base, { schemas: { Book }, files: { add: [sha(loose)] } }, [
      { id: 'x', type: 'Book', data: { title: 'X', cover: { $file: `sha256:${sha(cover)}` } } },
    ])
    expect(res.status).toBe(201)
    expect(await json(res)).toMatchObject({ fileCount: 2 })
    // Both are assets, the loose one included (no record names it), with their bytes copied in.
    const files = await json(await h.request(`${base}/versions/latest/files`))
    expect(files.map((f: { hash: string }) => f.hash).sort()).toEqual(
      [sha(cover), sha(loose)].sort(),
    )
    for (const f of [cover, loose]) {
      const obj = await h.ports.stores.v3.get(`assets/${sha(f)}`)
      expect(await obj!.text()).toBe(f)
    }
    const row = (await lastRow(h.ports, c.id))!
    expect(row.assetBytes).toBe(cover.length + loose.length)
    // Removing the loose file removes its asset row.
    res = await push(h, user, base, { base: 'v1.0.0', files: { remove: [sha(loose)] } })
    expect(res.status).toBe(201)
    expect(await json(res)).toMatchObject({ semver: 'v1.0.1', fileCount: 1 })
    const diff = await json(await h.request(`${base}/versions/latest/diff`))
    expect(diff.meta).toMatchObject({ filesRemoved: 1, filesAdded: 0 })
  })

  it('rebuilds after commits, prunes old layouts, and sweeps only the v3 area', async () => {
    const { h, user, c, base } = await setup()
    let semver: string | null = null
    for (let i = 0; i < 12; i++) {
      const res = await push(
        h,
        user,
        base,
        { ...(semver ? { base: semver } : { schemas: { Author } }) },
        [author(`a${i}`, `A${i}`)],
      )
      expect(res.status).toBe(201)
      semver = (await json(res)).semver
    }
    const store = h.ports.stores.v3
    const layout = await v3.findLayout(store, c.id)
    expect(layout).not.toBeNull()
    const { keys } = await store.list(`collections/${c.id}/layouts/`)
    expect(keys.length).toBeLessThanOrEqual(3)
    // Reads go through the layout and are unchanged.
    const page = await json(await h.request(`${base}/versions/latest/records?limit=100`))
    expect(page.records).toHaveLength(12)

    // The sweep: a pass over the v3 area, nothing of v2's touched.
    await h.bucket.put('repo/nodes/untouched', 'v2')
    await h.ports.jobs.enqueue({ type: 'v3.sweep' })
    await h.drain()
    expect(await h.bucket.head('repo/nodes/untouched')).not.toBeNull()
    expect(
      (await json(await h.request(`${base}/versions/latest/records?limit=100`))).records,
    ).toHaveLength(12)
  })

  it('merges a large round in key-range units, one job each, and lays them out', async () => {
    const { h, user, c, base } = await setup()
    const saved = { ...v3JobConfig }
    // Units of a few hundred bytes of lines: every round of merging is cut into several.
    Object.assign(v3JobConfig, { unitBytes: 400, adoptAfter: 4, ratio: 2 })
    try {
      let semver: string | null = null
      const all = new Map<string, string>()
      for (let i = 0; i < 10; i++) {
        const rows = Array.from({ length: 6 }, (_, j) =>
          author(`a${(i * 7 + j * 3) % 25}`, `n${i}-${j}`),
        )
        for (const r of rows) all.set(r.id, r.data.name)
        const res = await push(
          h,
          user,
          base,
          semver ? { base: semver } : { schemas: { Author } },
          rows,
        )
        expect(res.status).toBe(201)
        semver = (await json(res)).semver
      }
      const store = h.ports.stores.v3
      const layout = await v3.findLayout(store, c.id)
      expect(layout).not.toBeNull()
      // Merged groups: labeled files, from more than one unit.
      expect(layout!.files.some((f) => f.labeled)).toBe(true)
      const { keys } = await h.ports.stores.internal.list('v3-rebuilds/')
      expect(keys).toEqual([])
      const page = await json(await h.request(`${base}/versions/latest/records?limit=100`))
      expect(Object.fromEntries(page.records.map((r: any) => [r.id, r.data.name]))).toEqual(
        Object.fromEntries(all),
      )
    } finally {
      Object.assign(v3JobConfig, saved)
    }
  })

  it('takes an upload the client built: files by presigned URL, verified a job each, then landed', async () => {
    const { h, user, c, base } = await setup()
    const build = async (rows: v3.LineRow[]) => {
      const local = memoryStore()
      const session = v3.newSession()
      const files = await v3.buildFiles(rows.sort(v3.compareKey), v3.uploadTarget(local, session), {
        cutBytes: 2000,
      })
      return files.map((f) => ({
        ref: {
          id: f.id,
          first: f.first,
          last: f.last,
          entries: f.entries,
          records: f.records,
          removals: f.removals,
          bytes: f.bytes,
        },
        bytes: local.objects.get(v3.uploadKey(session, f.id))!.bytes,
      }))
    }
    const send = async (files: Awaited<ReturnType<typeof build>>, body: object = {}) => {
      const opened = await json(
        await h.request(`${base}/uploads`, { method: 'POST', user, json: body }),
      )
      const id = opened.upload_id as string
      for (const f of files) {
        const res = await json(
          await h.request(`${base}/uploads/${id}/files`, {
            method: 'POST',
            user,
            json: { id: f.ref.id, size: f.bytes.byteLength },
          }),
        )
        expect(res.method).toBe('PUT')
        // The client's PUT to the presigned URL.
        await h.bucket.put(String(res.url).replace('memory://put/', ''), f.bytes)
      }
      const status = await json(await h.request(`${base}/uploads/${id}`, { user }))
      expect(status.present.sort()).toEqual(files.map((f) => f.ref.id).sort())
      const res = await h.request(`${base}/uploads/${id}/commit`, {
        method: 'POST',
        user,
        json: { files: files.map((f) => f.ref) },
      })
      expect(res.status).toBe(202)
      await h.drain()
      return json(await h.request(`${base}/uploads/${id}`, { user }))
    }
    const authors = Array.from({ length: 300 }, (_, i) =>
      v3.rowFromRecord(`a${String(i).padStart(3, '0')}`, 'Author', { name: `Author ${i}` }),
    )
    let up = await send(
      await build([v3.rowFromRecord('Author', v3.SCHEMA_TYPE, Author), ...authors]),
      {
        message: 'first load',
      },
    )
    expect(up).toMatchObject({
      status: 'committed',
      result: { semver: 'v1.0.0', recordCount: 300 },
    })
    expect(up.files_named).toBeGreaterThan(1)
    // A second upload: an update, a removal, a new record; counted against the head.
    up = await send(
      await build([
        v3.rowFromRecord('a000', 'Author', { name: 'Ada' }),
        v3.removalRow('a001', 'Author'),
        v3.rowFromRecord('z999', 'Author', { name: 'Zed' }),
      ]),
    )
    expect(up).toMatchObject({
      status: 'committed',
      result: { semver: 'v1.1.0', recordCount: 300, changes: { added: 1, removed: 1, updated: 1 } },
    })
    expect(
      (await json(await h.request(`${base}/versions/latest/records/Author/a000`))).data,
    ).toEqual({ name: 'Ada' })
    // A record its schema refuses fails the upload, with the reason.
    up = await send(await build([v3.rowFromRecord('bad', 'Author', { born: 3 })]))
    expect(up.status).toBe('failed')
    expect(JSON.stringify(up.error)).toMatch(/bad/)
    expect((await lastRow(h.ports, c.id))!.seq).toBe(2)
    // Not for a v2 collection.
    await h.collection('old', { recordLayout: 'today' })
    expect(
      (await h.request('/api/collections/org/old/uploads', { method: 'POST', user, json: {} }))
        .status,
    ).toBe(409)
  })

  it('scans records under a tightened schema in key-range units, before landing', async () => {
    const { h, user, c, base } = await setup()
    const saved = { ...scanConfig }
    Object.assign(scanConfig, { inlineRecords: 0, unitRecords: 40 })
    try {
      const Num = { type: 'object', properties: { n: { type: 'integer' } } }
      const rows = Array.from({ length: 200 }, (_, i) => ({
        id: `r${String(i).padStart(3, '0')}`,
        type: 'Num',
        data: { n: i },
      }))
      expect((await push(h, user, base, { schemas: { Num } }, rows)).status).toBe(201)
      // Tightened so that 50 of the records left fail: the push waits on the scan's units, then fails.
      const strict = { type: 'object', properties: { n: { type: 'integer', maximum: 149 } } }
      let res = await push(h, user, base, { base: 'v1.0.0', schemas: { Num: strict } })
      expect(res.status).toBe(202)
      const sid = (await json(res)).session_id
      let s = await json(await h.request(`${base}/push/${sid}`, { user }))
      expect(s.status).toBe('failed')
      expect(JSON.stringify(s.error)).toMatch(/does not satisfy the new schema/)
      expect(await v3.headNumber(h.ports.stores.v3, c.id)).toBe(1)
      // The same, with the failing records replaced in the push: it scans in units and lands.
      res = await push(
        h,
        user,
        base,
        { base: 'v1.0.0', schemas: { Num: strict } },
        rows.slice(150).map((r) => ({ ...r, data: { n: 1 } })),
      )
      expect(res.status).toBe(202)
      s = await json(await h.request(`${base}/push/${(await json(res)).session_id}`, { user }))
      expect(s).toMatchObject({ status: 'committed', result: { semver: 'v2.0.0' } })
      const { keys } = await h.ports.stores.internal.list('v3-scans/')
      expect(keys).toEqual([])
    } finally {
      Object.assign(scanConfig, saved)
    }
  })

  it('waits for both its files and its scan before an upload lands', async () => {
    const { h, user, base } = await setup()
    const send = async (rows: v3.LineRow[]) => {
      const local = memoryStore()
      const session = v3.newSession()
      const built = await v3.buildFiles(rows.sort(v3.compareKey), v3.uploadTarget(local, session))
      const id = (
        await json(await h.request(`${base}/uploads`, { method: 'POST', user, json: {} }))
      ).upload_id as string
      for (const f of built) {
        const bytes = local.objects.get(v3.uploadKey(session, f.id))!.bytes
        const t = await json(
          await h.request(`${base}/uploads/${id}/files`, {
            method: 'POST',
            user,
            json: { id: f.id, size: bytes.byteLength },
          }),
        )
        await h.bucket.put(String(t.url).replace('memory://put/', ''), bytes)
      }
      const files = built.map(({ size: _s, labeled: _l, commits: _c, ...ref }) => ref)
      await h.request(`${base}/uploads/${id}/commit`, { method: 'POST', user, json: { files } })
      await h.drain()
      return json(await h.request(`${base}/uploads/${id}`, { user }))
    }
    const Num = { type: 'object', properties: { n: { type: 'integer' } } }
    const strict = { type: 'object', properties: { n: { type: 'integer', maximum: 149 } } }
    const nums = Array.from({ length: 200 }, (_, i) =>
      v3.rowFromRecord(`r${String(i).padStart(3, '0')}`, 'Num', { n: i }),
    )
    expect((await send([v3.rowFromRecord('Num', v3.SCHEMA_TYPE, Num), ...nums])).status).toBe(
      'committed',
    )
    const saved = { ...scanConfig }
    Object.assign(scanConfig, { inlineRecords: 0, unitRecords: 40 })
    try {
      let up = await send([v3.rowFromRecord('Num', v3.SCHEMA_TYPE, strict)])
      expect(up.status).toBe('failed')
      expect(JSON.stringify(up.error)).toMatch(/does not satisfy the new schema/)
      up = await send([
        v3.rowFromRecord('Num', v3.SCHEMA_TYPE, strict),
        ...nums.slice(150).map((r) => v3.rowFromRecord(r.id, 'Num', { n: 0 })),
      ])
      expect(up).toMatchObject({ status: 'committed', result: { semver: 'v2.0.0' } })
    } finally {
      Object.assign(scanConfig, saved)
    }
  })

  it('writes the D1 rows of a commit the bucket has and D1 lacks', async () => {
    const { h, user, c, base } = await setup()
    expect((await push(h, user, base, { schemas: { Author } }, [author('a', 'A')])).status).toBe(
      201,
    )
    // A commit made straight to the log, as if the process stopped before D1.
    const store = h.ports.stores.v3
    const session = v3.newSession()
    const files = await v3.buildFiles(
      [v3.rowFromRecord('b', 'Author', { name: 'B' })],
      v3.uploadTarget(store, session),
    )
    const prev = (await v3.findHead(store, c.id))!
    await v3.commitUpload(
      store,
      c.id,
      {
        change: { collection: c.id, files, base: prev.id, message: null, keyId: null, sig: null },
      },
      { session },
    )
    expect((await lastRow(h.ports, c.id))!.seq).toBe(1)
    expect(await syncCatalog(h.ports, c.id)).toBe(1)
    expect(await lastRow(h.ports, c.id)).toMatchObject({
      seq: 2,
      recordCount: 2,
      typeCounts: { Author: 2 },
    })
    // A push opened on the old head now sees the new one.
    const res = await push(h, user, base, { base: 'v1.1.0' }, [author('c', 'C')])
    expect(res.status).toBe(201)
    expect(await json(res)).toMatchObject({ semver: 'v1.2.0', recordCount: 3 })
  })
  it('lands commits one at a time through a Durable Object, the second on a moved head', async () => {
    const { h, user, c, base } = await setup()
    expect((await push(h, user, base, { schemas: { Author } }, [author('a', 'A')])).status).toBe(
      201,
    )
    // A stand-in for the namespace: JSON both ways, one landing at a time, as the class does.
    const run = serially()
    let calls = 0
    h.ports.commits = durableQueue({
      idFromName: (name) => name,
      get: () => ({
        fetch: async (req) => {
          calls++
          const l = JSON.parse(await req.text()) as Landing
          return Response.json(await run(l.collectionId, () => landCommit(h.ports, l)))
        },
      }),
    })
    // Two pushes opened on the same head, committed at once: one lands, one is told the base moved.
    const open = async (id: string) => {
      const sid = (
        await json(
          await h.request(`${base}/push`, { method: 'POST', user, json: { base: 'v1.0.0' } }),
        )
      ).session_id
      await h.request(`${base}/push/${sid}/records`, {
        method: 'POST',
        user,
        ndjson: [author(id, id)],
      })
      return sid as string
    }
    const [s1, s2] = [await open('b'), await open('c')]
    const results = await Promise.all(
      [s1, s2].map((sid) => h.request(`${base}/push/${sid}/commit`, { method: 'POST', user })),
    )
    expect(results.map((r) => r.status).sort()).toEqual([201, 409])
    expect(calls).toBeGreaterThanOrEqual(1)
    expect(await v3.headNumber(h.ports.stores.v3, c.id)).toBe(2)
    expect((await lastRow(h.ports, c.id))!.recordCount).toBe(2)
    delete h.ports.commits
  })
})
