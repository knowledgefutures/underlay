import crypto from 'node:crypto'

import { eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { v4 as uuidv4 } from 'uuid'

import { db, schema } from '../db/client.server.js'
import {
  buildAuthorizeUrl,
  exchangeCode,
  extractOrgs,
  fetchUserInfo,
  type OIDCOrg,
} from '../lib/oidc.server.js'
import { type AuthEnv, setSessionCookie } from './auth.server.js'

const STATE_COOKIE = 'kf_oauth_state'
const RETURN_COOKIE = 'kf_oauth_return'
const VERIFIER_COOKIE = 'kf_oauth_verifier'

/**
 * GET /auth/login — redirect to KF Auth with CSRF state + PKCE.
 * Optional ?return_to= query param preserved for post-login redirect.
 */
export async function login(c: Context<AuthEnv>) {
  const state = crypto.randomBytes(24).toString('hex')
  const returnTo = c.req.query('return_to') ?? '/dashboard'

  const cookieOpts = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'Lax' as const,
    path: '/',
    maxAge: 600, // 10 minutes
  }

  setCookie(c, STATE_COOKIE, state, cookieOpts)
  setCookie(c, RETURN_COOKIE, returnTo, cookieOpts)

  const { url, codeVerifier } = await buildAuthorizeUrl(state)
  setCookie(c, VERIFIER_COOKIE, codeVerifier, cookieOpts)

  return c.redirect(url)
}

/**
 * GET /auth/callback — handle the OIDC callback.
 * Exchanges the code for tokens, fetches user info, upserts the local
 * account, creates a session, and redirects to the return URL.
 */
export async function callback(c: Context<AuthEnv>) {
  const code = c.req.query('code')
  const state = c.req.query('state')
  const error = c.req.query('error')

  if (error) {
    console.error('KF Auth returned error:', error, c.req.query('error_description'))
    return c.redirect('/login?error=auth_failed')
  }

  if (!code || !state) {
    return c.redirect('/login?error=missing_params')
  }

  // Validate CSRF state
  const savedState = getCookie(c, STATE_COOKIE)
  const codeVerifier = getCookie(c, VERIFIER_COOKIE)
  deleteCookie(c, STATE_COOKIE, { path: '/' })
  deleteCookie(c, VERIFIER_COOKIE, { path: '/' })

  if (!savedState || savedState !== state) {
    return c.redirect('/login?error=invalid_state')
  }

  if (!codeVerifier) {
    return c.redirect('/login?error=missing_verifier')
  }

  // Exchange code for tokens
  let accessToken: string
  try {
    const tokens = await exchangeCode(code, codeVerifier)
    accessToken = tokens.access_token
  } catch (err) {
    console.error('Token exchange failed:', err)
    return c.redirect('/login?error=token_exchange')
  }

  // Fetch user info
  let userInfo: Awaited<ReturnType<typeof fetchUserInfo>>
  try {
    userInfo = await fetchUserInfo(accessToken)
  } catch (err) {
    console.error('UserInfo fetch failed:', err)
    return c.redirect('/login?error=userinfo')
  }

  // Find or create local account.
  // User account id IS the KF Auth user id (userInfo.sub).
  // No profile data stored locally — fetched from KF Auth on demand.
  const kfUserId = userInfo.sub
  const kfOrgs: OIDCOrg[] = extractOrgs(userInfo)
  const kfPersonalOrg = kfOrgs.find((o) => o.type === 'personal')
  const accountId = kfUserId

  const [existing] = await db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, kfUserId))
    .limit(1)

  if (existing) {
    // Update personal org link if it changed
    if (kfPersonalOrg) {
      await db
        .update(schema.accounts)
        .set({ kfOrgId: kfPersonalOrg.id })
        .where(eq(schema.accounts.id, accountId))
    }
  } else {
    // Create new account — generate a slug from email or name
    const baseSlug = (userInfo.email?.split('@')[0] ?? userInfo.name ?? 'user')
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 30)

    // Ensure slug is unique
    let slug = baseSlug
    let attempt = 0
    while (true) {
      const [conflict] = await db
        .select({ id: schema.accounts.id })
        .from(schema.accounts)
        .where(eq(schema.accounts.slug, slug))
        .limit(1)

      if (!conflict) break
      attempt++
      slug = `${baseSlug}-${attempt}`
    }

    await db.insert(schema.accounts).values({
      id: kfUserId,
      slug,
      type: 'user',
      kfOrgId: kfPersonalOrg?.id ?? null,
    })
  }

  // Create session
  const sessionId = uuidv4()
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days
  await db.insert(schema.sessions).values({
    id: sessionId,
    userId: accountId,
    expiresAt,
    userAgent: c.req.header('user-agent') ?? null,
    ipAddress: c.req.header('x-forwarded-for') || 'unknown',
  })

  setSessionCookie(c, sessionId)

  // Redirect to saved return URL (validate it's a safe relative path)
  const rawReturn = getCookie(c, RETURN_COOKIE) ?? '/dashboard'
  deleteCookie(c, RETURN_COOKIE, { path: '/' })
  const returnTo =
    rawReturn.startsWith('/') && !rawReturn.startsWith('//') ? rawReturn : '/dashboard'

  return c.redirect(returnTo)
}

/**
 * POST /auth/logout — clear local session, return JSON.
 * The client is responsible for redirecting to KF Auth's signout endpoint.
 */
export async function logout(c: Context<AuthEnv>) {
  const sessionCookie = getCookie(c, 'session')
  if (sessionCookie) {
    let sessionId = sessionCookie
    const dotIdx = sessionCookie.lastIndexOf('.')
    if (dotIdx > 0) sessionId = sessionCookie.slice(0, dotIdx)

    await db
      .delete(schema.sessions)
      .where(eq(schema.sessions.id, sessionId))
      .catch(() => {})
  }

  deleteCookie(c, 'session', { path: '/' })
  return c.json({ ok: true })
}
