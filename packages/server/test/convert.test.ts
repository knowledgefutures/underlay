/**
 * Converting a v2 collection to v3 (v3-deploy-plan.md, Phase 4): version by version,
 * checked against v2, flipped in one batch, and back again. The v2 side is `today`, or `f`
 * on that test project.
 */
import { createHash } from 'node:crypto'

import { v3 } from '@underlay/protocol'
import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'

import * as schema from '../src/db/schema.js'
import { runJob } from '../src/jobs.js'
import { convertConfig, convertStep, requestConversion, revertToV2 } from '../src/v3/convert.js'
import { cleanup, type Harness, harness } from './harness.js'
import { testLayout } from './layouts.js'

afterAll(cleanup)

const v2Layout = testLayout === 'f' ? 'f' : 'today'
const Author = { type: 'object', properties: { name: { type: 'string' } } }
const Book = { type: 'object', properties: { title: { type: 'string' }, pdf: { type: 'object' } } }
const Book2 = {
  type: 'object',
  properties: { title: { type: 'string' }, pdf: { type: 'object' }, year: { type: 'number' } },
  required: ['title'],
}

async function json(res: Response) {
  return (await res.json()) as any
}

async function push(
  h: Harness,
  user: string,
  base: string,
  body: object,
  records: object[] = [],
  deletes: object[] = [],
) {
  const opened = await h.request(`${base}/push`, { method: 'POST', user, json: body })
  expect(opened.status).toBe(200)
  const sid = (await json(opened)).session_id as string
  if (records.length)
    await h.request(`${base}/push/${sid}/records`, { method: 'POST', user, ndjson: records })
  if (deletes.length)
    await h.request(`${base}/push/${sid}/deletes`, { method: 'POST', user, ndjson: deletes })
  const res = await h.request(`${base}/push/${sid}/commit`, { method: 'POST', user })
  expect(res.status).toBe(201)
  return json(res)
}

/** A v2 collection with four versions: records, a file, an edit, a removal, metadata, a schema change. */
async function v2Collection(opts: { private?: boolean } = {}) {
  const h = await harness({ newCollections: v2Layout })
  const user = await h.member()
  const c = await h.collection('lib', { recordLayout: v2Layout })
  await h.ports.db
    .update(schema.collections)
    .set({ public: true })
    .where(eq(schema.collections.id, c.id))
  const base = '/api/collections/org/lib'
  const file = 'pdf bytes'
  const fileHash = createHash('sha256').update(file).digest('hex')
  await h.request(`${base}/files/${fileHash}`, { method: 'PUT', user, body: file })
  await push(h, user, base, { schemas: { Author, Book }, metadata: { title: 'Library' } }, [
    { id: 'a1', type: 'Author', data: { name: 'Ada' } },
    { id: 'a2', type: 'Author', data: { name: 'Bo' }, ...(opts.private ? { private: true } : {}) },
    { id: 'a3', type: 'Author', data: { name: 'Cy' } },
    { id: 'b1', type: 'Book', data: { title: 'One', pdf: { $file: `sha256:${fileHash}` } } },
  ])
  await push(
    h,
    user,
    base,
    { base: 'v1.0.0' },
    [
      { id: 'a1', type: 'Author', data: { name: 'Ada L.' } },
      { id: 'a4', type: 'Author', data: { name: 'Di' } },
    ],
    [{ type: 'Author', id: 'a3' }],
  )
  expect(
    (await h.request(`${base}/metadata`, { method: 'POST', user, json: { description: 'Books' } }))
      .status,
  ).toBe(201)
  await push(h, user, base, { schemas: { Author, Book: Book2 } }, [
    { id: 'b2', type: 'Book', data: { title: 'Two', year: 2020 } },
  ])
  return { h, user, c, base }
}

/** What a reader sees of each version: records, files, and metadata. */
async function snapshot(h: Harness, base: string, user: string) {
  const versions = (await json(await h.request(`${base}/versions`, { user }))) as {
    semver: string
  }[]
  const out: Record<string, unknown> = {}
  for (const { semver } of versions) {
    const detail = await json(await h.request(`${base}/versions/${semver}`, { user }))
    const records: unknown[] = []
    for (const type of ['Author', 'Book']) {
      const page = await json(
        await h.request(`${base}/versions/${semver}/records?type=${type}&limit=100`, { user }),
      )
      for (const r of page.records ?? [])
        records.push({ id: r.id, type: r.type, data: r.data, hash: r.hash })
    }
    const files = await json(await h.request(`${base}/versions/${semver}/files`, { user }))
    out[semver] = {
      recordCount: detail.recordCount,
      metadata: detail.metadata,
      records,
      files: (files.files ?? files).map?.((f: { hash: string }) => f.hash) ?? files,
    }
  }
  return { semvers: versions.map((v) => v.semver), out }
}

async function conversion(h: Harness, collectionId: string) {
  const [row] = await h.ports.db
    .select()
    .from(schema.v3Conversions)
    .where(eq(schema.v3Conversions.collectionId, collectionId))
  return row!
}

describe('converting a v2 collection to v3', () => {
  it('converts every version, checks it, flips, and reads the same', async () => {
    const { h, user, c, base } = await v2Collection()
    const before = await snapshot(h, base, user)
    expect(before.semvers).toEqual(['v2.0.0', 'v1.1.1', 'v1.1.0', 'v1.0.0'])
    const v2Ids = (
      await h.ports.db.select().from(schema.versions).where(eq(schema.versions.collectionId, c.id))
    ).map((v) => v.hash)

    // Converted without flipping: v2 still serves it, and nothing of v2's changed.
    await requestConversion(h.ports, c.id, { flip: false, allowPrivate: false })
    await h.drain()
    let conv = await conversion(h, c.id)
    expect(conv).toMatchObject({ status: 'converted', error: null, private: false })
    expect(conv.versions.map((v) => v.semver)).toEqual(['v1.0.0', 'v1.1.0', 'v1.1.1', 'v2.0.0'])
    expect(await v3.headNumber(h.ports.stores.v3, c.id)).toBe(4)
    const [still] = await h.ports.db
      .select()
      .from(schema.collections)
      .where(eq(schema.collections.id, c.id))
    expect(still!.recordLayout).toBe(v2Layout)

    // Flipped: the same reads, v3 ids, the v2 ids as aliases.
    await requestConversion(h.ports, c.id, { flip: true, allowPrivate: false })
    await h.drain()
    conv = await conversion(h, c.id)
    expect(conv.status).toBe('flipped')
    const [flipped] = await h.ports.db
      .select()
      .from(schema.collections)
      .where(eq(schema.collections.id, c.id))
    expect(flipped!.recordLayout).toBe('v3')
    expect(flipped!.public).toBe(true)
    expect(await snapshot(h, base, user)).toEqual(before)
    const rows = await h.ports.db
      .select()
      .from(schema.versions)
      .where(eq(schema.versions.collectionId, c.id))
      .orderBy(schema.versions.seq)
    expect(rows.every((r) => r.hash.startsWith('ulv3:'))).toBe(true)
    expect(rows.map((r) => r.v2Hash).sort()).toEqual([...v2Ids].sort())
    const alias = await json(await h.request(`${base}/versions/${rows[0]!.v2Hash}`, { user }))
    expect(alias.semver).toBe('v1.0.0')
    // fsck passes, and the collection goes on as v3.
    await runJob({ type: 'repo.fsck', collectionId: c.id, fileBytes: true }, h.ports)
    await h.drain()
    const report = JSON.parse(
      await (await h.ports.stores.internal.get(`fsck/${c.id}.json`))!.text(),
    )
    expect(report).toMatchObject({ ok: true, versions: 4, files: 1 })
    const next = await push(h, user, base, { base: 'v2.0.0' }, [
      { id: 'a5', type: 'Author', data: { name: 'Ed' } },
    ])
    expect(next).toMatchObject({ semver: 'v2.1.0' })
    // Going back would lose that commit: refused.
    expect(await revertToV2(h.ports, c.id)).toMatch(/A v3 commit follows/)
  })

  it('goes back to v2 as it was', async () => {
    const { h, user, c, base } = await v2Collection()
    await h.drain()
    const before = await snapshot(h, base, user)
    const rowsBefore = await h.ports.db
      .select()
      .from(schema.versions)
      .where(eq(schema.versions.collectionId, c.id))
      .orderBy(schema.versions.seq)
    await requestConversion(h.ports, c.id, { flip: true, allowPrivate: false })
    await h.drain()
    expect((await conversion(h, c.id)).status).toBe('flipped')
    expect(await revertToV2(h.ports, c.id)).toBe(null)
    const [col] = await h.ports.db
      .select()
      .from(schema.collections)
      .where(eq(schema.collections.id, c.id))
    expect(col!.recordLayout).toBe(v2Layout)
    const rowsAfter = await h.ports.db
      .select()
      .from(schema.versions)
      .where(eq(schema.versions.collectionId, c.id))
      .orderBy(schema.versions.seq)
    expect(rowsAfter).toEqual(rowsBefore)
    expect(await snapshot(h, base, user)).toEqual(before)
    expect((await conversion(h, c.id)).status).toBe('reverted')
  })

  it('goes back without making public what its owner made private', async () => {
    const { h, c } = await v2Collection()
    await requestConversion(h.ports, c.id, { flip: false, allowPrivate: false })
    await h.drain()
    // Its owner makes it private while it converts; it has no private record or type.
    await h.ports.db
      .update(schema.collections)
      .set({ public: false })
      .where(eq(schema.collections.id, c.id))
    await requestConversion(h.ports, c.id, { flip: true, allowPrivate: false })
    await h.drain()
    expect(await conversion(h, c.id)).toMatchObject({ status: 'flipped', fromPublic: false })
    expect(await revertToV2(h.ports, c.id)).toBe(null)
    const [col] = await h.ports.db
      .select()
      .from(schema.collections)
      .where(eq(schema.collections.id, c.id))
    expect(col).toMatchObject({ recordLayout: v2Layout, public: false })
  })

  it('makes public again, going back, a collection the flip made private', async () => {
    const { h, c } = await v2Collection({ private: true })
    await requestConversion(h.ports, c.id, { flip: true, allowPrivate: true })
    await h.drain()
    const col = async () =>
      (await h.ports.db.select().from(schema.collections).where(eq(schema.collections.id, c.id)))[0]
    expect(await col()).toMatchObject({ recordLayout: 'v3', public: false })
    expect(await revertToV2(h.ports, c.id)).toBe(null)
    expect(await col()).toMatchObject({ recordLayout: v2Layout, public: true })
  })

  it('answers for a record by its hash once its collection is on v3: not found, not an error', async () => {
    const { h, user, c, base } = await v2Collection()
    await h.drain()
    const page = await json(
      await h.request(`${base}/versions/latest/records?type=Author&limit=1`, { user }),
    )
    const hash = page.records[0].hash as string
    expect((await h.request(`/api/records/${hash}/provenance`, { user })).status).toBe(200)
    await requestConversion(h.ports, c.id, { flip: true, allowPrivate: false })
    await h.drain()
    expect((await conversion(h, c.id)).status).toBe('flipped')
    expect((await h.request(`/api/records/${hash}/provenance`, { user })).status).toBe(404)
    const batch = await h.request('/api/records/batch', {
      method: 'POST',
      user,
      json: { hashes: [hash] },
    })
    expect(batch.status).toBe(200)
    expect(await batch.text()).toBe('')
  })

  it('leaves a flipped collection as it is when asked to convert it afresh', async () => {
    const { h, c } = await v2Collection()
    await requestConversion(h.ports, c.id, { flip: true, allowPrivate: false })
    await h.drain()
    await expect(
      requestConversion(h.ports, c.id, { flip: true, allowPrivate: false, fresh: true }),
    ).rejects.toThrow(/still on v2/)
    expect(await conversion(h, c.id)).toMatchObject({ status: 'flipped' })
    expect((await conversion(h, c.id)).versions).toHaveLength(4)
    expect(await v3.headNumber(h.ports.stores.v3, c.id)).toBe(4)
  })

  it('flips a collection with no versions yet, and it takes a first push on v3', async () => {
    const h = await harness({ newCollections: v2Layout })
    const user = await h.member()
    const c = await h.collection('empty', { recordLayout: v2Layout })
    await requestConversion(h.ports, c.id, { flip: true, allowPrivate: false })
    await h.drain()
    expect(await conversion(h, c.id)).toMatchObject({ status: 'flipped', error: null })
    const [row] = await h.ports.db
      .select({ layout: schema.collections.recordLayout })
      .from(schema.collections)
      .where(eq(schema.collections.id, c.id))
    expect(row!.layout).toBe('v3')
    await push(h, user, '/api/collections/org/empty', { schemas: { Author } }, [
      { id: 'a1', type: 'Author', data: { name: 'Ada' } },
    ])
    expect(await v3.headNumber(h.ports.stores.v3, c.id)).toBe(1)
  })

  it('makes a collection with a private record private, only once allowed', async () => {
    const { h, user, c, base } = await v2Collection({ private: true })
    await requestConversion(h.ports, c.id, { flip: true, allowPrivate: false })
    await h.drain()
    let conv = await conversion(h, c.id)
    expect(conv).toMatchObject({ status: 'converted', private: true })
    expect(conv.error).toMatch(/private/)
    await requestConversion(h.ports, c.id, { flip: true, allowPrivate: true })
    await h.drain()
    conv = await conversion(h, c.id)
    expect(conv.status).toBe('flipped')
    const [col] = await h.ports.db
      .select()
      .from(schema.collections)
      .where(eq(schema.collections.id, c.id))
    expect(col).toMatchObject({ recordLayout: 'v3', public: false })
    // The private record is a record like the others, for those who may read the collection.
    expect((await h.request(`${base}/versions/latest/records/Author/a2`, { user })).status).toBe(
      200,
    )
    expect((await h.request(`${base}/versions/latest/records/Author/a2`)).status).toBe(404)
  })

  it('converts a version in parts when it is large', async () => {
    const { h, user, c, base } = await v2Collection()
    await h.drain()
    const before = await snapshot(h, base, user)
    const was = convertConfig.partBytes
    convertConfig.partBytes = 60 // a record or two a part
    try {
      await requestConversion(h.ports, c.id, { flip: true, allowPrivate: false })
      await h.drain()
    } finally {
      convertConfig.partBytes = was
    }
    expect((await conversion(h, c.id)).status).toBe('flipped')
    expect(await snapshot(h, base, user)).toEqual(before)
    // The first version's records went into files built by several jobs.
    const first = await v3.readCommit(h.ports.stores.v3, c.id, 1)
    expect(v3.commitFiles(first!.commit).length).toBeGreaterThanOrEqual(2)
  })

  it('never appends a version twice when two jobs convert it at once', async () => {
    const { h, c } = await v2Collection()
    await h.drain()
    await h.ports.db.insert(schema.v3Conversions).values({ collectionId: c.id, flip: false })
    // Two jobs for the same step, as a retry beside the first would be.
    const both = await Promise.allSettled([convertStep(h.ports, c.id), convertStep(h.ports, c.id)])
    expect(both.some((r) => r.status === 'fulfilled')).toBe(true)
    for (let i = 0; i < 10 && (await conversion(h, c.id)).status === 'converting'; i++)
      await convertStep(h.ports, c.id).catch(() => {})
    expect((await conversion(h, c.id)).status).toBe('converted')
    expect(await v3.headNumber(h.ports.stores.v3, c.id)).toBe(4)
  })

  it('refuses a v3 log with a commit the conversion did not make, until converted afresh', async () => {
    const { h, user, c, base } = await v2Collection()
    await h.drain()
    const before = await snapshot(h, base, user)
    await requestConversion(h.ports, c.id, { flip: false, allowPrivate: false })
    await h.drain()
    // A stray commit after the last version converted.
    await v3.createCommit(h.ports.stores.v3, c.id, { files: [], bump: 'patch', message: 'stray' })
    await h.ports.db
      .update(schema.v3Conversions)
      .set({ status: 'converting' })
      .where(eq(schema.v3Conversions.collectionId, c.id))
    await convertStep(h.ports, c.id)
    let conv = await conversion(h, c.id)
    expect(conv.status).toBe('failed')
    expect(conv.error).toMatch(/ends at commit 5, not at the last version converted \(4\)/)
    await requestConversion(h.ports, c.id, { flip: true, allowPrivate: false, fresh: true })
    await h.drain()
    conv = await conversion(h, c.id)
    expect(conv.status).toBe('flipped')
    expect(await v3.headNumber(h.ports.stores.v3, c.id)).toBe(4)
    expect(await snapshot(h, base, user)).toEqual(before)
  })

  it('drops a converted collection deleted before it was flipped, after the grace', async () => {
    const { h, user, c, base } = await v2Collection()
    await requestConversion(h.ports, c.id, { flip: false, allowPrivate: false })
    await h.drain()
    expect(await v3.readDescription(h.ports.stores.v3, c.id)).not.toBe(null)
    expect((await h.request(base, { method: 'DELETE', user })).status).toBe(200)
    await runJob({ type: 'v3.sweep' }, h.ports)
    // In its grace: kept.
    expect(await v3.readDescription(h.ports.stores.v3, c.id)).not.toBe(null)
    await h.ports.db
      .update(schema.collectionTombstones)
      .set({ deletedAt: new Date(0) })
      .where(eq(schema.collectionTombstones.collectionId, c.id))
    await runJob({ type: 'v3.sweep' }, h.ports)
    expect(await v3.readDescription(h.ports.stores.v3, c.id)).toBe(null)
    expect(await v3.headNumber(h.ports.stores.v3, c.id)).toBe(0)
  })

  it('stops with the reason when a version does not match', async () => {
    const { h, c } = await v2Collection()
    // A v2 version whose semver v3 cannot derive: the bump from v1.1.0 can't give v1.3.0.
    await h.ports.db
      .update(schema.versions)
      .set({ semver: 'v1.3.0', minor: 3, patch: 0 })
      .where(eq(schema.versions.semver, 'v1.1.1'))
    await requestConversion(h.ports, c.id, { flip: true, allowPrivate: false })
    await h.drain()
    const conv = await conversion(h, c.id)
    expect(conv.status).toBe('failed')
    expect(conv.error).toMatch(/v1\.3\.0 on v2 is v1\.2\.0 on v3/)
    const [col] = await h.ports.db
      .select()
      .from(schema.collections)
      .where(eq(schema.collections.id, c.id))
    expect(col!.recordLayout).toBe(v2Layout)
  })
})
