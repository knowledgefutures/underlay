import { and, eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'

import type { KfInvite, KfInviteResult } from '../src/auth/kf.js'
import * as schema from '../src/db/schema.js'
import { applyPendingMembers } from '../src/lib/pending-members.js'
import { cleanup } from './harness.js'
import { fakeKf, setup } from './kf-app.js'

afterAll(cleanup)

/** Org "org" owned by u1, with an admin and a member, and Bea, who has an account but no org. */
async function org(answer: KfInviteResult = { ok: true, status: 201 }) {
  const sent: KfInvite[] = []
  const s = await setup({
    kf: () => ({
      ...fakeKf,
      invite: async (invite) => {
        sent.push(invite)
        return answer
      },
    }),
  })
  const { h, db, user } = s
  await h.member('u1')
  for (const [id, role] of [
    ['u-admin', 'admin'],
    ['u-member', 'member'],
  ] as const) {
    await user(id)
    await db.insert(schema.member).values({ organizationId: 'org1', userId: id, role })
  }
  await db.insert(schema.user).values({ id: 'bea', name: 'Bea', email: 'Bea@Example.org' })
  const add = (u: string, json: unknown, key?: string) =>
    s.call('/api/accounts/org/members', { method: 'POST', user: u, json, ...(key ? { key } : {}) })
  const roleOf = async (userId: string) =>
    (
      await db
        .select({ role: schema.member.role })
        .from(schema.member)
        .where(and(eq(schema.member.organizationId, 'org1'), eq(schema.member.userId, userId)))
    )[0]?.role ?? null
  return { ...s, add, roleOf, sent }
}

describe('adding members by email', () => {
  it('emails someone without an account a link that signs them in to the org', async () => {
    const { add, sent } = await org()
    await add('u1', { email: 'bea@example.org' })
    expect(sent).toEqual([]) // Bea has an account: added, nothing sent.
    await add('u1', { email: 'new@example.org' })
    expect(sent).toEqual([
      expect.objectContaining({
        email: 'new@example.org',
        return_to: 'http://test/login?return_to=%2Forg',
        subject: "You've been added to Org on Underlay",
      }),
    ])
    expect(sent[0]!.html).toContain('{{invitation_url}}')
  })

  it('keeps the add when the email fails, and says why', async () => {
    const { add, db } = await org({ ok: false, status: 403, error: 'invitations disabled' })
    const res = await add('u1', { email: 'new@example.org' })
    expect(res.status).toBe(202)
    expect(await res.json()).toMatchObject({
      emailed: false,
      emailError: expect.stringMatching(/refused/),
    })
    expect(await db.select().from(schema.pendingMembers)).toHaveLength(1)
  })

  it('emails a pending invitation through KF Auth, landing on its accept page', async () => {
    const { call, db, sent } = await org()
    const later = new Date(Date.now() + 86_400_000)
    await db.insert(schema.invitation).values([
      {
        id: 'inv1',
        organizationId: 'org1',
        email: 'pat@example.org',
        role: 'admin',
        expiresAt: later,
        inviterId: 'u1',
      },
      {
        id: 'old',
        organizationId: 'org1',
        email: 'old@example.org',
        expiresAt: new Date(1000),
        inviterId: 'u1',
      },
    ])
    const email = (id: string, user = 'u1') =>
      call(`/api/accounts/org/invitations/${id}/email`, { method: 'POST', user })
    expect((await email('inv1', 'u-member')).status).toBe(403)
    expect((await email('old')).status).toBe(404)
    expect((await email('nope')).status).toBe(404)
    const res = await email('inv1')
    expect(res.status).toBe(200)
    expect(sent).toEqual([
      expect.objectContaining({
        email: 'pat@example.org',
        return_to: 'http://test/login?return_to=%2Finvitations%2Faccept%3Finvitation%3Dinv1',
        subject: 'Join Org on Underlay',
      }),
    ])
    expect(sent[0]!.html).toContain('as an admin')
  })

  it('adds someone with an account at once, matching the address in any case', async () => {
    const { add, roleOf } = await org()
    const res = await add('u1', { email: '  bea@EXAMPLE.org ' })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ status: 'added', name: 'Bea' })
    expect(await roleOf('bea')).toBe('member')
    expect(await (await add('u1', { email: 'bea@example.org' })).json()).toMatchObject({
      status: 'already-member',
    })
  })

  it('remembers someone without an account, who joins on first sign-in', async () => {
    const { add, call, db, roleOf } = await org()
    const res = await add('u-admin', { email: 'New.Person@example.org' })
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({
      status: 'pending',
      email: 'new.person@example.org',
      emailed: true,
    })
    const pending = (await (
      await call('/api/accounts/org/members/pending', { user: 'u1' })
    ).json()) as any[]
    expect(pending).toEqual([
      expect.objectContaining({ email: 'new.person@example.org', role: 'member' }),
    ])

    // They make an account and sign in.
    await db
      .insert(schema.user)
      .values({ id: 'np', name: 'New Person', email: 'new.person@example.org' })
    expect(await applyPendingMembers(db, 'np', 'NEW.PERSON@example.org')).toBe(1)
    expect(await roleOf('np')).toBe('member')
    expect(await db.select().from(schema.pendingMembers)).toEqual([])
    // A second sign-in changes nothing.
    expect(await applyPendingMembers(db, 'np', 'new.person@example.org')).toBe(0)
  })

  it('keeps the role someone already has when a pending add arrives for them', async () => {
    const { db, roleOf } = await org()
    await db.insert(schema.user).values({ id: 'x', name: 'X', email: 'x@example.org' })
    await db.insert(schema.member).values({ organizationId: 'org1', userId: 'x', role: 'admin' })
    await db
      .insert(schema.pendingMembers)
      .values({ organizationId: 'org1', email: 'x@example.org', role: 'member' })
    expect(await applyPendingMembers(db, 'x', 'x@example.org')).toBe(0)
    expect(await roleOf('x')).toBe('admin')
    expect(await db.select().from(schema.pendingMembers)).toEqual([])
  })

  it('lets owners add admins, admins add members, and no one add owners', async () => {
    const { add } = await org()
    expect((await add('u-admin', { email: 'a@example.org', role: 'admin' })).status).toBe(403)
    expect((await add('u1', { email: 'a@example.org', role: 'admin' })).status).toBe(202)
    expect((await add('u1', { email: 'o@example.org', role: 'owner' })).status).toBe(422)
    expect((await add('u-member', { email: 'm@example.org' })).status).toBe(403)
    expect((await add('stranger', { email: 'm@example.org' })).status).toBe(403)
    expect((await add('u1', { email: 'not an email' })).status).toBe(422)
    // A write key acts as a member; a read key can't write.
    expect((await add('u1', { email: 'k@example.org' }, 'write')).status).toBe(403)
    expect((await add('u1', { email: 'k@example.org' }, 'read')).status).toBe(403)
    expect((await add('u1', { email: 'k@example.org' }, 'admin')).status).toBe(202)
  })

  it('removes a pending add, only from its own org', async () => {
    const { add, call, db } = await org()
    await add('u1', { email: 'gone@example.org' })
    const [p] = await db.select().from(schema.pendingMembers)
    expect(
      (
        await call(`/api/accounts/org/members/pending/${p!.id}`, {
          method: 'DELETE',
          user: 'u-member',
        })
      ).status,
    ).toBe(403)
    expect(
      (await call(`/api/accounts/org/members/pending/${p!.id}`, { method: 'DELETE', user: 'u1' }))
        .status,
    ).toBe(200)
    expect(await db.select().from(schema.pendingMembers)).toEqual([])
    expect(
      (await call('/api/accounts/org/members/pending/nope', { method: 'DELETE', user: 'u1' }))
        .status,
    ).toBe(404)
  })
})
