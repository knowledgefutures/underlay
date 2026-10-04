import { createHash } from 'node:crypto'

import { hashRecord, memoryStore, noCache } from '@underlay/protocol'
import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'

import * as schema from '../src/db/schema.js'
import { eventsFor, FAN_IN, indexConfig } from '../src/refs/log.js'
import { lookupSegment, SegmentWriter } from '../src/refs/segments.js'
import { cleanup, type Harness, harness } from './harness.js'

afterAll(cleanup)

const Author = { type: 'object', properties: { name: { type: 'string' } } }
const h_ = (id: string, data: unknown) => hashRecord(id, 'Author', data).hash

async function json(res: Response) {
  return (await res.json()) as any
}

async function push(
  h: Harness,
  user: string,
  base: string,
  body: object,
  records: object[],
  deletes: object[] = [],
) {
  const sid = (await json(await h.request(`${base}/push`, { method: 'POST', user, json: body })))
    .session_id
  if (records.length)
    await h.request(`${base}/push/${sid}/records`, { method: 'POST', user, ndjson: records })
  if (deletes.length)
    await h.request(`${base}/push/${sid}/deletes`, { method: 'POST', user, ndjson: deletes })
  const res = await h.request(`${base}/push/${sid}/commit`, { method: 'POST', user })
  expect(res.status).toBe(201)
  await h.drain()
  return json(res)
}

describe('reference log', () => {
  it('answers provenance across versions, sets and forks, filtered by access', async () => {
    const h = await harness()
    const user = await h.member()
    await h.collection('lib')
    await h.ports.db.update(schema.collections).set({ public: true })
    const base = '/api/collections/org/lib'
    await push(h, user, base, { schemas: { Author } }, [
      { id: 'a', type: 'Author', data: { name: 'A' } },
      { id: 'b', type: 'Author', data: { name: 'B' }, private: true },
    ])
    await push(h, user, base, { base: 'v1.0.0' }, [
      { id: 'a', type: 'Author', data: { name: 'A2' } },
    ])

    const oldA = await json(await h.request(`/api/records/${h_('a', { name: 'A' })}/provenance`))
    expect(oldA).toMatchObject({ recordId: 'a', type: 'Author', data: { name: 'A' } })
    expect(oldA.references.map((r: any) => r.semver)).toEqual(['v1.0.0'])
    const newA = await json(await h.request(`/api/records/${h_('a', { name: 'A2' })}/provenance`))
    expect(newA.references.map((r: any) => r.semver)).toEqual(['v1.1.0'])

    // Private records: members only, and nothing (not even a count) for others.
    const bHash = h_('b', { name: 'B' })
    expect((await h.request(`/api/records/${bHash}/provenance`)).status).toBe(404)
    expect(
      (await json(await h.request(`/api/records/${bHash}/provenance`, { user }))).references.length,
    ).toBe(2)

    // A fork inherits presence from the fork point, until it removes the record.
    await h.ports.db.insert(schema.organization).values({ id: 'org2', name: 'Two', slug: 'two' })
    await h.ports.db
      .insert(schema.member)
      .values({ organizationId: 'org2', userId: user, role: 'owner' })
    expect(
      (await h.request(`${base}/fork`, { method: 'POST', user, json: { targetOrg: 'two' } }))
        .status,
    ).toBe(201)
    await h.drain()
    await h.ports.db.update(schema.collections).set({ public: true })
    let refs = (await json(await h.request(`/api/records/${h_('a', { name: 'A2' })}/provenance`)))
      .references
    expect(refs.map((r: any) => `${r.owner}/${r.semver}`).sort()).toEqual([
      'org/v1.1.0',
      'two/v1.0.0',
    ])
    await push(
      h,
      user,
      '/api/collections/two/lib',
      { base: 'v1.0.0' },
      [],
      [{ type: 'Author', id: 'a' }],
    )
    refs = (await json(await h.request(`/api/records/${h_('a', { name: 'A2' })}/provenance`)))
      .references
    expect(refs.map((r: any) => `${r.owner}/${r.semver}`).sort()).toEqual([
      'org/v1.1.0',
      'two/v1.0.0',
    ])

    // Batch fetch by hash, and the counters.
    const batch = await h.request('/api/records/batch', {
      method: 'POST',
      json: { hashes: [h_('a', { name: 'A2' }), bHash] },
    })
    const lines = (await batch.text())
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(lines).toEqual([
      { id: 'a', type: 'Author', data: { name: 'A2' }, hash: h_('a', { name: 'A2' }) },
    ])
    const [col] = await h.ports.db
      .select()
      .from(schema.collections)
      .where(eq(schema.collections.slug, 'lib'))
    expect(col!.refEvents).toBeGreaterThan(0)
  })

  it('indexes a large version in key-range units, live together', async () => {
    const h = await harness()
    const user = await h.member()
    const c = await h.collection('lib')
    const base = '/api/collections/org/lib'
    const authors = (n: number, tag: string) =>
      Array.from({ length: n }, (_, i) => ({
        id: `a${String(i).padStart(3, '0')}`,
        type: 'Author',
        data: { name: `${tag}${i}` },
        ...(i % 5 === 0 ? { private: true } : {}),
      }))
    indexConfig.unitEvents = 10
    try {
      await push(h, user, base, { schemas: { Author } }, authors(60, 'x'))
      await push(h, user, base, { base: 'v1.0.0' }, authors(60, 'y'))
    } finally {
      indexConfig.unitEvents = 1_000_000
    }
    const versions = await h.ports.db
      .select()
      .from(schema.versions)
      .where(eq(schema.versions.collectionId, c.id))
    expect(versions.every((v) => v.refsIndexed)).toBe(true)
    // 60 added, then 60 updated (a removal and an addition each).
    expect(versions.map((v) => v.refEvents).sort()).toEqual([120, 60])
    const runs = await h.ports.db.select().from(schema.refSegments)
    expect(new Set(runs.map((r) => r.runId)).size).toBeGreaterThan(2)
    expect(runs.every((r) => r.state === 'live')).toBe(true)
    expect(await h.ports.db.select().from(schema.refIndexUnits)).toEqual([])
    const [row] = await h.ports.db
      .select()
      .from(schema.collections)
      .where(eq(schema.collections.id, c.id))
    expect(row!.refEvents).toBe(180)
    // Every record's history comes out as it would from one run.
    for (const i of [0, 1, 37, 59]) {
      const id = `a${String(i).padStart(3, '0')}`
      const events = await eventsFor(h.ports, h_(id, { name: `x${i}` }))
      expect(events.map((e) => `${e[4]}${e[5]}`)).toEqual(['1+', '2-'])
    }
  })

  it('compacts runs without changing answers', async () => {
    const h = await harness()
    const user = await h.member()
    await h.collection('lib')
    const base = '/api/collections/org/lib'
    await push(h, user, base, { schemas: { Author } }, [
      { id: 'k0', type: 'Author', data: { name: '0' } },
    ])
    for (let i = 1; i < FAN_IN + 2; i++) {
      await push(h, user, base, {}, [{ id: `k${i}`, type: 'Author', data: { name: String(i) } }])
    }
    const runs = await h.ports.db
      .select()
      .from(schema.refSegments)
      .where(eq(schema.refSegments.state, 'live'))
    expect(new Set(runs.map((r) => r.runId)).size).toBeLessThan(FAN_IN + 2)
    expect(runs.some((r) => r.tier === 1)).toBe(true)
    for (let i = 0; i < FAN_IN + 2; i++) {
      const ev = await eventsFor(h.ports, h_(`k${i}`, { name: String(i) }))
      expect(ev.map((e) => e[5])).toEqual(['+'])
    }
  })
})

describe('deleted collections', () => {
  it('tombstones a deleted collection, and compaction drops its events', async () => {
    const h = await harness()
    const user = await h.member()
    const gone = await h.collection('gone')
    await h.collection('kept')
    const shared = { id: 's', type: 'Author', data: { name: 'shared' } }
    await push(h, user, '/api/collections/org/gone', { schemas: { Author } }, [shared])
    const before = await eventsFor(h.ports, h_('s', { name: 'shared' }))
    expect(before.map((e) => e[2])).toEqual([gone.id])
    const [row] = await h.ports.db
      .select()
      .from(schema.collections)
      .where(eq(schema.collections.id, gone.id))
    expect(row!.refEvents).toBeGreaterThan(0)

    expect((await h.request('/api/collections/org/gone', { method: 'DELETE', user })).status).toBe(
      200,
    )
    const [tomb] = await h.ports.db.select().from(schema.collectionTombstones)
    expect(tomb).toMatchObject({
      collectionId: gone.id,
      slug: 'gone',
      refEvents: row!.refEvents,
      versions: 1,
      deletedBy: user,
    })

    // Enough commits elsewhere to compact the run holding the deleted collection's events.
    const base = '/api/collections/org/kept'
    await push(h, user, base, { schemas: { Author } }, [shared])
    for (let i = 1; i < FAN_IN + 2; i++) {
      await push(h, user, base, {}, [{ id: `k${i}`, type: 'Author', data: { name: String(i) } }])
    }
    const after = await eventsFor(h.ports, h_('s', { name: 'shared' }))
    expect(after.map((e) => e[2])).not.toContain(gone.id)
    expect(after.length).toBeGreaterThan(0)
  })
})

describe('forks and access', () => {
  const sha = (b: string) => createHash('sha256').update(b).digest('hex')
  const Doc = { type: 'object', properties: { title: { type: 'string' }, pdf: {} } }

  it("a public-only fork doesn't inherit the parent's private files or records", async () => {
    const h = await harness()
    const user = await h.member()
    await h.collection('lib')
    await h.ports.db.update(schema.collections).set({ public: true })
    const base = '/api/collections/org/lib'
    const pub = 'public pdf'
    const priv = 'private pdf'
    for (const b of [pub, priv]) {
      expect(
        (await h.request(`${base}/files/${sha(b)}`, { method: 'PUT', user, body: b })).status,
      ).toBe(201)
    }
    await push(h, user, base, { schemas: { Doc } }, [
      { id: 'd1', type: 'Doc', data: { pdf: { $file: `sha256:${sha(pub)}` } } },
      { id: 'd2', type: 'Doc', data: { pdf: { $file: `sha256:${sha(priv)}` } }, private: true },
    ])

    // A signed-in non-member forks the public collection into their own org.
    await h.ports.db.insert(schema.user).values({ id: 'u2', name: 'u2', email: 'u2@example.org' })
    await h.ports.db.insert(schema.organization).values({ id: 'org2', name: 'Two', slug: 'two' })
    await h.ports.db
      .insert(schema.member)
      .values({ organizationId: 'org2', userId: 'u2', role: 'owner' })
    expect(
      (await h.request(`${base}/fork`, { method: 'POST', user: 'u2', json: { targetOrg: 'two' } }))
        .status,
    ).toBe(201)
    await h.drain()

    expect((await h.request(`/api/collections/files/${sha(priv)}`, { user: 'u2' })).status).toBe(
      404,
    )
    const d2 = hashRecord('d2', 'Doc', { pdf: { $file: `sha256:${sha(priv)}` } }).hash
    expect((await h.request(`/api/records/${d2}/provenance`, { user: 'u2' })).status).toBe(404)
    // What the fork did carry stays reachable, and the parent's members still see both.
    expect((await h.request(`/api/collections/files/${sha(pub)}`, { user: 'u2' })).status).toBe(302)
    expect((await h.request(`/api/collections/files/${sha(priv)}`, { user })).status).toBe(302)
  })

  it('keeps what a fork inherited when it removes a record and adds it back', async () => {
    const h = await harness()
    const user = await h.member()
    await h.collection('lib')
    const base = '/api/collections/org/lib'
    const a = { id: 'a', type: 'Author', data: { name: 'A' } }
    await push(h, user, base, { schemas: { Author } }, [a])
    expect(
      (
        await h.request(`${base}/fork`, {
          method: 'POST',
          user,
          json: { targetOrg: 'org', slug: 'lib-fork' },
        })
      ).status,
    ).toBe(201)
    await h.drain()
    const fork = '/api/collections/org/lib-fork'
    await push(h, user, fork, { base: 'v1.0.0' }, [], [{ type: 'Author', id: 'a' }])
    await push(h, user, fork, {}, [a])
    const refs = (
      await json(await h.request(`/api/records/${h_('a', { name: 'A' })}/provenance`, { user }))
    ).references
    expect(refs.map((r: any) => `${r.collection}/${r.semver}`).sort()).toEqual([
      'lib-fork/v1.0.0',
      'lib-fork/v1.2.0',
      'lib/v1.0.0',
    ])
  })

  it('serves a record body only when it has the requested hash', async () => {
    const h = await harness()
    const user = await h.member()
    await h.collection('lib')
    const base = '/api/collections/org/lib'
    await push(h, user, base, { schemas: { Author } }, [
      { id: 'a', type: 'Author', data: { name: 'A' } },
    ])
    // The next version isn't indexed yet, so the log still places the old record at the head.
    const sid = (
      await json(
        await h.request(`${base}/push`, { method: 'POST', user, json: { base: 'v1.0.0' } }),
      )
    ).session_id
    await h.request(`${base}/push/${sid}/records`, {
      method: 'POST',
      user,
      ndjson: [{ id: 'a', type: 'Author', data: { name: 'A2' } }],
    })
    expect((await h.request(`${base}/push/${sid}/commit`, { method: 'POST', user })).status).toBe(
      201,
    )
    const res = await h.request(`/api/records/${h_('a', { name: 'A' })}/provenance`, { user })
    if (res.status === 200) expect((await json(res)).data).toEqual({ name: 'A' })
    else expect(res.status).toBe(404)
    const batch = await h.request('/api/records/batch', {
      method: 'POST',
      user,
      json: { hashes: [h_('a', { name: 'A' })] },
    })
    for (const line of (await batch.text()).split('\n').filter(Boolean))
      expect(JSON.parse(line).data).toEqual({ name: 'A' })
  })
})

describe('segments', () => {
  it('never has false negatives, for any hash', async () => {
    const store = memoryStore()
    const hashes = Array.from({ length: 5000 }, (_, i) =>
      createHash('sha256').update(String(i)).digest('hex'),
    ).sort()
    const w = new SegmentWriter(store, () => 'seg')
    for (const x of hashes) await w.add([x, 'r', 'c', 'public', 1, '+', 'T', x.slice(0, 6)])
    await w.finish()
    for (const x of hashes.filter((_, i) => i % 50 === 0)) {
      expect((await lookupSegment(store, noCache, 'seg', x)).length).toBe(1)
    }
  })
})
