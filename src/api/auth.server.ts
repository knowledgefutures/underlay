import bcrypt from 'bcrypt'
import { eq } from 'drizzle-orm'
import type { Context, MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'

import { db, schema } from '../db/client.server.js'

export type AuthEnv = {
  Variables: {
    accountId?: string
    apiKeyScope?: 'read' | 'write' | 'admin'
    apiKeyCollectionId?: string | null
    sessionUserId?: string
  }
}

const publicPaths = new Set(['/api/health', '/api/query/generate-sql'])

const internalToken = process.env.INTERNAL_API_TOKEN ?? 'internal-dev-token'
const authInternalApiKey = process.env.AUTH_INTERNAL_API_KEY ?? ''
const sessionSecret = process.env.SESSION_SECRET ?? 'dev-secret-change-me'

export const authMiddleware = createMiddleware<AuthEnv>(async (c, next) => {
  // Internal service calls (legacy header)
  const internalHeader = c.req.header('x-internal-token')
  if (internalHeader === internalToken) {
    c.set('apiKeyScope', 'read')
    return next()
  }

  // Auth provider internal API key (used by /api/kf/* endpoints)
  const auth = c.req.header('authorization')
  if (authInternalApiKey && auth === `Bearer ${authInternalApiKey}`) {
    c.set('apiKeyScope', 'admin')
    return next()
  }

  // API key auth via Bearer token
  if (auth?.startsWith('Bearer ')) {
    const token = auth.slice(7)
    const keys = await db.select().from(schema.apiKeys)
    let matched = false
    for (const key of keys) {
      const match = await bcrypt.compare(token, key.keyHash)
      if (match) {
        c.set('accountId', key.accountId)
        c.set('apiKeyScope', key.scope as 'read' | 'write' | 'admin')
        c.set('apiKeyCollectionId', key.collectionId)
        await db
          .update(schema.apiKeys)
          .set({ lastUsedAt: new Date() })
          .where(eq(schema.apiKeys.id, key.id))
        matched = true
        break
      }
    }
    if (!matched) {
      return c.json({ error: 'Invalid API key', statusCode: 401 }, 401)
    }
    return next()
  }

  // Session cookie auth
  const sessionCookie = getCookie(c, 'session')
  if (sessionCookie) {
    try {
      // Try to parse as signed cookie (value.signature format)
      let sessionId = sessionCookie
      const dotIdx = sessionCookie.lastIndexOf('.')
      if (dotIdx > 0) {
        sessionId = sessionCookie.slice(0, dotIdx)
      }
      if (sessionId) {
        const [session] = await db
          .select()
          .from(schema.sessions)
          .where(eq(schema.sessions.id, sessionId))
          .limit(1)
        if (session && new Date(session.expiresAt) > new Date()) {
          c.set('sessionUserId', session.userId)
          c.set('accountId', session.userId)
          c.set('apiKeyScope', 'admin')
        }
      }
    } catch {
      // Invalid or expired cookie — ignore silently
    }
  }

  // Public GETs are allowed without auth
  if (c.req.method === 'GET') return next()

  // All writes require auth, except public paths
  if (!c.get('accountId')) {
    const path = new URL(c.req.url).pathname
    if (publicPaths.has(path)) return next()
    return c.json({ error: 'Authentication required', statusCode: 401 }, 401)
  }

  return next()
})

export function requireAuth(scope?: 'read' | 'write' | 'admin'): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    if (!c.get('accountId')) {
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

// Helper to set signed session cookie
export function setSessionCookie(c: Context, sessionId: string) {
  setCookie(c, 'session', sessionId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'Lax',
    path: '/',
    maxAge: 30 * 24 * 60 * 60, // 30 days
  })
}

export function clearSessionCookie(c: Context) {
  deleteCookie(c, 'session', { path: '/' })
}
