import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { openApi } from 'hono-zod-openapi'
import { z } from 'zod'

import { db, schema } from '../db/client.server.js'
import { deleteS3Objects, listS3Objects, uploadToS3 } from '../lib/s3.js'
import type { AuthEnv } from './auth.server.js'
import { requireAuth } from './auth.server.js'

const ASSETS_BASE_URL = process.env.ASSETS_BASE_URL ?? 'https://assets.underlay.org'

const RESERVED_SLUGS = new Set([
  'explore',
  'docs',
  'connect',
  'blog',
  'dashboard',
  'settings',
  'api',
  'login',
  'signup',
  'admin',
  'about',
  'help',
  'support',
  'search',
  'new',
  'create',
  'edit',
  'delete',
  '404',
  '500',
])

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

function validateSlug(slug: string): string | null {
  if (!slug || typeof slug !== 'string') return 'Slug is required'
  if (slug.length < 2) return 'Slug must be at least 2 characters'
  if (slug.length > 64) return 'Slug must be at most 64 characters'
  if (!SLUG_RE.test(slug)) {
    return 'Slug must be lowercase alphanumeric with hyphens, and cannot start or end with a hyphen'
  }
  if (RESERVED_SLUGS.has(slug)) return 'That slug is reserved'
  return null
}

async function findOrgBySlug(slug: string) {
  const [org] = await db
    .select()
    .from(schema.organization)
    .where(eq(schema.organization.slug, slug))
    .limit(1)
  return org ?? null
}

async function requireOrgMembership(
  organizationId: string,
  userId: string,
  minRole?: 'owner' | 'admin',
) {
  const [membership] = await db
    .select()
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, organizationId), eq(schema.member.userId, userId)))
    .limit(1)
  if (!membership) return null
  if (minRole === 'owner' && membership.role !== 'owner') return null
  if (minRole === 'admin' && membership.role === 'member') return null
  return membership
}

const app = new Hono<AuthEnv>()
  .get(
    '/me',
    requireAuth(),
    openApi({
      tags: ['Accounts'],
      summary: 'Get current user profile',
      responses: { 200: z.any() },
    }),
    async (c) => {
      const userId = c.get('userId')!

      const [u] = await db.select().from(schema.user).where(eq(schema.user.id, userId)).limit(1)

      if (!u) return c.json({ error: 'User not found', statusCode: 404 }, 404)

      const memberships = await db
        .select({
          organizationId: schema.member.organizationId,
          role: schema.member.role,
          slug: schema.organization.slug,
          name: schema.organization.name,
          isDefault: schema.organization.isDefault,
        })
        .from(schema.member)
        .innerJoin(schema.organization, eq(schema.member.organizationId, schema.organization.id))
        .where(eq(schema.member.userId, u.id))

      const defaultOrg = memberships.find((m) => m.isDefault)

      return c.json({
        id: u.id,
        name: u.name,
        email: u.email,
        image: u.image,
        slug: defaultOrg?.slug ?? null,
        displayName: defaultOrg?.name ?? u.name,
        createdAt: u.createdAt,
        orgs: memberships,
      })
    },
  )
  .get(
    '/available-kf-orgs',
    requireAuth(),
    openApi({
      tags: ['Accounts'],
      summary: 'List KF orgs available to link',
      responses: { 200: z.any() },
    }),
    async (c) => {
      const userId = c.get('userId')!

      const [acct] = await db
        .select({ accountId: schema.account.accountId })
        .from(schema.account)
        .where(and(eq(schema.account.userId, userId), eq(schema.account.providerId, 'kf-auth')))
        .limit(1)

      if (!acct) return c.json([])

      const { fetchAuthOrgs } = await import('../lib/auth-internal.server.js')
      return c.json(await fetchAuthOrgs(acct.accountId))
    },
  )
  .get(
    '/:slug',
    openApi({
      tags: ['Accounts'],
      summary: 'Get organization by slug',
      request: { param: z.object({ slug: z.string() }) },
      responses: { 200: z.any(), 404: z.object({ error: z.string() }) },
    }),
    async (c) => {
      const { slug } = c.req.valid('param')
      const org = await findOrgBySlug(slug)

      if (!org) return c.json({ error: 'Not found', statusCode: 404 }, 404)

      const [shoulderRow] = await db
        .select({ shoulder: schema.arkShoulders.shoulder })
        .from(schema.arkShoulders)
        .where(eq(schema.arkShoulders.organizationId, org.id))
        .limit(1)

      return c.json({
        ...org,
        displayName: org.name,
        arkShoulder: shoulderRow?.shoulder ?? null,
      })
    },
  )
  .get(
    '/:slug/members',
    openApi({
      tags: ['Accounts'],
      summary: 'List members of an organization',
      request: { param: z.object({ slug: z.string() }) },
      responses: { 200: z.any() },
    }),
    async (c) => {
      const { slug } = c.req.valid('param')
      const org = await findOrgBySlug(slug)
      if (!org) return c.json({ error: 'Not found', statusCode: 404 }, 404)

      const defaultOrgSub = db
        .select({
          userId: schema.member.userId,
          slug: schema.organization.slug,
          name: schema.organization.name,
        })
        .from(schema.member)
        .innerJoin(
          schema.organization,
          and(
            eq(schema.member.organizationId, schema.organization.id),
            eq(schema.organization.isDefault, true),
          ),
        )
        .as('default_org')

      const rows = await db
        .select({
          role: schema.member.role,
          slug: defaultOrgSub.slug,
          displayName: defaultOrgSub.name,
        })
        .from(schema.member)
        .leftJoin(defaultOrgSub, eq(schema.member.userId, defaultOrgSub.userId))
        .where(eq(schema.member.organizationId, org.id))

      return c.json(rows)
    },
  )
  .patch(
    '/me',
    requireAuth(),
    openApi({
      tags: ['Accounts'],
      summary: 'Update own profile',
      request: { json: z.any() },
      responses: { 200: z.any() },
    }),
    async (c) => {
      const { slug, displayName, bio, website } = c.req.valid('json')
      const userId = c.get('userId')!

      const [defaultMembership] = await db
        .select({ organizationId: schema.member.organizationId })
        .from(schema.member)
        .innerJoin(schema.organization, eq(schema.member.organizationId, schema.organization.id))
        .where(and(eq(schema.member.userId, userId), eq(schema.organization.isDefault, true)))
        .limit(1)

      if (!defaultMembership) {
        return c.json({ error: 'Default org not found', statusCode: 404 }, 404)
      }

      const organizationId = defaultMembership.organizationId

      if (slug !== undefined) {
        const slugErr = validateSlug(slug)
        if (slugErr) return c.json({ error: slugErr, statusCode: 422 }, 422)

        const [existing] = await db
          .select({ id: schema.organization.id })
          .from(schema.organization)
          .where(eq(schema.organization.slug, slug))
          .limit(1)

        if (existing && existing.id !== organizationId) {
          return c.json({ error: 'That slug is already taken', statusCode: 409 }, 409)
        }
      }

      const updates: Record<string, any> = {}
      if (slug !== undefined) updates.slug = slug
      if (displayName !== undefined) updates.name = displayName
      if (bio !== undefined) updates.bio = bio
      if (website !== undefined) updates.website = website

      if (Object.keys(updates).length > 0) {
        await db
          .update(schema.organization)
          .set(updates)
          .where(eq(schema.organization.id, organizationId))
      }

      return c.json({ ok: true, slug: slug ?? undefined })
    },
  )
  .post(
    '/:slug/avatar',
    requireAuth(),
    openApi({
      tags: ['Accounts'],
      summary: 'Upload organization avatar',
      request: { param: z.object({ slug: z.string() }) },
      responses: { 200: z.any() },
    }),
    async (c) => {
      const { slug } = c.req.valid('param')
      const userId = c.get('userId')!

      const org = await findOrgBySlug(slug)
      if (!org) return c.json({ error: 'Organization not found', statusCode: 404 }, 404)

      if (!(await requireOrgMembership(org.id, userId, 'owner'))) {
        return c.json(
          { error: 'Must be an owner to update the organization avatar', statusCode: 403 },
          403,
        )
      }

      const body = await c.req.parseBody()
      const file = Object.values(body).find((v): v is File => v instanceof File)
      if (!file) return c.json({ error: 'No file uploaded', statusCode: 400 }, 400)

      const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
      if (!allowedTypes.includes(file.type)) {
        return c.json(
          { error: 'Only JPEG, PNG, GIF, and WebP images are allowed', statusCode: 422 },
          422,
        )
      }

      const buffer = Buffer.from(await file.arrayBuffer())
      if (buffer.length > 5 * 1024 * 1024) {
        return c.json({ error: 'Image must be less than 5MB', statusCode: 422 }, 422)
      }

      const ext = file.type.split('/')[1] === 'jpeg' ? 'jpg' : file.type.split('/')[1]
      const key = `avatars/${org.id}/${Date.now()}.${ext}`

      await uploadToS3(key, buffer, file.type)

      await db
        .update(schema.organization)
        .set({ avatarUrl: `${ASSETS_BASE_URL}/${key}` })
        .where(eq(schema.organization.id, org.id))

      return c.json({ ok: true, avatarUrl: `${ASSETS_BASE_URL}/${key}` })
    },
  )
  .delete(
    '/me',
    requireAuth(),
    openApi({
      tags: ['Accounts'],
      summary: 'Delete own account',
      request: { json: z.object({ confirmSlug: z.string() }) },
      responses: { 200: z.any() },
    }),
    async (c) => {
      const { confirmSlug } = c.req.valid('json')
      const userId = c.get('userId')!

      const [defaultOrg] = await db
        .select({ id: schema.organization.id, slug: schema.organization.slug })
        .from(schema.organization)
        .innerJoin(schema.member, eq(schema.organization.id, schema.member.organizationId))
        .where(and(eq(schema.member.userId, userId), eq(schema.organization.isDefault, true)))
        .limit(1)

      if (!defaultOrg) return c.json({ error: 'Account not found', statusCode: 404 }, 404)

      if (confirmSlug !== defaultOrg.slug) {
        return c.json({ error: 'Username confirmation does not match', statusCode: 422 }, 422)
      }

      try {
        const avatarKeys = await listS3Objects(`avatars/${defaultOrg.id}/`)
        if (avatarKeys.length > 0) await deleteS3Objects(avatarKeys)
      } catch (err) {
        // Non-fatal — orphaned avatars are harmless
        console.error(`[accounts] Failed to delete avatars for org ${defaultOrg.id}:`, err)
      }

      await db.delete(schema.apikey).where(eq(schema.apikey.referenceId, userId))
      await db.delete(schema.apikey).where(eq(schema.apikey.referenceId, defaultOrg.id))
      await db.delete(schema.invitation).where(eq(schema.invitation.organizationId, defaultOrg.id))
      await db.delete(schema.member).where(eq(schema.member.userId, userId))
      await db.delete(schema.session).where(eq(schema.session.userId, userId))
      await db.delete(schema.account).where(eq(schema.account.userId, userId))
      await db.delete(schema.organization).where(eq(schema.organization.id, defaultOrg.id))
      await db.delete(schema.user).where(eq(schema.user.id, userId))
      return c.json({ ok: true })
    },
  )
  .patch(
    '/:slug',
    requireAuth(),
    openApi({
      tags: ['Accounts'],
      summary: 'Update an organization by slug',
      request: {
        param: z.object({ slug: z.string() }),
        json: z.any(),
      },
      responses: { 200: z.any() },
    }),
    async (c) => {
      const { slug: orgSlug } = c.req.valid('param')
      const userId = c.get('userId')!

      const org = await findOrgBySlug(orgSlug)
      if (!org) return c.json({ error: 'Organization not found', statusCode: 404 }, 404)

      if (!(await requireOrgMembership(org.id, userId, 'owner'))) {
        return c.json(
          { error: 'Must be an owner to update the organization', statusCode: 403 },
          403,
        )
      }

      const { slug, displayName, bio, website, location, kfOrgId } = c.req.valid('json')

      if (slug !== undefined) {
        const slugErr = validateSlug(slug)
        if (slugErr) return c.json({ error: slugErr, statusCode: 422 }, 422)

        const [existing] = await db
          .select({ id: schema.organization.id })
          .from(schema.organization)
          .where(eq(schema.organization.slug, slug))
          .limit(1)

        if (existing && existing.id !== org.id) {
          return c.json({ error: 'That slug is already taken', statusCode: 409 }, 409)
        }
      }

      const updates: Record<string, any> = {}
      if (slug !== undefined) updates.slug = slug
      if (displayName !== undefined) updates.name = displayName
      if (bio !== undefined) updates.bio = bio
      if (website !== undefined) updates.website = website
      if (location !== undefined) updates.location = location
      if (kfOrgId !== undefined) updates.kfOrgId = kfOrgId

      if (Object.keys(updates).length > 0) {
        await db.update(schema.organization).set(updates).where(eq(schema.organization.id, org.id))
      }

      return c.json({ ok: true, slug: slug ?? orgSlug })
    },
  )
  .delete(
    '/:slug',
    requireAuth(),
    openApi({
      tags: ['Accounts'],
      summary: 'Delete an organization by slug',
      request: { param: z.object({ slug: z.string() }) },
      responses: { 200: z.any() },
    }),
    async (c) => {
      const { slug } = c.req.valid('param')
      const userId = c.get('userId')!

      const org = await findOrgBySlug(slug)
      if (!org) return c.json({ error: 'Organization not found', statusCode: 404 }, 404)

      if (!(await requireOrgMembership(org.id, userId, 'owner'))) {
        return c.json(
          { error: 'Must be an owner to delete the organization', statusCode: 403 },
          403,
        )
      }

      try {
        const avatarKeys = await listS3Objects(`avatars/${org.id}/`)
        if (avatarKeys.length > 0) await deleteS3Objects(avatarKeys)
      } catch (err) {
        // Non-fatal — orphaned avatars are harmless
        console.error(`[accounts] Failed to delete avatars for org ${org.id}:`, err)
      }

      await db.delete(schema.apikey).where(eq(schema.apikey.referenceId, org.id))
      await db.delete(schema.invitation).where(eq(schema.invitation.organizationId, org.id))
      await db.delete(schema.member).where(eq(schema.member.organizationId, org.id))
      await db.delete(schema.organization).where(eq(schema.organization.id, org.id))
      return c.json({ ok: true })
    },
  )

export default app
