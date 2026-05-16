import bcrypt from 'bcrypt'
import { and, count, eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { getCookie } from 'hono/cookie'
import { v4 as uuidv4 } from 'uuid'

import { db, schema } from '../db/client.server.js'
import { sendEmail } from '../lib/email.js'
import { deleteS3Objects, listS3Objects, uploadToS3 } from '../lib/s3.js'
import { type AuthEnv, clearSessionCookie } from './auth.server.js'

/** Base URL for public assets (avatars, etc.) */
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

/** Validate a slug and return an error message or null if valid. */
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

// Get current user
export async function getMe(c: Context<AuthEnv>) {
  const [account] = await db
    .select({
      id: schema.accounts.id,
      slug: schema.accounts.slug,
      type: schema.accounts.type,
      displayName: schema.accounts.displayName,
      bio: schema.accounts.bio,
      website: schema.accounts.website,
      location: schema.accounts.location,
      avatarUrl: schema.accounts.avatarUrl,
      notificationPrefs: schema.accounts.notificationPrefs,
      createdAt: schema.accounts.createdAt,
    })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, c.get('accountId')!))
    .limit(1)

  if (!account) {
    return c.json({ error: 'Account not found', statusCode: 404 }, 404)
  }

  // Fetch org memberships
  const memberships = await db
    .select({
      orgId: schema.orgMemberships.orgId,
      role: schema.orgMemberships.role,
      slug: schema.accounts.slug,
      displayName: schema.accounts.displayName,
    })
    .from(schema.orgMemberships)
    .innerJoin(schema.accounts, eq(schema.orgMemberships.orgId, schema.accounts.id))
    .where(eq(schema.orgMemberships.userId, account.id))

  return c.json({ ...account, orgs: memberships })
}

// Get account by slug (public)
export async function getBySlug(c: Context<AuthEnv>) {
  const slug = c.req.param('slug')!
  const [account] = await db
    .select({
      id: schema.accounts.id,
      slug: schema.accounts.slug,
      type: schema.accounts.type,
      displayName: schema.accounts.displayName,
      bio: schema.accounts.bio,
      website: schema.accounts.website,
      location: schema.accounts.location,
      avatarUrl: schema.accounts.avatarUrl,
      arkNaan: schema.accounts.arkNaan,
      kfOrgId: schema.accounts.kfOrgId,
      createdAt: schema.accounts.createdAt,
    })
    .from(schema.accounts)
    .where(eq(schema.accounts.slug, slug))
    .limit(1)

  if (!account) {
    return c.json({ error: 'Account not found', statusCode: 404 }, 404)
  }

  // Include ARK shoulder if minted
  const [shoulderRow] = await db
    .select({ shoulder: schema.arkShoulders.shoulder })
    .from(schema.arkShoulders)
    .where(eq(schema.arkShoulders.accountId, account.id))
    .limit(1)

  return c.json({ ...account, arkShoulder: shoulderRow?.shoulder ?? null })
}

// Update own profile
export async function updateMe(c: Context<AuthEnv>) {
  // Name, email, and avatar are managed by KF Auth — only Underlay-specific fields are writable here.
  const { slug, bio, website, location, notificationPrefs } = await c.req.json()

  const accountId = c.get('accountId')!

  if (slug !== undefined) {
    const slugErr = validateSlug(slug)
    if (slugErr) return c.json({ error: slugErr, statusCode: 422 }, 422)

    const [existing] = await db
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(eq(schema.accounts.slug, slug))
      .limit(1)

    if (existing && existing.id !== accountId) {
      return c.json({ error: 'That slug is already taken', statusCode: 409 }, 409)
    }
  }

  const updates: Record<string, any> = {}
  if (slug !== undefined) updates.slug = slug
  if (bio !== undefined) updates.bio = bio
  if (website !== undefined) updates.website = website
  if (location !== undefined) updates.location = location
  if (notificationPrefs !== undefined) updates.notificationPrefs = notificationPrefs

  if (Object.keys(updates).length > 0) {
    await db.update(schema.accounts).set(updates).where(eq(schema.accounts.id, accountId))
  }

  return c.json({ ok: true, slug: slug ?? undefined })
}

// Upload avatar
export async function uploadAvatar(c: Context<AuthEnv>) {
  const body = await c.req.parseBody()
  const file = Object.values(body).find((v): v is File => v instanceof File)
  if (!file) {
    return c.json({ error: 'No file uploaded', statusCode: 400 }, 400)
  }

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
  const accountId = c.get('accountId')!
  const key = `avatars/${accountId}/${Date.now()}.${ext}`

  await uploadToS3(key, buffer, file.type)

  await db
    .update(schema.accounts)
    .set({ avatarUrl: `${ASSETS_BASE_URL}/${key}` })
    .where(eq(schema.accounts.id, accountId))

  return c.json({ ok: true, avatarUrl: `${ASSETS_BASE_URL}/${key}` })
}

// List sessions
export async function listSessions(c: Context<AuthEnv>) {
  const sessions = await db
    .select({
      id: schema.sessions.id,
      userAgent: schema.sessions.userAgent,
      ipAddress: schema.sessions.ipAddress,
      createdAt: schema.sessions.createdAt,
      expiresAt: schema.sessions.expiresAt,
    })
    .from(schema.sessions)
    .where(eq(schema.sessions.userId, c.get('accountId')!))

  // Get current session ID to mark it
  const currentSessionId = getCookie(c, 'session')
  return c.json(
    sessions.map((s) => ({
      ...s,
      current: s.id === currentSessionId,
    })),
  )
}

// Revoke a session
export async function deleteSession(c: Context<AuthEnv>) {
  const sessionId = c.req.param('sessionId')!

  const [session] = await db
    .select()
    .from(schema.sessions)
    .where(and(eq(schema.sessions.id, sessionId), eq(schema.sessions.userId, c.get('accountId')!)))
    .limit(1)

  if (!session) {
    return c.json({ error: 'Session not found', statusCode: 404 }, 404)
  }

  await db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId))
  return c.json({ ok: true })
}

// Delete own account
export async function deleteMe(c: Context<AuthEnv>) {
  const { confirmSlug } = await c.req.json()

  const [account] = await db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.id, c.get('accountId')!))
    .limit(1)

  if (!account) {
    return c.json({ error: 'Account not found', statusCode: 404 }, 404)
  }

  if (confirmSlug !== account.slug) {
    return c.json({ error: 'Username confirmation does not match', statusCode: 422 }, 422)
  }

  // Check for owned collections
  const [collCount] = await db
    .select({ count: count() })
    .from(schema.collections)
    .where(eq(schema.collections.accountId, account.id))

  if (collCount && collCount.count > 0) {
    return c.json(
      {
        error: `You still own ${collCount.count} collection(s). Transfer or delete them before deleting your account.`,
        statusCode: 422,
      },
      422,
    )
  }

  // Clean up S3 avatars
  try {
    const avatarKeys = await listS3Objects(`avatars/${account.id}/`)
    if (avatarKeys.length > 0) {
      await deleteS3Objects(avatarKeys)
    }
  } catch {
    // Non-fatal: avatar cleanup failed
  }

  // Cascade will handle sessions, memberships, api keys
  await db.delete(schema.accounts).where(eq(schema.accounts.id, account.id))
  clearSessionCookie(c)
  return c.json({ ok: true })
}

// Create API key
export async function createKey(c: Context<AuthEnv>) {
  const { label, scope, collectionId, expiresIn } = await c.req.json()

  const rawKey = `ul_${uuidv4().replace(/-/g, '')}`
  const keyHash = await bcrypt.hash(rawKey, 10)
  const keyPrefix = rawKey.slice(0, 12)

  const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 24 * 60 * 60 * 1000) : null

  const [key] = await db
    .insert(schema.apiKeys)
    .values({
      accountId: c.get('accountId')!,
      scope,
      keyHash,
      keyPrefix,
      label,
      collectionId: collectionId ?? null,
      expiresAt,
    })
    .returning()

  return c.json(
    {
      id: key!.id,
      key: rawKey, // shown once
      label,
      scope,
      keyPrefix,
      collectionId: collectionId ?? null,
      expiresAt,
    },
    201,
  )
}

// List API keys
export async function listKeys(c: Context<AuthEnv>) {
  const keys = await db
    .select({
      id: schema.apiKeys.id,
      label: schema.apiKeys.label,
      scope: schema.apiKeys.scope,
      keyPrefix: schema.apiKeys.keyPrefix,
      collectionId: schema.apiKeys.collectionId,
      expiresAt: schema.apiKeys.expiresAt,
      createdAt: schema.apiKeys.createdAt,
      lastUsedAt: schema.apiKeys.lastUsedAt,
    })
    .from(schema.apiKeys)
    .where(eq(schema.apiKeys.accountId, c.get('accountId')!))
  return c.json(keys)
}

// Delete API key
export async function deleteKey(c: Context<AuthEnv>) {
  const id = c.req.param('id')!
  const [key] = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, id)).limit(1)

  if (!key || key.accountId !== c.get('accountId')) {
    return c.json({ error: 'Key not found', statusCode: 404 }, 404)
  }

  await db.delete(schema.apiKeys).where(eq(schema.apiKeys.id, id))
  return c.json({ ok: true })
}

// --- Org-scoped API Keys ---

// Create API key for an org
export async function createOrgKey(c: Context<AuthEnv>) {
  const slug = c.req.param('slug')!
  const { label, scope, collectionId, expiresIn } = await c.req.json()

  const [org] = await db
    .select()
    .from(schema.accounts)
    .where(and(eq(schema.accounts.slug, slug), eq(schema.accounts.type, 'org')))
    .limit(1)

  if (!org) return c.json({ error: 'Organization not found', statusCode: 404 }, 404)

  // Must be owner or admin
  const [membership] = await db
    .select()
    .from(schema.orgMemberships)
    .where(
      and(
        eq(schema.orgMemberships.orgId, org.id),
        eq(schema.orgMemberships.userId, c.get('accountId')!),
      ),
    )
    .limit(1)

  if (!membership || membership.role === 'member') {
    return c.json(
      { error: 'Must be an owner or admin to manage org API keys', statusCode: 403 },
      403,
    )
  }

  const rawKey = `ul_${uuidv4().replace(/-/g, '')}`
  const keyHash = await bcrypt.hash(rawKey, 10)
  const keyPrefix = rawKey.slice(0, 12)

  const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 24 * 60 * 60 * 1000) : null

  const [key] = await db
    .insert(schema.apiKeys)
    .values({
      accountId: org.id,
      scope,
      keyHash,
      keyPrefix,
      label,
      collectionId: collectionId ?? null,
      expiresAt,
    })
    .returning()

  return c.json(
    {
      id: key!.id,
      key: rawKey,
      label,
      scope,
      keyPrefix,
      collectionId: collectionId ?? null,
      expiresAt,
    },
    201,
  )
}

// List org API keys
export async function listOrgKeys(c: Context<AuthEnv>) {
  const slug = c.req.param('slug')!

  const [org] = await db
    .select()
    .from(schema.accounts)
    .where(and(eq(schema.accounts.slug, slug), eq(schema.accounts.type, 'org')))
    .limit(1)

  if (!org) return c.json({ error: 'Organization not found', statusCode: 404 }, 404)

  // Must be a member
  const [membership] = await db
    .select()
    .from(schema.orgMemberships)
    .where(
      and(
        eq(schema.orgMemberships.orgId, org.id),
        eq(schema.orgMemberships.userId, c.get('accountId')!),
      ),
    )
    .limit(1)

  if (!membership) return c.json({ error: 'Forbidden', statusCode: 403 }, 403)

  const keys = await db
    .select({
      id: schema.apiKeys.id,
      label: schema.apiKeys.label,
      scope: schema.apiKeys.scope,
      keyPrefix: schema.apiKeys.keyPrefix,
      collectionId: schema.apiKeys.collectionId,
      expiresAt: schema.apiKeys.expiresAt,
      createdAt: schema.apiKeys.createdAt,
      lastUsedAt: schema.apiKeys.lastUsedAt,
    })
    .from(schema.apiKeys)
    .where(eq(schema.apiKeys.accountId, org.id))

  return c.json(keys)
}

// Delete org API key
export async function deleteOrgKey(c: Context<AuthEnv>) {
  const slug = c.req.param('slug')!
  const id = c.req.param('id')!

  const [org] = await db
    .select()
    .from(schema.accounts)
    .where(and(eq(schema.accounts.slug, slug), eq(schema.accounts.type, 'org')))
    .limit(1)

  if (!org) return c.json({ error: 'Organization not found', statusCode: 404 }, 404)

  const [membership] = await db
    .select()
    .from(schema.orgMemberships)
    .where(
      and(
        eq(schema.orgMemberships.orgId, org.id),
        eq(schema.orgMemberships.userId, c.get('accountId')!),
      ),
    )
    .limit(1)

  if (!membership || membership.role === 'member') {
    return c.json(
      { error: 'Must be an owner or admin to manage org API keys', statusCode: 403 },
      403,
    )
  }

  const [key] = await db
    .select()
    .from(schema.apiKeys)
    .where(and(eq(schema.apiKeys.id, id), eq(schema.apiKeys.accountId, org.id)))
    .limit(1)

  if (!key) return c.json({ error: 'Key not found', statusCode: 404 }, 404)

  await db.delete(schema.apiKeys).where(eq(schema.apiKeys.id, id))
  return c.json({ ok: true })
}

// --- Org Management ---

// Create organization
export async function createOrg(c: Context<AuthEnv>) {
  const { slug, displayName, kfOrgId } = await c.req.json()

  if (!kfOrgId || typeof kfOrgId !== 'string') {
    return c.json(
      {
        error: 'kfOrgId is required — every Underlay org must be linked to a KF org',
        statusCode: 422,
      },
      422,
    )
  }

  if (RESERVED_SLUGS.has(slug.toLowerCase())) {
    return c.json({ error: 'That name is reserved', statusCode: 422 }, 422)
  }

  if (!/^[a-z0-9][a-z0-9\-]*[a-z0-9]$/.test(slug) || slug.length < 2) {
    return c.json(
      {
        error: 'Slug must be lowercase alphanumeric with hyphens, at least 2 characters',
        statusCode: 422,
      },
      422,
    )
  }

  const existing = await db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.slug, slug))
    .limit(1)

  if (existing.length > 0) {
    return c.json({ error: 'Name already taken', statusCode: 409 }, 409)
  }

  const id = uuidv4()
  await db.insert(schema.accounts).values({
    id,
    slug,
    type: 'org',
    displayName,
    kfOrgId,
  })

  // Add the creating user as owner
  await db.insert(schema.orgMemberships).values({
    orgId: id,
    userId: c.get('accountId')!,
    role: 'owner',
  })

  return c.json({ id, slug, displayName, type: 'org', kfOrgId }, 201)
}

/**
 * GET /api/accounts/available-kf-orgs
 * Returns all KF orgs the current user belongs to.
 */
export async function availableKfOrgs(c: Context<AuthEnv>) {
  const accountId = c.get('accountId')!

  // Fetch user's KF orgs on demand from KF Auth internal API
  const { fetchKfOrgs } = await import('../lib/kf-orgs.server.js')
  return c.json(await fetchKfOrgs(accountId))
}

// List org members
export async function listMembers(c: Context<AuthEnv>) {
  const slug = c.req.param('slug')!

  const [org] = await db
    .select()
    .from(schema.accounts)
    .where(and(eq(schema.accounts.slug, slug), eq(schema.accounts.type, 'org')))
    .limit(1)

  if (!org) return c.json({ error: 'Organization not found', statusCode: 404 }, 404)

  // Must be a member to view
  const [membership] = await db
    .select()
    .from(schema.orgMemberships)
    .where(
      and(
        eq(schema.orgMemberships.orgId, org.id),
        eq(schema.orgMemberships.userId, c.get('accountId')!),
      ),
    )
    .limit(1)

  if (!membership) return c.json({ error: 'Forbidden', statusCode: 403 }, 403)

  const members = await db
    .select({
      userId: schema.orgMemberships.userId,
      role: schema.orgMemberships.role,
      slug: schema.accounts.slug,
      displayName: schema.accounts.displayName,
    })
    .from(schema.orgMemberships)
    .innerJoin(schema.accounts, eq(schema.orgMemberships.userId, schema.accounts.id))
    .where(eq(schema.orgMemberships.orgId, org.id))

  return c.json(members)
}

// Add org member
export async function addMember(c: Context<AuthEnv>) {
  const slug = c.req.param('slug')!
  const { username, role } = await c.req.json()

  const [org] = await db
    .select()
    .from(schema.accounts)
    .where(and(eq(schema.accounts.slug, slug), eq(schema.accounts.type, 'org')))
    .limit(1)

  if (!org) return c.json({ error: 'Organization not found', statusCode: 404 }, 404)

  // Must be owner or admin
  const [callerMembership] = await db
    .select()
    .from(schema.orgMemberships)
    .where(
      and(
        eq(schema.orgMemberships.orgId, org.id),
        eq(schema.orgMemberships.userId, c.get('accountId')!),
      ),
    )
    .limit(1)

  if (!callerMembership || callerMembership.role === 'member') {
    return c.json({ error: 'Must be an owner or admin to add members', statusCode: 403 }, 403)
  }

  // Find user to add
  const [user] = await db
    .select()
    .from(schema.accounts)
    .where(and(eq(schema.accounts.slug, username), eq(schema.accounts.type, 'user')))
    .limit(1)

  if (!user) return c.json({ error: 'User not found', statusCode: 404 }, 404)

  // Check not already a member
  const [existing] = await db
    .select()
    .from(schema.orgMemberships)
    .where(and(eq(schema.orgMemberships.orgId, org.id), eq(schema.orgMemberships.userId, user.id)))
    .limit(1)

  if (existing) return c.json({ error: 'Already a member', statusCode: 409 }, 409)

  await db.insert(schema.orgMemberships).values({
    orgId: org.id,
    userId: user.id,
    role: role ?? 'member',
  })

  return c.json({ ok: true, username, role }, 201)
}

// Update member role
export async function updateMember(c: Context<AuthEnv>) {
  const slug = c.req.param('slug')!
  const userId = c.req.param('userId')!
  const { role } = await c.req.json()

  const [org] = await db
    .select()
    .from(schema.accounts)
    .where(and(eq(schema.accounts.slug, slug), eq(schema.accounts.type, 'org')))
    .limit(1)

  if (!org) return c.json({ error: 'Organization not found', statusCode: 404 }, 404)

  // Must be owner
  const [callerMembership] = await db
    .select()
    .from(schema.orgMemberships)
    .where(
      and(
        eq(schema.orgMemberships.orgId, org.id),
        eq(schema.orgMemberships.userId, c.get('accountId')!),
      ),
    )
    .limit(1)

  if (!callerMembership || callerMembership.role !== 'owner') {
    return c.json({ error: 'Must be an owner to change roles', statusCode: 403 }, 403)
  }

  await db
    .update(schema.orgMemberships)
    .set({ role })
    .where(and(eq(schema.orgMemberships.orgId, org.id), eq(schema.orgMemberships.userId, userId)))

  return c.json({ ok: true })
}

// Remove member
export async function removeMember(c: Context<AuthEnv>) {
  const slug = c.req.param('slug')!
  const userId = c.req.param('userId')!

  const [org] = await db
    .select()
    .from(schema.accounts)
    .where(and(eq(schema.accounts.slug, slug), eq(schema.accounts.type, 'org')))
    .limit(1)

  if (!org) return c.json({ error: 'Organization not found', statusCode: 404 }, 404)

  // Must be owner or admin (or removing yourself)
  const [callerMembership] = await db
    .select()
    .from(schema.orgMemberships)
    .where(
      and(
        eq(schema.orgMemberships.orgId, org.id),
        eq(schema.orgMemberships.userId, c.get('accountId')!),
      ),
    )
    .limit(1)

  const isSelf = c.get('accountId') === userId
  if (!callerMembership || (callerMembership.role === 'member' && !isSelf)) {
    return c.json({ error: 'Forbidden', statusCode: 403 }, 403)
  }

  await db
    .delete(schema.orgMemberships)
    .where(and(eq(schema.orgMemberships.orgId, org.id), eq(schema.orgMemberships.userId, userId)))

  return c.json({ ok: true })
}

// Update org profile
export async function updateOrg(c: Context<AuthEnv>) {
  const slug = c.req.param('slug')!
  const { slug: newSlug, displayName, bio, website, location, kfOrgId } = await c.req.json()

  const [org] = await db
    .select()
    .from(schema.accounts)
    .where(and(eq(schema.accounts.slug, slug), eq(schema.accounts.type, 'org')))
    .limit(1)

  if (!org) return c.json({ error: 'Organization not found', statusCode: 404 }, 404)

  // Must be owner
  const [callerMembership] = await db
    .select()
    .from(schema.orgMemberships)
    .where(
      and(
        eq(schema.orgMemberships.orgId, org.id),
        eq(schema.orgMemberships.userId, c.get('accountId')!),
      ),
    )
    .limit(1)

  if (!callerMembership || callerMembership.role !== 'owner') {
    return c.json({ error: 'Must be an owner to update the organization', statusCode: 403 }, 403)
  }

  // Validate slug change if provided
  if (newSlug !== undefined) {
    const slugErr = validateSlug(newSlug)
    if (slugErr) return c.json({ error: slugErr, statusCode: 422 }, 422)

    const [existing] = await db
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(eq(schema.accounts.slug, newSlug))
      .limit(1)

    if (existing && existing.id !== org.id) {
      return c.json({ error: 'That slug is already taken', statusCode: 409 }, 409)
    }
  }

  // Validate kfOrgId change if provided
  if (kfOrgId !== undefined) {
    if (!kfOrgId || typeof kfOrgId !== 'string') {
      return c.json({ error: 'kfOrgId must be a non-empty string', statusCode: 422 }, 422)
    }
    // Check it's not already linked to another UL org
    const [alreadyLinked] = await db
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(and(eq(schema.accounts.kfOrgId, kfOrgId), eq(schema.accounts.type, 'org')))
      .limit(1)

    if (alreadyLinked && alreadyLinked.id !== org.id) {
      return c.json(
        {
          error: 'This KF organization is already linked to another Underlay org',
          statusCode: 409,
        },
        409,
      )
    }
  }

  const updates: Record<string, any> = {}
  if (newSlug !== undefined) updates.slug = newSlug
  if (displayName !== undefined) updates.displayName = displayName
  if (bio !== undefined) updates.bio = bio
  if (website !== undefined) updates.website = website
  if (location !== undefined) updates.location = location
  if (kfOrgId !== undefined) updates.kfOrgId = kfOrgId

  if (Object.keys(updates).length > 0) {
    await db.update(schema.accounts).set(updates).where(eq(schema.accounts.id, org.id))
  }

  return c.json({ ok: true, slug: newSlug ?? slug })
}

// Upload org avatar
export async function uploadOrgAvatar(c: Context<AuthEnv>) {
  const slug = c.req.param('slug')!

  const [org] = await db
    .select()
    .from(schema.accounts)
    .where(and(eq(schema.accounts.slug, slug), eq(schema.accounts.type, 'org')))
    .limit(1)

  if (!org) return c.json({ error: 'Organization not found', statusCode: 404 }, 404)

  const [membership] = await db
    .select()
    .from(schema.orgMemberships)
    .where(
      and(
        eq(schema.orgMemberships.orgId, org.id),
        eq(schema.orgMemberships.userId, c.get('accountId')!),
      ),
    )
    .limit(1)

  if (!membership || membership.role !== 'owner') {
    return c.json(
      { error: 'Must be an owner to update the organization avatar', statusCode: 403 },
      403,
    )
  }

  const body = await c.req.parseBody()
  const file = Object.values(body).find((v): v is File => v instanceof File)
  if (!file) {
    return c.json({ error: 'No file uploaded', statusCode: 400 }, 400)
  }

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
    .update(schema.accounts)
    .set({ avatarUrl: `${ASSETS_BASE_URL}/${key}` })
    .where(eq(schema.accounts.id, org.id))

  return c.json({ ok: true, avatarUrl: `${ASSETS_BASE_URL}/${key}` })
}

// --- Org Invitations ---

// Invite user to org
export async function createInvitation(c: Context<AuthEnv>) {
  const slug = c.req.param('slug')!
  const { email, role } = await c.req.json()

  const [org] = await db
    .select()
    .from(schema.accounts)
    .where(and(eq(schema.accounts.slug, slug), eq(schema.accounts.type, 'org')))
    .limit(1)

  if (!org) return c.json({ error: 'Organization not found', statusCode: 404 }, 404)

  const [callerMembership] = await db
    .select()
    .from(schema.orgMemberships)
    .where(
      and(
        eq(schema.orgMemberships.orgId, org.id),
        eq(schema.orgMemberships.userId, c.get('accountId')!),
      ),
    )
    .limit(1)

  if (!callerMembership || callerMembership.role === 'member') {
    return c.json({ error: 'Must be an owner or admin to invite members', statusCode: 403 }, 403)
  }

  // Check if there's already a pending invitation for this email
  const [existingInvite] = await db
    .select()
    .from(schema.orgInvitations)
    .where(and(eq(schema.orgInvitations.orgId, org.id), eq(schema.orgInvitations.email, email)))
    .limit(1)

  if (existingInvite && !existingInvite.acceptedAt) {
    return c.json(
      { error: 'An invitation is already pending for this email', statusCode: 409 },
      409,
    )
  }

  const token = uuidv4()
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days

  await db.insert(schema.orgInvitations).values({
    orgId: org.id,
    email,
    role,
    invitedBy: c.get('accountId')!,
    token,
    expiresAt,
  })

  // Send invitation email
  const origin = new URL(c.req.url).origin
  const inviteUrl = `${origin}/invitations/accept?token=${token}`
  await sendEmail({
    to: email,
    subject: `You've been invited to join ${org.displayName} on Underlay`,
    text: `You've been invited to join ${org.displayName} as a ${role}.\n\nAccept: ${inviteUrl}\n\nThis invitation expires in 7 days.`,
    html: `<p>You've been invited to join <strong>${org.displayName}</strong> as a ${role}.</p><p><a href="${inviteUrl}">Accept invitation</a></p><p>This invitation expires in 7 days.</p>`,
  })

  return c.json({ ok: true }, 201)
}

// List pending invitations for an org
export async function listInvitations(c: Context<AuthEnv>) {
  const slug = c.req.param('slug')!

  const [org] = await db
    .select()
    .from(schema.accounts)
    .where(and(eq(schema.accounts.slug, slug), eq(schema.accounts.type, 'org')))
    .limit(1)

  if (!org) return c.json({ error: 'Organization not found', statusCode: 404 }, 404)

  const [membership] = await db
    .select()
    .from(schema.orgMemberships)
    .where(
      and(
        eq(schema.orgMemberships.orgId, org.id),
        eq(schema.orgMemberships.userId, c.get('accountId')!),
      ),
    )
    .limit(1)

  if (!membership) return c.json({ error: 'Forbidden', statusCode: 403 }, 403)

  const invitations = await db
    .select({
      id: schema.orgInvitations.id,
      email: schema.orgInvitations.email,
      role: schema.orgInvitations.role,
      expiresAt: schema.orgInvitations.expiresAt,
      acceptedAt: schema.orgInvitations.acceptedAt,
      createdAt: schema.orgInvitations.createdAt,
    })
    .from(schema.orgInvitations)
    .where(eq(schema.orgInvitations.orgId, org.id))

  return c.json(invitations)
}

// Cancel an invitation
export async function deleteInvitation(c: Context<AuthEnv>) {
  const slug = c.req.param('slug')!
  const id = c.req.param('id')!

  const [org] = await db
    .select()
    .from(schema.accounts)
    .where(and(eq(schema.accounts.slug, slug), eq(schema.accounts.type, 'org')))
    .limit(1)

  if (!org) return c.json({ error: 'Organization not found', statusCode: 404 }, 404)

  const [membership] = await db
    .select()
    .from(schema.orgMemberships)
    .where(
      and(
        eq(schema.orgMemberships.orgId, org.id),
        eq(schema.orgMemberships.userId, c.get('accountId')!),
      ),
    )
    .limit(1)

  if (!membership || membership.role === 'member') {
    return c.json(
      { error: 'Must be an owner or admin to cancel invitations', statusCode: 403 },
      403,
    )
  }

  await db.delete(schema.orgInvitations).where(eq(schema.orgInvitations.id, id))
  return c.json({ ok: true })
}

// Accept an invitation (public, token-based)
export async function acceptInvitation(c: Context<AuthEnv>) {
  const { token } = await c.req.json()

  const [invitation] = await db
    .select()
    .from(schema.orgInvitations)
    .where(eq(schema.orgInvitations.token, token))
    .limit(1)

  if (!invitation) {
    return c.json({ error: 'Invitation not found', statusCode: 404 }, 404)
  }

  if (invitation.acceptedAt) {
    return c.json({ error: 'Invitation already accepted', statusCode: 409 }, 409)
  }

  if (new Date(invitation.expiresAt) < new Date()) {
    return c.json({ error: 'Invitation has expired', statusCode: 410 }, 410)
  }

  // Verify the logged-in user's email matches the invitation.
  // Email is fetched from KF Auth since we don't store it locally.
  const { getKfProfile } = await import('../lib/kf-profile-cache.server.js')
  const accountId = c.get('accountId')!

  // Fetch email from KF Auth internal API directly (profile cache doesn't include email)
  const KF_AUTH_URL = process.env.KF_AUTH_URL ?? 'http://localhost:3000'
  const KF_INTERNAL_API_KEY = process.env.KF_INTERNAL_API_KEY ?? ''
  let userEmail: string | null = null
  try {
    const res = await fetch(`${KF_AUTH_URL}/api/internal/users/${accountId}`, {
      headers: { Authorization: `Bearer ${KF_INTERNAL_API_KEY}` },
    })
    if (res.ok) {
      const data = (await res.json()) as { email: string }
      userEmail = data.email
    }
  } catch {}

  if (!userEmail || userEmail !== invitation.email) {
    return c.json(
      { error: 'This invitation was sent to a different email address', statusCode: 403 },
      403,
    )
  }

  // Add to org
  await db.insert(schema.orgMemberships).values({
    orgId: invitation.orgId,
    userId: c.get('accountId')!,
    role: invitation.role as 'owner' | 'admin' | 'member',
  })

  // Mark invitation as accepted
  await db
    .update(schema.orgInvitations)
    .set({ acceptedAt: new Date() })
    .where(eq(schema.orgInvitations.id, invitation.id))

  // Get org slug for redirect
  const [org] = await db
    .select({ slug: schema.accounts.slug })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, invitation.orgId))
    .limit(1)

  return c.json({ ok: true, orgSlug: org?.slug ?? '' })
}

// Delete org
export async function deleteOrg(c: Context<AuthEnv>) {
  const slug = c.req.param('slug')!

  const [org] = await db
    .select()
    .from(schema.accounts)
    .where(and(eq(schema.accounts.slug, slug), eq(schema.accounts.type, 'org')))
    .limit(1)

  if (!org) return c.json({ error: 'Organization not found', statusCode: 404 }, 404)

  // Must be owner
  const [callerMembership] = await db
    .select()
    .from(schema.orgMemberships)
    .where(
      and(
        eq(schema.orgMemberships.orgId, org.id),
        eq(schema.orgMemberships.userId, c.get('accountId')!),
      ),
    )
    .limit(1)

  if (!callerMembership || callerMembership.role !== 'owner') {
    return c.json({ error: 'Must be an owner to delete the organization', statusCode: 403 }, 403)
  }

  // Cascade will handle memberships, collections, etc.
  await db.delete(schema.accounts).where(eq(schema.accounts.id, org.id))
  return c.json({ ok: true })
}
