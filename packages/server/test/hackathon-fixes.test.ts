/**
 * Fixes from the hackathon audit (planning: hackathon-audit-2026-11-13.md): a commit that
 * throws, member renames, races on slugs and memberships, null bodies, slow patterns,
 * the webhook cap, `base: "latest"`, org names, and what a fork copies.
 */
import { and, eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'

import { MAX_WEBHOOKS } from '../src/api/webhooks.js'
import * as schema from '../src/db/schema.js'
import { applyPendingMembers } from '../src/lib/pending-members.js'
import { cleanup, type Harness, harness } from './harness.js'

afterAll(cleanup)

const Book = { type: 'object', properties: { title: { type: 'string' } } }
const json = async (r: Response) => (await r.json()) as Record<string, any>

async function setup() {
  const h = await harness()
  const user = await h.member('u1')
  await h.collection('books')
  await h.ports.db
    .update(schema.collections)
    .set({ public: true })
    .where(eq(schema.collections.slug, 'books'))
  return { h, user, base: '/api/collections/org/books' }
}

async function open(h: Harness, base: string, body: object, user = 'u1') {
  return h.request(`${base}/push`, { method: 'POST', user, json: body })
}

async function push(h: Harness, base: string, body: object, records: object[], user = 'u1') {
  const sid = (await json(await open(h, base, body, user))).session_id as string
  await h.request(`${base}/push/${sid}/records`, { method: 'POST', user, ndjson: records })
  return h.request(`${base}/push/${sid}/commit`, { method: 'POST', user })
}

describe('hackathon audit fixes', () => {
  it('fails a commit that throws so the same session can commit again (Q1)', async () => {
    const { h, base } = await setup()
    const sid = (await json(await open(h, base, { base: null, schemas: { Book } }))).session_id
    await h.request(`${base}/push/${sid}/records`, {
      method: 'POST',
      user: 'u1',
      ndjson: [{ id: 'b1', type: 'Book', data: { title: 'One' } }],
    })
    const layoutOf = h.ports.stores.layoutOf
    h.ports.stores.layoutOf = async () => {
      throw new Error('storage blip')
    }
    const failed = await h.request(`${base}/push/${sid}/commit`, { method: 'POST', user: 'u1' })
    h.ports.stores.layoutOf = layoutOf
    expect(failed.status).toBe(500)
    expect((await json(await h.request(`${base}/push/${sid}`, { user: 'u1' }))).status).toBe(
      'failed',
    )
    const again = await h.request(`${base}/push/${sid}/commit`, { method: 'POST', user: 'u1' })
    expect(again.status).toBe(201)
    expect((await json(again)).semver).toBe('v1.0.0')
  })

  it('lets a member rename a collection when the form resends its visibility (Q3)', async () => {
    const { h, base } = await setup()
    await h.ports.db.insert(schema.user).values({ id: 'u3', name: 'u3', email: 'u3@example.org' })
    await h.ports.db
      .insert(schema.member)
      .values({ organizationId: 'org1', userId: 'u3', role: 'member' })
    const renamed = await h.request(base, {
      method: 'PATCH',
      user: 'u3',
      json: { name: 'Renamed', public: true },
    })
    expect(renamed.status).toBe(200)
    const flipped = await h.request(base, { method: 'PATCH', user: 'u3', json: { public: false } })
    expect(flipped.status).toBe(403)
  })

  it('answers 409, not 500, when two requests create one slug (Q6)', async () => {
    const { h } = await setup()
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        h.request('/api/accounts/org/collections', {
          method: 'POST',
          user: 'u1',
          json: { slug: 'racer', name: 'R' },
        }),
      ),
    )
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409])
  })

  it('answers 4xx, not 500, to a body of null (Q6)', async () => {
    const { h, base } = await setup()
    for (const [path, method] of [
      [base, 'PATCH'],
      [`${base}/transfer`, 'POST'],
    ] as const) {
      const r = await h.request(path, {
        method,
        user: 'u1',
        body: 'null',
        headers: { 'content-type': 'application/json' },
      })
      expect(r.status).toBeLessThan(500)
    }
  })

  it('keeps one membership a person per org (Q4)', async () => {
    const { h } = await setup()
    await h.ports.db
      .insert(schema.user)
      .values({ id: 'bea', name: 'Bea', email: 'bea@example.org' })
    const adds = await Promise.all(
      [1, 2, 3].map(() =>
        h.request('/api/accounts/org/members', {
          method: 'POST',
          user: 'u1',
          json: { email: 'bea@example.org' },
        }),
      ),
    )
    expect(adds.every((r) => r.status < 500)).toBe(true)
    const rows = await h.ports.db
      .select()
      .from(schema.member)
      .where(and(eq(schema.member.organizationId, 'org1'), eq(schema.member.userId, 'bea')))
    expect(rows).toHaveLength(1)
    // A pending add for someone who is already a member changes nothing, and doesn't throw.
    await h.ports.db
      .insert(schema.pendingMembers)
      .values({ organizationId: 'org1', email: 'bea@example.org', role: 'admin', addedBy: 'u1' })
    await applyPendingMembers(h.ports.db, 'bea', 'bea@example.org')
    expect(
      await h.ports.db
        .select()
        .from(schema.member)
        .where(and(eq(schema.member.organizationId, 'org1'), eq(schema.member.userId, 'bea'))),
    ).toHaveLength(1)
  })

  it('refuses a schema with a backtracking pattern (S1)', async () => {
    const { h, base } = await setup()
    const slow = {
      type: 'object',
      properties: { s: { type: 'string', pattern: '^(a+)+$' } },
    }
    const refused = await open(h, base, { base: null, schemas: { Book, Slow: slow } })
    expect(refused.status).toBe(422)
    expect((await json(refused)).error).toMatch(/Schema "Slow" has a "pattern" that nests/)
    const fine = await open(h, base, {
      base: null,
      schemas: { Book, Date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } },
    })
    expect(fine.status).toBe(200)
  })

  it('caps webhooks per collection (S4)', async () => {
    const { h, base } = await setup()
    for (let i = 0; i < MAX_WEBHOOKS; i++) {
      const r = await h.request(`${base}/webhooks`, {
        method: 'POST',
        user: 'u1',
        json: { url: `https://example.org/hook/${i}` },
      })
      expect(r.status).toBe(201)
    }
    const over = await h.request(`${base}/webhooks`, {
      method: 'POST',
      user: 'u1',
      json: { url: 'https://example.org/hook/x' },
    })
    expect(over.status).toBe(409)
  })

  it('opens a session on the head for base "latest"', async () => {
    const { h, base } = await setup()
    expect(
      (
        await push(h, base, { base: null, schemas: { Book } }, [
          { id: 'b1', type: 'Book', data: { title: 'One' } },
        ])
      ).status,
    ).toBe(201)
    const r = await open(h, base, { base: 'latest' })
    expect(r.status).toBe(200)
    expect((await json(r)).base).toBe('v1.0.0')
  })

  it('refuses a blank, long or control-character org name (Q8)', async () => {
    const { h } = await setup()
    for (const displayName of ['   ', 'x'.repeat(101), 'a\nb'])
      expect(
        (
          await h.request('/api/accounts/org', {
            method: 'PATCH',
            user: 'u1',
            json: { displayName },
          })
        ).status,
      ).toBe(422)
    const ok = await h.request('/api/accounts/org', {
      method: 'PATCH',
      user: 'u1',
      json: { displayName: '  Hackers  ' },
    })
    expect(ok.status).toBe(200)
    const [org] = await h.ports.db.select().from(schema.organization)
    expect(org!.name).toBe('Hackers')
  })
})
