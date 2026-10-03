import { createHash } from 'node:crypto'

import { hashRecord, MemoryBlobStore, noCache } from '@underlay/protocol'
import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'

import * as schema from '../src/db/schema.js'
import { eventsFor, FAN_IN } from '../src/refs/log.js'
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

describe('segments', () => {
  it('never has false negatives, for any hash', async () => {
    const store = new MemoryBlobStore()
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
