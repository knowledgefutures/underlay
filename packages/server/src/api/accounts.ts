/**
 * The signed-in user's account and the orgs they own (v1's `src/api/accounts.ts`
 * shapes, which the UI calls):
 *
 *   GET    /api/accounts/me                       profile and memberships
 *   PATCH  /api/accounts/me                       {slug?, displayName?, bio?, website?}
 *   DELETE /api/accounts/me                       {confirmSlug}
 *   GET    /api/accounts/me/sessions              signed-in devices
 *   DELETE /api/accounts/me/sessions/:id
 *   GET    /api/accounts/available-kf-orgs        KF orgs a new org may link to
 *   POST   /api/accounts/invitations/accept       {token}: an invitation id
 *   PATCH  /api/accounts/:slug                    org profile (owners: session or admin key)
 *   DELETE /api/accounts/:slug                    an org (owners: session or admin key)
 *
 * Sessions, invitation acceptance and the guards on deletion are new in v2;
 * the UI called the first two, but v1 never served them.
 *
 * Deleting an org cascades to its collections in this schema, so an org (or a
 * personal account) that still holds collections is refused: delete or
 * transfer them first.
 */
import { and, count, eq, isNull } from 'drizzle-orm'
import { type Context, Hono } from 'hono'

import type { AppEnv } from '../app.js'
import * as schema from '../db/schema.js'
import { deleteOrgAvatars } from '../lib/avatars.js'
import { validateOrgSlug } from '../lib/slug.js'
import { capRole, jsonError } from './access.js'

/**
 * The calling user, for account routes: a session or an unscoped personal key
 * (write routes refuse read keys). Collection-scoped and org-owned keys are
 * not a user, as in v1's requireUnscopedKey.
 */
export function requireUser(c: Context<AppEnv>, write: boolean): string | Response {
  const p = c.var.principal
  if (!p) return jsonError(c, 401, 'Authentication required')
  if (p.collectionIds || p.orgId) return jsonError(c, 403, 'This key cannot manage accounts')
  if (write && p.scope === 'read') return jsonError(c, 403, 'Read-only key')
  return p.userId
}

export async function orgBySlug(c: Context<AppEnv>, slug: string) {
  const [org] = await c.var.ports.db
    .select()
    .from(schema.organization)
    .where(eq(schema.organization.slug, slug))
    .limit(1)
  return org ?? null
}

export async function roleIn(c: Context<AppEnv>, orgId: string, userId: string) {
  const [m] = await c.var.ports.db
    .select({ role: schema.member.role })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, userId)))
    .limit(1)
  return m?.role ?? null
}

async function personalOrg(c: Context<AppEnv>, userId: string) {
  const [row] = await c.var.ports.db
    .select({ org: schema.organization })
    .from(schema.member)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
    .where(and(eq(schema.member.userId, userId), eq(schema.organization.isDefault, true)))
    .limit(1)
  return row?.org ?? null
}

/** Collections an org still holds (soft-deleted ones excluded). */
async function collectionCount(c: Context<AppEnv>, orgId: string) {
  const [row] = await c.var.ports.db
    .select({ n: count() })
    .from(schema.collections)
    .where(and(eq(schema.collections.organizationId, orgId), isNull(schema.collections.deletedAt)))
  return row?.n ?? 0
}

/** 422/409 for a slug change, or null when `slug` is free for org `orgId`. */
async function slugProblem(c: Context<AppEnv>, slug: unknown, orgId: string) {
  const err = validateOrgSlug(slug)
  if (err) return jsonError(c, 422, err)
  const taken = await orgBySlug(c, slug as string)
  if (taken && taken.id !== orgId) return jsonError(c, 409, 'That slug is already taken')
  return null
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
const strOrNull = (v: unknown) => (v === null ? null : str(v))

export function accountRoutes() {
  const app = new Hono<AppEnv>()

  app.get('/api/accounts/me', async (c) => {
    const userId = requireUser(c, false)
    if (userId instanceof Response) return userId
    const { db } = c.var.ports
    const [u] = await db.select().from(schema.user).where(eq(schema.user.id, userId)).limit(1)
    if (!u) return jsonError(c, 404, 'User not found')
    const orgs = await db
      .select({
        organizationId: schema.member.organizationId,
        role: schema.member.role,
        slug: schema.organization.slug,
        name: schema.organization.name,
        isDefault: schema.organization.isDefault,
      })
      .from(schema.member)
      .innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
      .where(eq(schema.member.userId, u.id))
    const own = orgs.find((o) => o.isDefault)
    return c.json({
      id: u.id,
      name: u.name,
      email: u.email,
      image: u.image,
      slug: own?.slug ?? null,
      displayName: own?.name ?? u.name,
      createdAt: u.createdAt,
      orgs,
    })
  })

  app.patch('/api/accounts/me', async (c) => {
    const userId = requireUser(c, true)
    if (userId instanceof Response) return userId
    const body = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>
    const org = await personalOrg(c, userId)
    if (!org) return jsonError(c, 404, 'Default org not found')
    if (body.slug !== undefined) {
      const bad = await slugProblem(c, body.slug, org.id)
      if (bad) return bad
    }
    // notificationPrefs (sent by the settings page) has nowhere to live yet; as v1, ignored.
    const set: Partial<typeof schema.organization.$inferInsert> = {}
    if (str(body.slug) !== undefined) set.slug = str(body.slug)!
    if (str(body.displayName) !== undefined) set.name = str(body.displayName)!
    if (strOrNull(body.bio) !== undefined) set.bio = strOrNull(body.bio)!
    if (strOrNull(body.website) !== undefined) set.website = strOrNull(body.website)!
    if (Object.keys(set).length) {
      await c.var.ports.db
        .update(schema.organization)
        .set(set)
        .where(eq(schema.organization.id, org.id))
      // Each collection.json names its owner by slug and name (spec 11.1).
      if (set.slug !== undefined || set.name !== undefined)
        await c.var.ports.jobs.enqueue({ type: 'collection.info.org', organizationId: org.id })
    }
    return c.json({ ok: true, slug: set.slug ?? org.slug })
  })

  app.delete('/api/accounts/me', async (c) => {
    const userId = requireUser(c, true)
    if (userId instanceof Response) return userId
    // Deleting the account takes a session or an admin key, as org deletion does (capRole).
    if (c.var.principal?.scope === 'read' || c.var.principal?.scope === 'write')
      return jsonError(c, 403, 'Deleting an account needs a session or an admin key')
    const body = (await c.req.json().catch(() => null)) as { confirmSlug?: unknown } | null
    const org = await personalOrg(c, userId)
    if (!org) return jsonError(c, 404, 'Account not found')
    if (body?.confirmSlug !== org.slug) {
      return jsonError(c, 422, 'Username confirmation does not match')
    }
    const held = await collectionCount(c, org.id)
    if (held) {
      return jsonError(
        c,
        409,
        `Your account still holds ${held} collection${held === 1 ? '' : 's'}. Delete or transfer them first.`,
      )
    }
    // Members, sessions, accounts and sent invitations cascade from the user row.
    const { db } = c.var.ports
    await db.batch([
      db.delete(schema.apikey).where(eq(schema.apikey.referenceId, userId)),
      db.delete(schema.apikey).where(eq(schema.apikey.referenceId, org.id)),
      db.delete(schema.organization).where(eq(schema.organization.id, org.id)),
      db.delete(schema.user).where(eq(schema.user.id, userId)),
    ])
    await deleteOrgAvatars(c.var.ports.publicAssets, org.id)
    return c.json({ ok: true })
  })

  app.get('/api/accounts/me/sessions', async (c) => {
    const p = c.var.principal
    if (!p || p.scope !== 'session') return jsonError(c, 401, 'Sign in to see your sessions')
    const rows = await c.var.ports.db
      .select({
        id: schema.session.id,
        userAgent: schema.session.userAgent,
        ipAddress: schema.session.ipAddress,
        createdAt: schema.session.createdAt,
        expiresAt: schema.session.expiresAt,
      })
      .from(schema.session)
      .where(eq(schema.session.userId, p.userId))
    const now = Date.now()
    return c.json(
      rows
        .filter((s) => s.expiresAt.getTime() > now)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map((s) => ({ ...s, current: s.id === p.sessionId })),
    )
  })

  app.delete('/api/accounts/me/sessions/:id', async (c) => {
    const p = c.var.principal
    if (!p || p.scope !== 'session') return jsonError(c, 401, 'Sign in to manage your sessions')
    const gone = await c.var.ports.db
      .delete(schema.session)
      .where(and(eq(schema.session.id, c.req.param('id')), eq(schema.session.userId, p.userId)))
      .returning({ id: schema.session.id })
    if (!gone.length) return jsonError(c, 404, 'Session not found')
    return c.json({ ok: true })
  })

  app.get('/api/accounts/available-kf-orgs', async (c) => {
    const userId = requireUser(c, false)
    if (userId instanceof Response) return userId
    return c.json((await c.var.kf?.orgs(userId)) ?? [])
  })

  app.post('/api/accounts/invitations/accept', async (c) => {
    const userId = requireUser(c, true)
    if (userId instanceof Response) return userId
    const body = (await c.req.json().catch(() => null)) as { token?: unknown } | null
    const token = str(body?.token)
    if (!token) return jsonError(c, 400, 'token is required')
    const { db } = c.var.ports
    const [inv] = await db
      .select({ invitation: schema.invitation, orgSlug: schema.organization.slug })
      .from(schema.invitation)
      .innerJoin(schema.organization, eq(schema.organization.id, schema.invitation.organizationId))
      .where(eq(schema.invitation.id, token))
      .limit(1)
    const [u] = await db.select().from(schema.user).where(eq(schema.user.id, userId)).limit(1)
    // One answer for missing, used, expired and someone else's: the token reveals nothing.
    if (
      !inv ||
      !u ||
      inv.invitation.status !== 'pending' ||
      inv.invitation.expiresAt.getTime() < Date.now() ||
      inv.invitation.email.trim().toLowerCase() !== u.email.trim().toLowerCase()
    ) {
      return jsonError(c, 404, 'Invitation is invalid or expired.')
    }
    const existing = await roleIn(c, inv.invitation.organizationId, userId)
    await db.batch([
      db
        .update(schema.invitation)
        .set({ status: 'accepted' })
        .where(eq(schema.invitation.id, inv.invitation.id)),
      ...(existing
        ? []
        : [
            db.insert(schema.member).values({
              organizationId: inv.invitation.organizationId,
              userId,
              role: inv.invitation.role ?? 'member',
            }),
          ]),
    ])
    return c.json({ ok: true, orgSlug: inv.orgSlug })
  })

  app.patch('/api/accounts/:slug', async (c) => {
    const userId = requireUser(c, true)
    if (userId instanceof Response) return userId
    const org = await orgBySlug(c, c.req.param('slug'))
    if (!org) return jsonError(c, 404, 'Organization not found')
    // An owner acting with a session or an admin key: a write key acts as a member.
    if (capRole(c.var.principal!, await roleIn(c, org.id, userId)) !== 'owner') {
      return jsonError(c, 403, 'Must be an owner to update the organization')
    }
    const body = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>
    if (body.slug !== undefined) {
      const bad = await slugProblem(c, body.slug, org.id)
      if (bad) return bad
    }
    // /api/kf/summary trusts kfOrgId, so a caller may set only one of their own KF orgs.
    const kfOrgId = strOrNull(body.kfOrgId)
    if (kfOrgId && !(await c.var.kf?.entitled(userId, kfOrgId))) {
      return jsonError(c, 403, 'You are not a member of that KF organization')
    }
    const set: Partial<typeof schema.organization.$inferInsert> = {}
    if (str(body.slug) !== undefined) set.slug = str(body.slug)!
    if (str(body.displayName) !== undefined) set.name = str(body.displayName)!
    if (strOrNull(body.bio) !== undefined) set.bio = strOrNull(body.bio)!
    if (strOrNull(body.website) !== undefined) set.website = strOrNull(body.website)!
    if (kfOrgId !== undefined) set.kfOrgId = kfOrgId || null
    if (Object.keys(set).length) {
      await c.var.ports.db
        .update(schema.organization)
        .set(set)
        .where(eq(schema.organization.id, org.id))
      // Each collection.json names its owner by slug and name (spec 11.1).
      if (set.slug !== undefined || set.name !== undefined)
        await c.var.ports.jobs.enqueue({ type: 'collection.info.org', organizationId: org.id })
    }
    return c.json({ ok: true, slug: set.slug ?? org.slug })
  })

  app.delete('/api/accounts/:slug', async (c) => {
    const userId = requireUser(c, true)
    if (userId instanceof Response) return userId
    const org = await orgBySlug(c, c.req.param('slug'))
    if (!org) return jsonError(c, 404, 'Organization not found')
    // An owner acting with a session or an admin key: a write key acts as a member.
    if (capRole(c.var.principal!, await roleIn(c, org.id, userId)) !== 'owner') {
      return jsonError(c, 403, 'Must be an owner to delete the organization')
    }
    if (org.isDefault) return jsonError(c, 409, 'A personal account is deleted from its settings')
    const held = await collectionCount(c, org.id)
    if (held) {
      return jsonError(
        c,
        409,
        `This organization still holds ${held} collection${held === 1 ? '' : 's'}. Delete or transfer them first.`,
      )
    }
    // Members, invitations, locations and placements cascade from the org row.
    const { db } = c.var.ports
    await db.batch([
      db.delete(schema.apikey).where(eq(schema.apikey.referenceId, org.id)),
      db.delete(schema.organization).where(eq(schema.organization.id, org.id)),
    ])
    await deleteOrgAvatars(c.var.ports.publicAssets, org.id)
    return c.json({ ok: true })
  })

  return app
}
