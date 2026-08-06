import crypto from 'node:crypto'

import type { Context, MiddlewareHandler } from 'hono'
import { createMiddleware } from 'hono/factory'

import { auth } from '../lib/auth.js'

function timingSafeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

export type AuthEnv = {
  Variables: {
    userId?: string
    userEmail?: string
    apiKeyScope?: 'read' | 'write' | 'admin'
    apiKeyCollectionIds?: string[]
    sessionUserId?: string
  }
}

const publicPaths = new Set(['/api/health', '/api/query/generate-sql'])

/** Verify an API key and load its identity/scope into the request context. */
async function applyApiKey(
  c: Context<AuthEnv>,
  key: string,
): Promise<'ok' | 'invalid' | 'rate-limited'> {
  try {
    const result = await auth.api.verifyApiKey({ body: { key } })
    if (result?.valid && result.key) {
      c.set('userId', (result.key as any).userId ?? (result.key as any).referenceId)
      const perms = (result.key.permissions as Record<string, string[]>) ?? {}
      if (perms['collections']?.includes('admin')) {
        c.set('apiKeyScope', 'admin')
      } else if (perms['collections']?.includes('write')) {
        c.set('apiKeyScope', 'write')
      } else {
        c.set('apiKeyScope', 'read')
      }
      const meta = (result.key as any).metadata as Record<string, any> | null
      if (meta?.collectionIds?.length) {
        c.set('apiKeyCollectionIds', meta.collectionIds)
      }
      return 'ok'
    }
  } catch (err: any) {
    if (err?.status === 'TOO_MANY_REQUESTS' || err?.statusCode === 429) {
      return 'rate-limited'
    }
  }
  return 'invalid'
}

const internalToken = process.env.INTERNAL_API_TOKEN ?? ''
const authInternalApiKey = process.env.AUTH_INTERNAL_API_KEY ?? ''

export const authMiddleware = createMiddleware<AuthEnv>(async (c, next) => {
  // Internal service calls (legacy header); only honored when a token is configured
  const internalHeader = c.req.header('x-internal-token')
  if (internalToken && internalHeader && timingSafeEquals(internalHeader, internalToken)) {
    c.set('apiKeyScope', 'read')
    return next()
  }

  // Auth provider internal API key (used by /api/kf/* endpoints)
  const authorization = c.req.header('authorization')
  if (
    authInternalApiKey &&
    authorization &&
    timingSafeEquals(authorization, `Bearer ${authInternalApiKey}`)
  ) {
    c.set('apiKeyScope', 'admin')
    return next()
  }

  // API key auth via Bearer token (better-auth apiKey plugin)
  if (authorization?.startsWith('Bearer ')) {
    const key = authorization.slice(7)
    const outcome = await applyApiKey(c, key)
    if (outcome === 'rate-limited') {
      return c.json({ error: 'Rate limit exceeded', statusCode: 429 }, 429)
    }
    if (outcome === 'invalid') {
      return c.json({ error: 'Invalid API key', statusCode: 401 }, 401)
    }
    return next()
  }

  // API key in the query string (?token=...) — capability URLs (read-only share
  // links, export downloads) authenticate plain browser GETs that can't set
  // headers. An invalid or expired token falls through to anonymous access
  // rather than 401, so the page still renders whatever is public.
  if (c.req.method === 'GET' || c.req.method === 'HEAD') {
    const queryToken = new URL(c.req.url).searchParams.get('token')
    if (queryToken) {
      const outcome = await applyApiKey(c, queryToken)
      if (outcome === 'rate-limited') {
        return c.json({ error: 'Rate limit exceeded', statusCode: 429 }, 429)
      }
      if (outcome === 'ok') return next()
    }
  }

  // Session cookie auth (better-auth managed)
  try {
    const session = await auth.api.getSession({ headers: c.req.raw.headers })
    if (session) {
      c.set('sessionUserId', session.user.id)
      c.set('userId', session.user.id)
      c.set('userEmail', session.user.email)
      // Sessions get write scope; destructive/admin actions are gated by
      // per-resource org-role checks, not a blanket admin scope.
      c.set('apiKeyScope', 'write')
    }
  } catch {
    // Invalid or expired session — ignore
  }

  // Public GETs are allowed without auth
  if (c.req.method === 'GET') return next()

  // All writes require auth, except public paths
  if (!c.get('userId')) {
    const path = new URL(c.req.url).pathname
    if (publicPaths.has(path)) return next()
    return c.json({ error: 'Authentication required', statusCode: 401 }, 401)
  }

  return next()
})

export function requireAuth(scope?: 'read' | 'write' | 'admin'): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    if (!c.get('userId')) {
      return c.json({ error: 'Authentication required', statusCode: 401 }, 401)
    }
    if (scope === 'admin' && c.get('apiKeyScope') !== 'admin') {
      return c.json({ error: 'Admin access required', statusCode: 403 }, 403)
    }
    if (scope === 'write' && c.get('apiKeyScope') === 'read') {
      return c.json({ error: 'Write access required', statusCode: 403 }, 403)
    }
    return next()
  }
}
