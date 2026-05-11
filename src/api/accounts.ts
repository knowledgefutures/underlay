import bcrypt from 'bcrypt'
import { and, count, eq, } from 'drizzle-orm'
import type { Context, } from 'hono'
import { getCookie, } from 'hono/cookie'
import { v4 as uuidv4, } from 'uuid'
import { db, schema, } from '../db/client.server.js'
import { sendEmail, } from '../lib/email.js'
import { deleteS3Objects, listS3Objects, uploadToS3, } from '../lib/s3.js'
import { type AuthEnv, clearSessionCookie, setSessionCookie, } from './auth.server.js'

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
],)

// Signup
export async function signup(c: Context<AuthEnv>,) {
  const { email, password, username, displayName, } = await c.req.json()

  if (RESERVED_SLUGS.has(username.toLowerCase(),)) {
    return c.json({ error: 'That username is reserved', statusCode: 422, }, 422,)
  }

  const existing = await db
    .select()
    .from(schema.accounts,)
    .where(eq(schema.accounts.slug, username,),)
    .limit(1,)

  if (existing.length > 0) {
    return c.json({ error: 'Username already taken', statusCode: 409, }, 409,)
  }

  const passwordHash = await bcrypt.hash(password, 10,)
  const id = uuidv4()

  await db.insert(schema.accounts,).values({
    id,
    slug: username,
    type: 'user',
    displayName,
    email,
    passwordHash,
  },)

  const sessionId = uuidv4()
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000,) // 30 days
  await db.insert(schema.sessions,).values({
    id: sessionId,
    userId: id,
    expiresAt,
    userAgent: c.req.header('user-agent',) ?? null,
    ipAddress: c.req.header('x-forwarded-for',) || 'unknown',
  },)

  setSessionCookie(c, sessionId,)

  return c.json({ id, slug: username, displayName, }, 201,)
}

// Login
export async function login(c: Context<AuthEnv>,) {
  const { email, password, } = await c.req.json()

  const [account,] = await db
    .select()
    .from(schema.accounts,)
    .where(eq(schema.accounts.email, email,),)
    .limit(1,)

  if (!account?.passwordHash) {
    return c.json({ error: 'Invalid credentials', statusCode: 401, }, 401,)
  }

  const valid = await bcrypt.compare(password, account.passwordHash,)
  if (!valid) {
    return c.json({ error: 'Invalid credentials', statusCode: 401, }, 401,)
  }

  const sessionId = uuidv4()
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000,)
  await db.insert(schema.sessions,).values({
    id: sessionId,
    userId: account.id,
    expiresAt,
    userAgent: c.req.header('user-agent',) ?? null,
    ipAddress: c.req.header('x-forwarded-for',) || 'unknown',
  },)

  setSessionCookie(c, sessionId,)

  return c.json({ id: account.id, slug: account.slug, displayName: account.displayName, },)
}

// Logout
export async function logout(c: Context<AuthEnv>,) {
  const sessionId = getCookie(c, 'session',)
  if (sessionId) {
    await db.delete(schema.sessions,).where(eq(schema.sessions.id, sessionId,),)
  }
  clearSessionCookie(c,)
  return c.json({ ok: true, },)
}

// Get current user
export async function getMe(c: Context<AuthEnv>,) {
  const [account,] = await db
    .select({
      id: schema.accounts.id,
      slug: schema.accounts.slug,
      type: schema.accounts.type,
      displayName: schema.accounts.displayName,
      email: schema.accounts.email,
      bio: schema.accounts.bio,
      website: schema.accounts.website,
      location: schema.accounts.location,
      avatarUrl: schema.accounts.avatarUrl,
      emailVerified: schema.accounts.emailVerified,
      notificationPrefs: schema.accounts.notificationPrefs,
      createdAt: schema.accounts.createdAt,
    },)
    .from(schema.accounts,)
    .where(eq(schema.accounts.id, c.get('accountId',)!,),)
    .limit(1,)

  if (!account) {
    return c.json({ error: 'Account not found', statusCode: 404, }, 404,)
  }

  // Fetch org memberships
  const memberships = await db
    .select({
      orgId: schema.orgMemberships.orgId,
      role: schema.orgMemberships.role,
      slug: schema.accounts.slug,
      displayName: schema.accounts.displayName,
    },)
    .from(schema.orgMemberships,)
    .innerJoin(schema.accounts, eq(schema.orgMemberships.orgId, schema.accounts.id,),)
    .where(eq(schema.orgMemberships.userId, account.id,),)

  return c.json({ ...account, orgs: memberships, },)
}

// Get account by slug (public)
export async function getBySlug(c: Context<AuthEnv>,) {
  const slug = c.req.param('slug',)!
  const [account,] = await db
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
      createdAt: schema.accounts.createdAt,
    },)
    .from(schema.accounts,)
    .where(eq(schema.accounts.slug, slug,),)
    .limit(1,)

  if (!account) {
    return c.json({ error: 'Account not found', statusCode: 404, }, 404,)
  }

  // Include ARK shoulder if minted
  const [shoulderRow,] = await db
    .select({ shoulder: schema.arkShoulders.shoulder, },)
    .from(schema.arkShoulders,)
    .where(eq(schema.arkShoulders.accountId, account.id,),)
    .limit(1,)

  return c.json({ ...account, arkShoulder: shoulderRow?.shoulder ?? null, },)
}

// Update own profile
export async function updateMe(c: Context<AuthEnv>,) {
  const { displayName, bio, website, location, notificationPrefs, } = await c.req.json()

  const updates: Record<string, any> = {}
  if (displayName !== undefined) updates.displayName = displayName
  if (bio !== undefined) updates.bio = bio
  if (website !== undefined) updates.website = website
  if (location !== undefined) updates.location = location
  if (notificationPrefs !== undefined) updates.notificationPrefs = notificationPrefs

  if (Object.keys(updates,).length > 0) {
    await db.update(schema.accounts,).set(updates,).where(eq(schema.accounts.id, c.get('accountId',)!,),)
  }

  return c.json({ ok: true, },)
}

// Change email (requires current password)
export async function updateEmail(c: Context<AuthEnv>,) {
  const { newEmail, password, } = await c.req.json()

  const [account,] = await db
    .select()
    .from(schema.accounts,)
    .where(eq(schema.accounts.id, c.get('accountId',)!,),)
    .limit(1,)

  if (!account?.passwordHash) {
    return c.json({ error: 'Cannot change email for this account type', statusCode: 400, }, 400,)
  }

  const valid = await bcrypt.compare(password, account.passwordHash,)
  if (!valid) {
    return c.json({ error: 'Invalid password', statusCode: 401, }, 401,)
  }

  // Check email not taken
  const [existing,] = await db
    .select()
    .from(schema.accounts,)
    .where(eq(schema.accounts.email, newEmail,),)
    .limit(1,)

  if (existing && existing.id !== account.id) {
    return c.json({ error: 'Email already in use', statusCode: 409, }, 409,)
  }

  await db
    .update(schema.accounts,)
    .set({ email: newEmail, emailVerified: false, },)
    .where(eq(schema.accounts.id, c.get('accountId',)!,),)

  return c.json({ ok: true, },)
}

// Change password
export async function updatePassword(c: Context<AuthEnv>,) {
  const { currentPassword, newPassword, } = await c.req.json()

  if (newPassword.length < 8) {
    return c.json({ error: 'Password must be at least 8 characters', statusCode: 422, }, 422,)
  }

  const [account,] = await db
    .select()
    .from(schema.accounts,)
    .where(eq(schema.accounts.id, c.get('accountId',)!,),)
    .limit(1,)

  if (!account?.passwordHash) {
    return c.json({ error: 'Cannot change password for this account type', statusCode: 400, }, 400,)
  }

  const valid = await bcrypt.compare(currentPassword, account.passwordHash,)
  if (!valid) {
    return c.json({ error: 'Current password is incorrect', statusCode: 401, }, 401,)
  }

  const newHash = await bcrypt.hash(newPassword, 10,)
  await db
    .update(schema.accounts,)
    .set({ passwordHash: newHash, },)
    .where(eq(schema.accounts.id, c.get('accountId',)!,),)

  return c.json({ ok: true, },)
}

// Upload avatar
export async function uploadAvatar(c: Context<AuthEnv>,) {
  const body = await c.req.parseBody()
  const file = Object.values(body,).find((v,): v is File => v instanceof File)
  if (!file) {
    return c.json({ error: 'No file uploaded', statusCode: 400, }, 400,)
  }

  const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp',]
  if (!allowedTypes.includes(file.type,)) {
    return c.json({ error: 'Only JPEG, PNG, GIF, and WebP images are allowed', statusCode: 422, }, 422,)
  }

  const buffer = Buffer.from(await file.arrayBuffer(),)
  if (buffer.length > 5 * 1024 * 1024) {
    return c.json({ error: 'Image must be less than 5MB', statusCode: 422, }, 422,)
  }

  const ext = file.type.split('/',)[1] === 'jpeg' ? 'jpg' : file.type.split('/',)[1]
  const accountId = c.get('accountId',)!
  const key = `avatars/${accountId}/${Date.now()}.${ext}`

  await uploadToS3(key, buffer, file.type,)

  await db
    .update(schema.accounts,)
    .set({ avatarUrl: `${ASSETS_BASE_URL}/${key}`, },)
    .where(eq(schema.accounts.id, accountId,),)

  return c.json({ ok: true, avatarUrl: `${ASSETS_BASE_URL}/${key}`, },)
}

// List sessions
export async function listSessions(c: Context<AuthEnv>,) {
  const sessions = await db
    .select({
      id: schema.sessions.id,
      userAgent: schema.sessions.userAgent,
      ipAddress: schema.sessions.ipAddress,
      createdAt: schema.sessions.createdAt,
      expiresAt: schema.sessions.expiresAt,
    },)
    .from(schema.sessions,)
    .where(eq(schema.sessions.userId, c.get('accountId',)!,),)

  // Get current session ID to mark it
  const currentSessionId = getCookie(c, 'session',)
  return c.json(sessions.map((s,) => ({
    ...s,
    current: s.id === currentSessionId,
  })),)
}

// Revoke a session
export async function deleteSession(c: Context<AuthEnv>,) {
  const sessionId = c.req.param('sessionId',)!

  const [session,] = await db
    .select()
    .from(schema.sessions,)
    .where(and(eq(schema.sessions.id, sessionId,), eq(schema.sessions.userId, c.get('accountId',)!,),),)
    .limit(1,)

  if (!session) {
    return c.json({ error: 'Session not found', statusCode: 404, }, 404,)
  }

  await db.delete(schema.sessions,).where(eq(schema.sessions.id, sessionId,),)
  return c.json({ ok: true, },)
}

// Delete own account
export async function deleteMe(c: Context<AuthEnv>,) {
  const { password, confirmSlug, } = await c.req.json()

  const [account,] = await db
    .select()
    .from(schema.accounts,)
    .where(eq(schema.accounts.id, c.get('accountId',)!,),)
    .limit(1,)

  if (!account?.passwordHash) {
    return c.json({ error: 'Cannot delete this account type', statusCode: 400, }, 400,)
  }

  if (confirmSlug !== account.slug) {
    return c.json({ error: 'Username confirmation does not match', statusCode: 422, }, 422,)
  }

  const valid = await bcrypt.compare(password, account.passwordHash,)
  if (!valid) {
    return c.json({ error: 'Invalid password', statusCode: 401, }, 401,)
  }

  // Check for owned collections
  const [collCount,] = await db
    .select({ count: count(), },)
    .from(schema.collections,)
    .where(eq(schema.collections.accountId, account.id,),)

  if (collCount && collCount.count > 0) {
    return c.json({
      error: `You still own ${collCount.count} collection(s). Transfer or delete them before deleting your account.`,
      statusCode: 422,
    }, 422,)
  }

  // Clean up S3 avatars
  try {
    const avatarKeys = await listS3Objects(`avatars/${account.id}/`,)
    if (avatarKeys.length > 0) {
      await deleteS3Objects(avatarKeys,)
    }
  } catch {
    // Non-fatal: avatar cleanup failed
  }

  // Cascade will handle sessions, memberships, api keys
  await db.delete(schema.accounts,).where(eq(schema.accounts.id, account.id,),)
  clearSessionCookie(c,)
  return c.json({ ok: true, },)
}

// --- Forgot Password ---
export async function forgotPassword(c: Context<AuthEnv>,) {
  const { email, } = await c.req.json()

  const [account,] = await db
    .select()
    .from(schema.accounts,)
    .where(eq(schema.accounts.email, email,),)
    .limit(1,)

  // Always return success to prevent email enumeration
  if (!account) {
    return c.json({ ok: true, },)
  }

  const rawToken = uuidv4()
  const tokenHash = await bcrypt.hash(rawToken, 10,)
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000,) // 1 hour

  await db.insert(schema.passwordResetTokens,).values({
    userId: account.id,
    tokenHash,
    expiresAt,
  },)

  // Send email (no-op if SMTP not configured)
  const origin = new URL(c.req.url,).origin
  const resetUrl = `${origin}/reset-password?token=${rawToken}&email=${encodeURIComponent(email,)}`
  await sendEmail({
    to: email,
    subject: 'Reset your Underlay password',
    text:
      `Click here to reset your password: ${resetUrl}\n\nThis link expires in 1 hour. If you didn't request this, ignore this email.`,
    html:
      `<p>Click <a href="${resetUrl}">here</a> to reset your password.</p><p>This link expires in 1 hour. If you didn't request this, ignore this email.</p>`,
  },)

  return c.json({ ok: true, },)
}

// --- Reset Password ---
export async function resetPassword(c: Context<AuthEnv>,) {
  const { email, token, newPassword, } = await c.req.json()

  if (newPassword.length < 8) {
    return c.json({ error: 'Password must be at least 8 characters', statusCode: 422, }, 422,)
  }

  const [account,] = await db
    .select()
    .from(schema.accounts,)
    .where(eq(schema.accounts.email, email,),)
    .limit(1,)

  if (!account) {
    return c.json({ error: 'Invalid or expired reset link', statusCode: 400, }, 400,)
  }

  // Find valid unused tokens for this user
  const tokens = await db
    .select()
    .from(schema.passwordResetTokens,)
    .where(and(
      eq(schema.passwordResetTokens.userId, account.id,),
    ),)

  let validToken = null
  for (const t of tokens) {
    if (t.usedAt) continue
    if (new Date(t.expiresAt,) < new Date()) continue
    const match = await bcrypt.compare(token, t.tokenHash,)
    if (match) {
      validToken = t
      break
    }
  }

  if (!validToken) {
    return c.json({ error: 'Invalid or expired reset link', statusCode: 400, }, 400,)
  }

  const newHash = await bcrypt.hash(newPassword, 10,)
  await db.update(schema.accounts,).set({ passwordHash: newHash, },).where(eq(schema.accounts.id, account.id,),)
  await db
    .update(schema.passwordResetTokens,)
    .set({ usedAt: new Date(), },)
    .where(eq(schema.passwordResetTokens.id, validToken.id,),)

  return c.json({ ok: true, },)
}

// Create API key
export async function createKey(c: Context<AuthEnv>,) {
  const { label, scope, collectionId, expiresIn, } = await c.req.json()

  const rawKey = `ul_${uuidv4().replace(/-/g, '',)}`
  const keyHash = await bcrypt.hash(rawKey, 10,)
  const keyPrefix = rawKey.slice(0, 12,)

  const expiresAt = expiresIn
    ? new Date(Date.now() + expiresIn * 24 * 60 * 60 * 1000,)
    : null

  const [key,] = await db
    .insert(schema.apiKeys,)
    .values({
      accountId: c.get('accountId',)!,
      scope,
      keyHash,
      keyPrefix,
      label,
      collectionId: collectionId ?? null,
      expiresAt,
    },)
    .returning()

  return c.json({
    id: key!.id,
    key: rawKey, // shown once
    label,
    scope,
    keyPrefix,
    collectionId: collectionId ?? null,
    expiresAt,
  }, 201,)
}

// List API keys
export async function listKeys(c: Context<AuthEnv>,) {
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
    },)
    .from(schema.apiKeys,)
    .where(eq(schema.apiKeys.accountId, c.get('accountId',)!,),)
  return c.json(keys,)
}

// Delete API key
export async function deleteKey(c: Context<AuthEnv>,) {
  const id = c.req.param('id',)!
  const [key,] = await db
    .select()
    .from(schema.apiKeys,)
    .where(eq(schema.apiKeys.id, id,),)
    .limit(1,)

  if (!key || key.accountId !== c.get('accountId',)) {
    return c.json({ error: 'Key not found', statusCode: 404, }, 404,)
  }

  await db.delete(schema.apiKeys,).where(eq(schema.apiKeys.id, id,),)
  return c.json({ ok: true, },)
}

// --- Org-scoped API Keys ---

// Create API key for an org
export async function createOrgKey(c: Context<AuthEnv>,) {
  const slug = c.req.param('slug',)!
  const { label, scope, collectionId, expiresIn, } = await c.req.json()

  const [org,] = await db
    .select()
    .from(schema.accounts,)
    .where(and(eq(schema.accounts.slug, slug,), eq(schema.accounts.type, 'org',),),)
    .limit(1,)

  if (!org) return c.json({ error: 'Organization not found', statusCode: 404, }, 404,)

  // Must be owner or admin
  const [membership,] = await db
    .select()
    .from(schema.orgMemberships,)
    .where(and(eq(schema.orgMemberships.orgId, org.id,), eq(schema.orgMemberships.userId, c.get('accountId',)!,),),)
    .limit(1,)

  if (!membership || membership.role === 'member') {
    return c.json({ error: 'Must be an owner or admin to manage org API keys', statusCode: 403, }, 403,)
  }

  const rawKey = `ul_${uuidv4().replace(/-/g, '',)}`
  const keyHash = await bcrypt.hash(rawKey, 10,)
  const keyPrefix = rawKey.slice(0, 12,)

  const expiresAt = expiresIn
    ? new Date(Date.now() + expiresIn * 24 * 60 * 60 * 1000,)
    : null

  const [key,] = await db
    .insert(schema.apiKeys,)
    .values({
      accountId: org.id,
      scope,
      keyHash,
      keyPrefix,
      label,
      collectionId: collectionId ?? null,
      expiresAt,
    },)
    .returning()

  return c.json({
    id: key!.id,
    key: rawKey,
    label,
    scope,
    keyPrefix,
    collectionId: collectionId ?? null,
    expiresAt,
  }, 201,)
}

// List org API keys
export async function listOrgKeys(c: Context<AuthEnv>,) {
  const slug = c.req.param('slug',)!

  const [org,] = await db
    .select()
    .from(schema.accounts,)
    .where(and(eq(schema.accounts.slug, slug,), eq(schema.accounts.type, 'org',),),)
    .limit(1,)

  if (!org) return c.json({ error: 'Organization not found', statusCode: 404, }, 404,)

  // Must be a member
  const [membership,] = await db
    .select()
    .from(schema.orgMemberships,)
    .where(and(eq(schema.orgMemberships.orgId, org.id,), eq(schema.orgMemberships.userId, c.get('accountId',)!,),),)
    .limit(1,)

  if (!membership) return c.json({ error: 'Forbidden', statusCode: 403, }, 403,)

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
    },)
    .from(schema.apiKeys,)
    .where(eq(schema.apiKeys.accountId, org.id,),)

  return c.json(keys,)
}

// Delete org API key
export async function deleteOrgKey(c: Context<AuthEnv>,) {
  const slug = c.req.param('slug',)!
  const id = c.req.param('id',)!

  const [org,] = await db
    .select()
    .from(schema.accounts,)
    .where(and(eq(schema.accounts.slug, slug,), eq(schema.accounts.type, 'org',),),)
    .limit(1,)

  if (!org) return c.json({ error: 'Organization not found', statusCode: 404, }, 404,)

  const [membership,] = await db
    .select()
    .from(schema.orgMemberships,)
    .where(and(eq(schema.orgMemberships.orgId, org.id,), eq(schema.orgMemberships.userId, c.get('accountId',)!,),),)
    .limit(1,)

  if (!membership || membership.role === 'member') {
    return c.json({ error: 'Must be an owner or admin to manage org API keys', statusCode: 403, }, 403,)
  }

  const [key,] = await db
    .select()
    .from(schema.apiKeys,)
    .where(and(eq(schema.apiKeys.id, id,), eq(schema.apiKeys.accountId, org.id,),),)
    .limit(1,)

  if (!key) return c.json({ error: 'Key not found', statusCode: 404, }, 404,)

  await db.delete(schema.apiKeys,).where(eq(schema.apiKeys.id, id,),)
  return c.json({ ok: true, },)
}

// --- Org Management ---

// Create organization
export async function createOrg(c: Context<AuthEnv>,) {
  const { slug, displayName, } = await c.req.json()

  if (RESERVED_SLUGS.has(slug.toLowerCase(),)) {
    return c.json({ error: 'That name is reserved', statusCode: 422, }, 422,)
  }

  if (!/^[a-z0-9][a-z0-9\-]*[a-z0-9]$/.test(slug,) || slug.length < 2) {
    return c.json({
      error: 'Slug must be lowercase alphanumeric with hyphens, at least 2 characters',
      statusCode: 422,
    }, 422,)
  }

  const existing = await db
    .select()
    .from(schema.accounts,)
    .where(eq(schema.accounts.slug, slug,),)
    .limit(1,)

  if (existing.length > 0) {
    return c.json({ error: 'Name already taken', statusCode: 409, }, 409,)
  }

  const id = uuidv4()
  await db.insert(schema.accounts,).values({
    id,
    slug,
    type: 'org',
    displayName,
  },)

  // Add the creating user as owner
  await db.insert(schema.orgMemberships,).values({
    orgId: id,
    userId: c.get('accountId',)!,
    role: 'owner',
  },)

  return c.json({ id, slug, displayName, type: 'org', }, 201,)
}

// List org members
export async function listMembers(c: Context<AuthEnv>,) {
  const slug = c.req.param('slug',)!

  const [org,] = await db
    .select()
    .from(schema.accounts,)
    .where(and(eq(schema.accounts.slug, slug,), eq(schema.accounts.type, 'org',),),)
    .limit(1,)

  if (!org) return c.json({ error: 'Organization not found', statusCode: 404, }, 404,)

  // Must be a member to view
  const [membership,] = await db
    .select()
    .from(schema.orgMemberships,)
    .where(and(eq(schema.orgMemberships.orgId, org.id,), eq(schema.orgMemberships.userId, c.get('accountId',)!,),),)
    .limit(1,)

  if (!membership) return c.json({ error: 'Forbidden', statusCode: 403, }, 403,)

  const members = await db
    .select({
      userId: schema.orgMemberships.userId,
      role: schema.orgMemberships.role,
      slug: schema.accounts.slug,
      displayName: schema.accounts.displayName,
    },)
    .from(schema.orgMemberships,)
    .innerJoin(schema.accounts, eq(schema.orgMemberships.userId, schema.accounts.id,),)
    .where(eq(schema.orgMemberships.orgId, org.id,),)

  return c.json(members,)
}

// Add org member
export async function addMember(c: Context<AuthEnv>,) {
  const slug = c.req.param('slug',)!
  const { username, role, } = await c.req.json()

  const [org,] = await db
    .select()
    .from(schema.accounts,)
    .where(and(eq(schema.accounts.slug, slug,), eq(schema.accounts.type, 'org',),),)
    .limit(1,)

  if (!org) return c.json({ error: 'Organization not found', statusCode: 404, }, 404,)

  // Must be owner or admin
  const [callerMembership,] = await db
    .select()
    .from(schema.orgMemberships,)
    .where(and(eq(schema.orgMemberships.orgId, org.id,), eq(schema.orgMemberships.userId, c.get('accountId',)!,),),)
    .limit(1,)

  if (!callerMembership || callerMembership.role === 'member') {
    return c.json({ error: 'Must be an owner or admin to add members', statusCode: 403, }, 403,)
  }

  // Find user to add
  const [user,] = await db
    .select()
    .from(schema.accounts,)
    .where(and(eq(schema.accounts.slug, username,), eq(schema.accounts.type, 'user',),),)
    .limit(1,)

  if (!user) return c.json({ error: 'User not found', statusCode: 404, }, 404,)

  // Check not already a member
  const [existing,] = await db
    .select()
    .from(schema.orgMemberships,)
    .where(and(eq(schema.orgMemberships.orgId, org.id,), eq(schema.orgMemberships.userId, user.id,),),)
    .limit(1,)

  if (existing) return c.json({ error: 'Already a member', statusCode: 409, }, 409,)

  await db.insert(schema.orgMemberships,).values({
    orgId: org.id,
    userId: user.id,
    role: role ?? 'member',
  },)

  return c.json({ ok: true, username, role, }, 201,)
}

// Update member role
export async function updateMember(c: Context<AuthEnv>,) {
  const slug = c.req.param('slug',)!
  const userId = c.req.param('userId',)!
  const { role, } = await c.req.json()

  const [org,] = await db
    .select()
    .from(schema.accounts,)
    .where(and(eq(schema.accounts.slug, slug,), eq(schema.accounts.type, 'org',),),)
    .limit(1,)

  if (!org) return c.json({ error: 'Organization not found', statusCode: 404, }, 404,)

  // Must be owner
  const [callerMembership,] = await db
    .select()
    .from(schema.orgMemberships,)
    .where(and(eq(schema.orgMemberships.orgId, org.id,), eq(schema.orgMemberships.userId, c.get('accountId',)!,),),)
    .limit(1,)

  if (!callerMembership || callerMembership.role !== 'owner') {
    return c.json({ error: 'Must be an owner to change roles', statusCode: 403, }, 403,)
  }

  await db
    .update(schema.orgMemberships,)
    .set({ role, },)
    .where(and(eq(schema.orgMemberships.orgId, org.id,), eq(schema.orgMemberships.userId, userId,),),)

  return c.json({ ok: true, },)
}

// Remove member
export async function removeMember(c: Context<AuthEnv>,) {
  const slug = c.req.param('slug',)!
  const userId = c.req.param('userId',)!

  const [org,] = await db
    .select()
    .from(schema.accounts,)
    .where(and(eq(schema.accounts.slug, slug,), eq(schema.accounts.type, 'org',),),)
    .limit(1,)

  if (!org) return c.json({ error: 'Organization not found', statusCode: 404, }, 404,)

  // Must be owner or admin (or removing yourself)
  const [callerMembership,] = await db
    .select()
    .from(schema.orgMemberships,)
    .where(and(eq(schema.orgMemberships.orgId, org.id,), eq(schema.orgMemberships.userId, c.get('accountId',)!,),),)
    .limit(1,)

  const isSelf = c.get('accountId',) === userId
  if (!callerMembership || (callerMembership.role === 'member' && !isSelf)) {
    return c.json({ error: 'Forbidden', statusCode: 403, }, 403,)
  }

  await db
    .delete(schema.orgMemberships,)
    .where(and(eq(schema.orgMemberships.orgId, org.id,), eq(schema.orgMemberships.userId, userId,),),)

  return c.json({ ok: true, },)
}

// Update org profile
export async function updateOrg(c: Context<AuthEnv>,) {
  const slug = c.req.param('slug',)!
  const { displayName, bio, website, location, } = await c.req.json()

  const [org,] = await db
    .select()
    .from(schema.accounts,)
    .where(and(eq(schema.accounts.slug, slug,), eq(schema.accounts.type, 'org',),),)
    .limit(1,)

  if (!org) return c.json({ error: 'Organization not found', statusCode: 404, }, 404,)

  // Must be owner
  const [callerMembership,] = await db
    .select()
    .from(schema.orgMemberships,)
    .where(and(eq(schema.orgMemberships.orgId, org.id,), eq(schema.orgMemberships.userId, c.get('accountId',)!,),),)
    .limit(1,)

  if (!callerMembership || callerMembership.role !== 'owner') {
    return c.json({ error: 'Must be an owner to update the organization', statusCode: 403, }, 403,)
  }

  const updates: Record<string, any> = {}
  if (displayName !== undefined) updates.displayName = displayName
  if (bio !== undefined) updates.bio = bio
  if (website !== undefined) updates.website = website
  if (location !== undefined) updates.location = location

  if (Object.keys(updates,).length > 0) {
    await db.update(schema.accounts,).set(updates,).where(eq(schema.accounts.id, org.id,),)
  }

  return c.json({ ok: true, },)
}

// Upload org avatar
export async function uploadOrgAvatar(c: Context<AuthEnv>,) {
  const slug = c.req.param('slug',)!

  const [org,] = await db
    .select()
    .from(schema.accounts,)
    .where(and(eq(schema.accounts.slug, slug,), eq(schema.accounts.type, 'org',),),)
    .limit(1,)

  if (!org) return c.json({ error: 'Organization not found', statusCode: 404, }, 404,)

  const [membership,] = await db
    .select()
    .from(schema.orgMemberships,)
    .where(and(eq(schema.orgMemberships.orgId, org.id,), eq(schema.orgMemberships.userId, c.get('accountId',)!,),),)
    .limit(1,)

  if (!membership || membership.role !== 'owner') {
    return c.json({ error: 'Must be an owner to update the organization avatar', statusCode: 403, }, 403,)
  }

  const body = await c.req.parseBody()
  const file = Object.values(body,).find((v,): v is File => v instanceof File)
  if (!file) {
    return c.json({ error: 'No file uploaded', statusCode: 400, }, 400,)
  }

  const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp',]
  if (!allowedTypes.includes(file.type,)) {
    return c.json({ error: 'Only JPEG, PNG, GIF, and WebP images are allowed', statusCode: 422, }, 422,)
  }

  const buffer = Buffer.from(await file.arrayBuffer(),)
  if (buffer.length > 5 * 1024 * 1024) {
    return c.json({ error: 'Image must be less than 5MB', statusCode: 422, }, 422,)
  }

  const ext = file.type.split('/',)[1] === 'jpeg' ? 'jpg' : file.type.split('/',)[1]
  const key = `avatars/${org.id}/${Date.now()}.${ext}`

  await uploadToS3(key, buffer, file.type,)

  await db.update(schema.accounts,).set({ avatarUrl: `${ASSETS_BASE_URL}/${key}`, },).where(
    eq(schema.accounts.id, org.id,),
  )

  return c.json({ ok: true, avatarUrl: `${ASSETS_BASE_URL}/${key}`, },)
}

// --- Org Invitations ---

// Invite user to org
export async function createInvitation(c: Context<AuthEnv>,) {
  const slug = c.req.param('slug',)!
  const { email, role, } = await c.req.json()

  const [org,] = await db
    .select()
    .from(schema.accounts,)
    .where(and(eq(schema.accounts.slug, slug,), eq(schema.accounts.type, 'org',),),)
    .limit(1,)

  if (!org) return c.json({ error: 'Organization not found', statusCode: 404, }, 404,)

  const [callerMembership,] = await db
    .select()
    .from(schema.orgMemberships,)
    .where(and(eq(schema.orgMemberships.orgId, org.id,), eq(schema.orgMemberships.userId, c.get('accountId',)!,),),)
    .limit(1,)

  if (!callerMembership || callerMembership.role === 'member') {
    return c.json({ error: 'Must be an owner or admin to invite members', statusCode: 403, }, 403,)
  }

  // Check if already a member (by email)
  const [existingUser,] = await db
    .select()
    .from(schema.accounts,)
    .where(eq(schema.accounts.email, email,),)
    .limit(1,)

  if (existingUser) {
    const [existingMembership,] = await db
      .select()
      .from(schema.orgMemberships,)
      .where(and(eq(schema.orgMemberships.orgId, org.id,), eq(schema.orgMemberships.userId, existingUser.id,),),)
      .limit(1,)

    if (existingMembership) {
      return c.json({ error: 'User is already a member', statusCode: 409, }, 409,)
    }
  }

  const token = uuidv4()
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000,) // 7 days

  await db.insert(schema.orgInvitations,).values({
    orgId: org.id,
    email,
    role,
    invitedBy: c.get('accountId',)!,
    token,
    expiresAt,
  },)

  // Send invitation email
  const origin = new URL(c.req.url,).origin
  const inviteUrl = `${origin}/invitations/accept?token=${token}`
  await sendEmail({
    to: email,
    subject: `You've been invited to join ${org.displayName} on Underlay`,
    text:
      `You've been invited to join ${org.displayName} as a ${role}.\n\nAccept: ${inviteUrl}\n\nThis invitation expires in 7 days.`,
    html:
      `<p>You've been invited to join <strong>${org.displayName}</strong> as a ${role}.</p><p><a href="${inviteUrl}">Accept invitation</a></p><p>This invitation expires in 7 days.</p>`,
  },)

  return c.json({ ok: true, }, 201,)
}

// List pending invitations for an org
export async function listInvitations(c: Context<AuthEnv>,) {
  const slug = c.req.param('slug',)!

  const [org,] = await db
    .select()
    .from(schema.accounts,)
    .where(and(eq(schema.accounts.slug, slug,), eq(schema.accounts.type, 'org',),),)
    .limit(1,)

  if (!org) return c.json({ error: 'Organization not found', statusCode: 404, }, 404,)

  const [membership,] = await db
    .select()
    .from(schema.orgMemberships,)
    .where(and(eq(schema.orgMemberships.orgId, org.id,), eq(schema.orgMemberships.userId, c.get('accountId',)!,),),)
    .limit(1,)

  if (!membership) return c.json({ error: 'Forbidden', statusCode: 403, }, 403,)

  const invitations = await db
    .select({
      id: schema.orgInvitations.id,
      email: schema.orgInvitations.email,
      role: schema.orgInvitations.role,
      expiresAt: schema.orgInvitations.expiresAt,
      acceptedAt: schema.orgInvitations.acceptedAt,
      createdAt: schema.orgInvitations.createdAt,
    },)
    .from(schema.orgInvitations,)
    .where(eq(schema.orgInvitations.orgId, org.id,),)

  return c.json(invitations,)
}

// Cancel an invitation
export async function deleteInvitation(c: Context<AuthEnv>,) {
  const slug = c.req.param('slug',)!
  const id = c.req.param('id',)!

  const [org,] = await db
    .select()
    .from(schema.accounts,)
    .where(and(eq(schema.accounts.slug, slug,), eq(schema.accounts.type, 'org',),),)
    .limit(1,)

  if (!org) return c.json({ error: 'Organization not found', statusCode: 404, }, 404,)

  const [membership,] = await db
    .select()
    .from(schema.orgMemberships,)
    .where(and(eq(schema.orgMemberships.orgId, org.id,), eq(schema.orgMemberships.userId, c.get('accountId',)!,),),)
    .limit(1,)

  if (!membership || membership.role === 'member') {
    return c.json({ error: 'Must be an owner or admin to cancel invitations', statusCode: 403, }, 403,)
  }

  await db.delete(schema.orgInvitations,).where(eq(schema.orgInvitations.id, id,),)
  return c.json({ ok: true, },)
}

// Accept an invitation (public, token-based)
export async function acceptInvitation(c: Context<AuthEnv>,) {
  const { token, } = await c.req.json()

  const [invitation,] = await db
    .select()
    .from(schema.orgInvitations,)
    .where(eq(schema.orgInvitations.token, token,),)
    .limit(1,)

  if (!invitation) {
    return c.json({ error: 'Invitation not found', statusCode: 404, }, 404,)
  }

  if (invitation.acceptedAt) {
    return c.json({ error: 'Invitation already accepted', statusCode: 409, }, 409,)
  }

  if (new Date(invitation.expiresAt,) < new Date()) {
    return c.json({ error: 'Invitation has expired', statusCode: 410, }, 410,)
  }

  // Verify the logged-in user's email matches the invitation
  const [account,] = await db
    .select()
    .from(schema.accounts,)
    .where(eq(schema.accounts.id, c.get('accountId',)!,),)
    .limit(1,)

  if (!account || account.email !== invitation.email) {
    return c.json({ error: 'This invitation was sent to a different email address', statusCode: 403, }, 403,)
  }

  // Add to org
  await db.insert(schema.orgMemberships,).values({
    orgId: invitation.orgId,
    userId: c.get('accountId',)!,
    role: invitation.role as 'owner' | 'admin' | 'member',
  },)

  // Mark invitation as accepted
  await db
    .update(schema.orgInvitations,)
    .set({ acceptedAt: new Date(), },)
    .where(eq(schema.orgInvitations.id, invitation.id,),)

  // Get org slug for redirect
  const [org,] = await db
    .select({ slug: schema.accounts.slug, },)
    .from(schema.accounts,)
    .where(eq(schema.accounts.id, invitation.orgId,),)
    .limit(1,)

  return c.json({ ok: true, orgSlug: org?.slug ?? '', },)
}

// Delete org
export async function deleteOrg(c: Context<AuthEnv>,) {
  const slug = c.req.param('slug',)!

  const [org,] = await db
    .select()
    .from(schema.accounts,)
    .where(and(eq(schema.accounts.slug, slug,), eq(schema.accounts.type, 'org',),),)
    .limit(1,)

  if (!org) return c.json({ error: 'Organization not found', statusCode: 404, }, 404,)

  // Must be owner
  const [callerMembership,] = await db
    .select()
    .from(schema.orgMemberships,)
    .where(and(eq(schema.orgMemberships.orgId, org.id,), eq(schema.orgMemberships.userId, c.get('accountId',)!,),),)
    .limit(1,)

  if (!callerMembership || callerMembership.role !== 'owner') {
    return c.json({ error: 'Must be an owner to delete the organization', statusCode: 403, }, 403,)
  }

  // Cascade will handle memberships, collections, etc.
  await db.delete(schema.accounts,).where(eq(schema.accounts.id, org.id,),)
  return c.json({ ok: true, },)
}
