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
    expect(me).toMatchObject({ id: 'u1', displayName: 'u1', email: 'u1@example.org' })
    expect(me).not.toHaveProperty('slug')
    expect(me.orgs).toEqual([{ organizationId: 'org1', role: 'owner', slug: 'org', name: 'Org' }])

    expect((await call('/api/accounts/me', { user: 'u1', key: 'read' })).status).toBe(200)
    expect((await call('/api/accounts/me', { user: 'u1', key: 'scoped' })).status).toBe(403)
    expect((await call('/api/accounts/me', { user: 'u1', key: 'org' })).status).toBe(403)

    // The steward role and display name come from KF Auth.
    const ctx = await (await call('/api/context', { user: 'u1' })).json()
    expect(ctx.currentUser).toMatchObject({ kfRole: 'admin', displayName: 'Ada KF' })
    expect(ctx.currentUser).not.toHaveProperty('slug')
    expect(ctx.currentUser.orgs).toEqual([
      { organizationId: 'org1', slug: 'org', displayName: 'Org', role: 'owner' },
    ])
  })

  it('deletes an account confirmed by email, with its keys', async () => {
    const { h, call, db } = await setup()
    await db.insert(schema.user).values({ id: 'n1', name: 'Nell', email: 'nell@example.org' })
    await h.member('n1')
    await db.insert(schema.apikey).values({ id: 'k-n1', referenceId: 'n1', key: 'hashed' })

    const del = (json: Record<string, string>) =>
      call('/api/accounts/me', { method: 'DELETE', user: 'n1', json })
    expect((await del({ confirmEmail: 'other@example.org' })).status).toBe(422)
    expect((await del({ confirmSlug: 'n1' })).status).toBe(422)
    // A write key can't delete the account; a session or an admin key can.
    expect(
      (
        await call('/api/accounts/me', {
          method: 'DELETE',
          user: 'n1',
          key: 'write',
          json: { confirmEmail: 'nell@example.org' },
        })
      ).status,
    ).toBe(403)
    expect((await del({ confirmEmail: 'nell@example.org' })).status).toBe(200)
    expect(await db.select().from(schema.user).where(eq(schema.user.id, 'n1'))).toEqual([])
    expect(await db.select().from(schema.apikey).where(eq(schema.apikey.id, 'k-n1'))).toEqual([])
    // The orgs it belonged to stay.
    expect(
      await db.select().from(schema.organization).where(eq(schema.organization.id, 'org1')),
    ).toHaveLength(1)
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
    // An owner's write key acts as a member; an admin key keeps the role.
    const asKey = (key: string, method: string, json?: unknown) =>
      call('/api/accounts/org', { method, user: 'u1', key, ...(json ? { json } : {}) })
    expect((await asKey('write', 'PATCH', { displayName: 'X' })).status).toBe(403)
    expect((await asKey('write', 'DELETE')).status).toBe(403)
    expect((await asKey('admin', 'PATCH', { bio: 'b' })).status).toBe(200)
    expect((await patch('u1', { kfOrgId: 'kf-other' })).status).toBe(403)
    expect((await patch('u1', { kfOrgId: 'kf-1', displayName: 'Org One' })).status).toBe(200)
    const [org] = await db
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.id, 'org1'))
    expect(org).toMatchObject({ kfOrgId: 'kf-1', name: 'Org One' })
    // An org keeps a KF account.
    expect((await patch('u1', { kfOrgId: null })).status).toBe(422)
    expect((await patch('u1', { kfOrgId: '' })).status).toBe(422)

    expect(await (await call('/api/accounts/available-kf-orgs', { user: 'u1' })).json()).toEqual([
      expect.objectContaining({ id: 'kf-1' }),
    ])

    await h.collection('c')
    expect((await call('/api/accounts/org', { method: 'DELETE', user: 'u2' })).status).toBe(403)
    expect((await call('/api/accounts/org', { method: 'DELETE', user: 'u1' })).status).toBe(409)
    await db.delete(schema.collections)
    expect((await asKey('write', 'DELETE')).status).toBe(403)
    expect((await call('/api/accounts/org', { method: 'DELETE', user: 'u1' })).status).toBe(200)
    expect(
      await db.select().from(schema.member).where(eq(schema.member.organizationId, 'org1')),
    ).toEqual([])
  })
})
