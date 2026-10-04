/**
 * D1 binds at most 100 parameters per statement and runs at most 1,000 queries
 * per invocation. The harness refuses statements over 100 parameters
 * (db/node.ts), so these exercise the routes with lists past that.
 */
import { createHash } from 'node:crypto'

import { hashRecord } from '@underlay/protocol'
import { afterAll, describe, expect, it } from 'vitest'

import { MAX_BATCH_HASHES } from '../src/api/records.js'
import * as schema from '../src/db/schema.js'
import { cleanup, type Harness, harness } from './harness.js'

afterAll(cleanup)

const sha = (b: string) => createHash('sha256').update(b).digest('hex')
const Doc = { type: 'object', properties: { pdf: {} } }
const Author = { type: 'object', properties: { name: { type: 'string' } } }

async function json(res: Response) {
  return (await res.json()) as any
}

async function push(h: Harness, user: string, base: string, body: object, records: object[]) {
  const sid = (await json(await h.request(`${base}/push`, { method: 'POST', user, json: body })))
    .session_id
  if (records.length)
    await h.request(`${base}/push/${sid}/records`, { method: 'POST', user, ndjson: records })
  const res = await h.request(`${base}/push/${sid}/commit`, { method: 'POST', user })
  expect(res.status).toBe(201)
  await h.drain()
}

describe('D1 limits', () => {
  it('the harness refuses a statement D1 would refuse', async () => {
    const h = await harness()
    const ids = Array.from({ length: 101 }, (_, i) => String(i))
    const { inArray } = await import('drizzle-orm')
    await expect(
      h.ports.db.select().from(schema.files).where(inArray(schema.files.hash, ids)),
    ).rejects.toSatisfy((e) => /binds 101 parameters/.test(String((e as Error).cause)))
  })

  it('lists more than 100 files of a version', async () => {
    const h = await harness()
    const user = await h.member()
    await h.collection('docs')
    const base = '/api/collections/org/docs'
    const bodies = Array.from({ length: 120 }, (_, i) => `file ${i}`)
    for (const b of bodies) {
      expect(
        (await h.request(`${base}/files/${sha(b)}`, { method: 'PUT', user, body: b })).status,
      ).toBe(201)
    }
    await push(
      h,
      user,
      base,
      { schemas: { Doc } },
      bodies.map((b, i) => ({
        id: `d${i}`,
        type: 'Doc',
        data: { pdf: { $file: `sha256:${sha(b)}` } },
      })),
    )
    const res = await h.request(`${base}/versions/latest/files`, { user })
    expect(res.status).toBe(200)
    const files = await json(res)
    expect(files.length).toBe(120)
    expect(files.every((f: any) => f.size !== null)).toBe(true)

    // Presigning many files reads the head and the file rows once, not per hash.
    const before = h.statements()
    const presign = await h.request(`${base}/files/presign`, {
      method: 'POST',
      user,
      json: { hashes: [...bodies.map((b) => `sha256:${sha(b)}`), sha('not uploaded')] },
    })
    expect(presign.status).toBe(200)
    const urls = await json(presign)
    expect(Object.values(urls).filter(Boolean).length).toBe(120)
    expect(urls[sha('not uploaded')]).toBe(null)
    expect(h.statements() - before).toBeLessThan(20)
  })

  it('serves a user in more than 100 orgs, and an org with more than 100 members', async () => {
    const h = await harness()
    const user = await h.member()
    await h.collection('c')
    await push(h, user, '/api/collections/org/c', { schemas: { Author } }, [
      { id: 'a', type: 'Author', data: { name: 'A' } },
    ])
    for (let i = 0; i < 120; i += 25) {
      await h.ports.db
        .insert(schema.organization)
        .values(
          Array.from({ length: 25 }, (_, j) => ({ id: `o${i + j}`, name: 'O', slug: `o${i + j}` })),
        )
    }
    for (let i = 0; i < 120; i += 25) {
      await h.ports.db.insert(schema.member).values(
        Array.from({ length: 25 }, (_, j) => ({
          organizationId: `o${i + j}`,
          userId: user,
          role: 'member' as const,
        })),
      )
    }
    const mine = await h.request('/api/collections?mine=true', { user })
    expect(mine.status).toBe(200)
    expect((await json(mine)).collections.map((x: any) => x.slug)).toEqual(['c'])
    expect((await h.request('/api/schemas', { user })).status).toBe(200)

    for (let i = 0; i < 120; i += 10) {
      const ids = Array.from({ length: 10 }, (_, j) => `m${i + j}`)
      await h.ports.db
        .insert(schema.user)
        .values(ids.map((id) => ({ id, name: id, email: `${id}@example.org` })))
      await h.ports.db
        .insert(schema.member)
        .values(ids.map((id) => ({ organizationId: 'org1', userId: id, role: 'member' as const })))
    }
    const members = await h.request('/api/accounts/org/members', { user })
    expect(members.status).toBe(200)
    expect((await json(members)).length).toBe(121)
  })

  it('removes an org default mirror from an org with more than 100 collections', async () => {
    const h = await harness()
    const user = await h.member()
    for (let i = 0; i < 101; i++) await h.collection(`c${i}`)
    const [loc] = await h.ports.db
      .insert(schema.storageLocations)
      .values({
        organizationId: 'org1',
        kind: 's3',
        name: 'L',
        permissions: 'write',
        status: 'active',
      })
      .returning()
    const [def] = await h.ports.db
      .insert(schema.placements)
      .values({ organizationId: 'org1', locationId: loc!.id, role: 'mirror', sets: 'public' })
      .returning()
    const res = await h.request(`/api/orgs/org/placements/${def!.id}`, { method: 'DELETE', user })
    expect(res.status).toBe(204)
  })

  it('answers provenance across many forks in a bounded number of queries', async () => {
    const h = await harness()
    const user = await h.member()
    await h.collection('lib')
    await h.ports.db.update(schema.collections).set({ public: true })
    await push(h, user, '/api/collections/org/lib', { schemas: { Author } }, [
      { id: 'a', type: 'Author', data: { name: 'A' } },
    ])
    for (let i = 0; i < 30; i++) {
      const res = await h.request('/api/collections/org/lib/fork', {
        method: 'POST',
        user,
        json: { targetOrg: 'org', slug: `fork-${i}` },
      })
      expect(res.status).toBe(201)
    }
    await h.drain()
    const hash = hashRecord('a', 'Author', { name: 'A' }).hash
    const before = h.statements()
    const res = await h.request(`/api/records/${hash}/provenance`, { user })
    expect(res.status).toBe(200)
    expect((await json(res)).references.length).toBe(31)
    expect(h.statements() - before).toBeLessThan(20)

    const batch = await h.request('/api/records/batch', {
      method: 'POST',
      json: { hashes: Array.from({ length: MAX_BATCH_HASHES + 1 }, () => hash) },
    })
    expect(batch.status).toBe(400)
  })
})
