/**
 * Adding members to an org by email, without an invitation (lib/pending-members.ts):
 *
 *   POST   /api/accounts/:slug/members              {email, role?: member|admin}
 *   GET    /api/accounts/:slug/members/pending      adds waiting for a first sign-in
 *   DELETE /api/accounts/:slug/members/pending/:id
 *
 * Owners and admins, by session or an admin key; adding an admin takes an owner. An owner
 * is never added this way: that role comes with an invitation the person accepts.
 */
import { and, eq } from 'drizzle-orm'
import { type Context, Hono } from 'hono'

import type { AppEnv } from '../app.js'
import * as schema from '../db/schema.js'
import { looksLikeEmail, normalizeEmail, userByEmail } from '../lib/pending-members.js'
import { capRole, isAdmin, jsonError } from './access.js'
import { orgBySlug, requireUser, roleIn } from './accounts.js'

const ROLES = ['member', 'admin'] as const

type Org = typeof schema.organization.$inferSelect

/** The org and the caller's role in it, when they may manage members; else the error. */
async function managedOrg(
  c: Context<AppEnv>,
  write: boolean,
): Promise<{ org: Org; role: string; userId: string } | Response> {
  const userId = requireUser(c, write)
  if (userId instanceof Response) return userId
  const org = await orgBySlug(c, c.req.param('slug') ?? '')
  if (!org) return jsonError(c, 404, 'Organization not found')
  const role = capRole(c.var.principal!, await roleIn(c, org.id, userId))
  if (!isAdmin(role)) return jsonError(c, 403, 'Must be an owner or admin to manage members')
  return { org, role: role!, userId }
}

export function orgMemberRoutes() {
  const app = new Hono<AppEnv>()

  app.post('/api/accounts/:slug/members', async (c) => {
    const ctx = await managedOrg(c, true)
    if (ctx instanceof Response) return ctx
    const body = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>
    const email = typeof body.email === 'string' ? normalizeEmail(body.email) : ''
    if (!looksLikeEmail(email)) return jsonError(c, 422, 'Enter an email address')
    const role = body.role === undefined ? 'member' : body.role
    if (!ROLES.includes(role as (typeof ROLES)[number]))
      return jsonError(c, 422, 'role must be member or admin; invite an owner instead')
    if (role === 'admin' && ctx.role !== 'owner')
      return jsonError(c, 403, 'Only an owner can add an admin')

    const { db } = c.var.ports
    const user = await userByEmail(db, email)
    if (user) {
      if (await roleIn(c, ctx.org.id, user.id))
        return c.json({ status: 'already-member', name: user.name })
      await db
        .insert(schema.member)
        .values({ organizationId: ctx.org.id, userId: user.id, role: role as string })
      return c.json({ status: 'added', name: user.name }, 201)
    }
    // No account here yet: they join when they first sign in with this address.
    await db
      .insert(schema.pendingMembers)
      .values({ organizationId: ctx.org.id, email, role: role as string, addedBy: ctx.userId })
      .onConflictDoUpdate({
        target: [schema.pendingMembers.organizationId, schema.pendingMembers.email],
        set: { role: role as string },
      })
    return c.json({ status: 'pending', email }, 202)
  })

  app.get('/api/accounts/:slug/members/pending', async (c) => {
    const ctx = await managedOrg(c, false)
    if (ctx instanceof Response) return ctx
    const rows = await c.var.ports.db
      .select({
        id: schema.pendingMembers.id,
        email: schema.pendingMembers.email,
        role: schema.pendingMembers.role,
        createdAt: schema.pendingMembers.createdAt,
      })
      .from(schema.pendingMembers)
      .where(eq(schema.pendingMembers.organizationId, ctx.org.id))
    return c.json(rows)
  })

  app.delete('/api/accounts/:slug/members/pending/:id', async (c) => {
    const ctx = await managedOrg(c, true)
    if (ctx instanceof Response) return ctx
    const gone = await c.var.ports.db
      .delete(schema.pendingMembers)
      .where(
        and(
          eq(schema.pendingMembers.id, c.req.param('id')),
          eq(schema.pendingMembers.organizationId, ctx.org.id),
        ),
      )
      .returning({ id: schema.pendingMembers.id })
    if (!gone.length) return jsonError(c, 404, 'Not found')
    return c.json({ ok: true })
  })

  return app
}
