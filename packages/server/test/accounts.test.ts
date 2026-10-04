import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'

import * as schema from '../src/db/schema.js'
import { cleanup } from './harness.js'
import { setup } from './kf-app.js'

afterAll(cleanup)

describe('account routes', () => {
  it('serves the signed-in user, and refuses keys that are not a person', async () => {
    const { h, call, user } = await setup()
    await user('u1')
    await h.member('u1')

    expect((await call('/api/accounts/me')).status).toBe(401)
    const me = await (await call('/api/accounts/me', { user: 'u1' })).json()
    expect(me).toMatchObject({ id: 'u1', slug: 'u1', email: 'u1@example.org' })
    expect(me.orgs.map((o: { slug: string }) => o.slug).sort()).toEqual(['org', 'u1'])

    expect((await call('/api/accounts/me', { user: 'u1', key: 'read' })).status).toBe(200)
    expect((await call('/api/accounts/me', { user: 'u1', key: 'scoped' })).status).toBe(403)
    expect((await call('/api/accounts/me', { user: 'u1', key: 'org' })).status).toBe(403)
    expect(
      (await call('/api/accounts/me', { method: 'PATCH', user: 'u1', key: 'read', json: {} }))
        .status,
    ).toBe(403)

    // The steward role and display name come from KF Auth.
    const ctx = await (await call('/api/context', { user: 'u1' })).json()
    expect(ctx.currentUser).toMatchObject({ kfRole: 'admin', displayName: 'Ada KF' })
  })

  it('updates the personal profile, checking the slug', async () => {
    const { call, db, user } = await setup()
    await user('u1')
    await user('u2')
    const patch = (json: unknown) => call('/api/accounts/me', { method: 'PATCH', user: 'u1', json })

    expect((await patch({ slug: 'u2' })).status).toBe(409)
    expect((await patch({ slug: 'Bad Slug' })).status).toBe(422)
    const ok = await patch({ slug: 'ada', displayName: 'Ada', bio: 'hi', website: null })
    expect(await ok.json()).toEqual({ ok: true, slug: 'ada' })
    const [org] = await db
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.id, 'p-u1'))
    expect(org).toMatchObject({ slug: 'ada', name: 'Ada', bio: 'hi', website: null })
  })

  it('deletes an account only when confirmed and empty', async () => {
    const { call, db, user } = await setup()
    await user('u1')
    const del = (confirmSlug: string) =>
      call('/api/accounts/me', { method: 'DELETE', user: 'u1', json: { confirmSlug } })

    expect((await del('nope')).status).toBe(422)
    await db.insert(schema.collections).values({
      organizationId: 'p-u1',
      slug: 'keep',
      name: 'keep',
      privateSalt: 'aa',
    })
    const refused = await del('u1')
    expect(refused.status).toBe(409)
    expect((await refused.json()).error).toContain('1 collection')

    await db.delete(schema.collections).where(eq(schema.collections.slug, 'keep'))
    expect((await del('u1')).status).toBe(200)
    expect(await db.select().from(schema.user).where(eq(schema.user.id, 'u1'))).toEqual([])
    expect(
      await db.select().from(schema.organization).where(eq(schema.organization.id, 'p-u1')),
    ).toEqual([])
  })

  it('lists and revokes the user’s own sessions', async () => {
    const { call, db, user } = await setup()
    await user('u1')
    await user('u2')
    const later = new Date(Date.now() + 86_400_000)
    await db.insert(schema.session).values([
      { id: 's-u1', token: 't1', userId: 'u1', expiresAt: later, userAgent: 'Firefox' },
      { id: 's-other', token: 't2', userId: 'u1', expiresAt: later },
      { id: 's-old', token: 't3', userId: 'u1', expiresAt: new Date(Date.now() - 1000) },
      { id: 's-u2', token: 't4', userId: 'u2', expiresAt: later },
    ])

    expect((await call('/api/accounts/me/sessions', { user: 'u1', key: 'read' })).status).toBe(401)
    const list = (await (await call('/api/accounts/me/sessions', { user: 'u1' })).json()) as {
      id: string
      current: boolean
    }[]
    expect(list.map((s) => [s.id, s.current]).sort()).toEqual([
      ['s-other', false],
      ['s-u1', true],
    ])

    const revoke = (id: string) =>
      call(`/api/accounts/me/sessions/${id}`, { method: 'DELETE', user: 'u1' })
    expect((await revoke('s-u2')).status).toBe(404)
    expect((await revoke('s-other')).status).toBe(200)
    expect((await db.select().from(schema.session)).map((s) => s.id).sort()).toEqual([
      's-old',
      's-u1',
      's-u2',
    ])
  })

  it('accepts an invitation only for the invited email, once', async () => {
    const { h, call, db, user } = await setup()
    await h.member('u1')
    await user('u2')
    await user('u3')
    const later = new Date(Date.now() + 86_400_000)
    await db.insert(schema.invitation).values([
      {
        id: 'inv',
        organizationId: 'org1',
        email: 'U2@example.org',
        role: 'admin',
        inviterId: 'u1',
        expiresAt: later,
      },
      {
        id: 'old',
        organizationId: 'org1',
        email: 'u3@example.org',
        inviterId: 'u1',
        expiresAt: new Date(Date.now() - 1000),
      },
    ])
    const accept = (u: string, token: string) =>
      call('/api/accounts/invitations/accept', { method: 'POST', user: u, json: { token } })

    expect((await accept('u3', 'inv')).status).toBe(404)
    expect((await accept('u3', 'old')).status).toBe(404)
    const ok = await accept('u2', 'inv')
    expect(await ok.json()).toEqual({ ok: true, orgSlug: 'org' })
    const [m] = await db.select().from(schema.member).where(eq(schema.member.userId, 'u2'))
    expect(m).toBeDefined()
    const roles = await db
      .select({ role: schema.member.role, org: schema.member.organizationId })
      .from(schema.member)
      .where(eq(schema.member.userId, 'u2'))
    expect(roles).toContainEqual({ role: 'admin', org: 'org1' })
    expect((await accept('u2', 'inv')).status).toBe(404)
  })

  it('updates and deletes orgs for owners only', async () => {
    const { h, call, db, user } = await setup()
    await h.member('u1')
    await user('u2')
    await db.insert(schema.member).values({ organizationId: 'org1', userId: 'u2', role: 'admin' })
    const patch = (u: string, json: unknown) =>
      call('/api/accounts/org', { method: 'PATCH', user: u, json })

    expect((await patch('u2', { displayName: 'X' })).status).toBe(403)
    expect((await patch('u1', { kfOrgId: 'kf-other' })).status).toBe(403)
    expect((await patch('u1', { kfOrgId: 'kf-1', displayName: 'Org One' })).status).toBe(200)
    const [org] = await db
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.id, 'org1'))
    expect(org).toMatchObject({ kfOrgId: 'kf-1', name: 'Org One' })
    expect((await patch('u1', { kfOrgId: null })).status).toBe(200)

    expect(await (await call('/api/accounts/available-kf-orgs', { user: 'u1' })).json()).toEqual([
      expect.objectContaining({ id: 'kf-1' }),
    ])

    await h.collection('c')
    expect((await call('/api/accounts/org', { method: 'DELETE', user: 'u2' })).status).toBe(403)
    expect((await call('/api/accounts/org', { method: 'DELETE', user: 'u1' })).status).toBe(409)
    expect((await call('/api/accounts/u2', { method: 'DELETE', user: 'u2' })).status).toBe(409)
    await db.delete(schema.collections)
    expect((await call('/api/accounts/org', { method: 'DELETE', user: 'u1' })).status).toBe(200)
    expect(
      await db.select().from(schema.member).where(eq(schema.member.organizationId, 'org1')),
    ).toEqual([])
  })
})
