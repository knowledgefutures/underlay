import bcrypt from 'bcrypt'
import { eq } from 'drizzle-orm'
import type { MiddlewareHandler } from 'hono'
import { createMiddleware } from 'hono/factory'

import { db, schema } from '../db/client.server.js'
import { auth } from '../lib/better-auth.js'

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
const authInternalApiKey =
  process.env.AUTH_INTERNAL_API_KEY ?? process.env.KF_INTERNAL_API_KEY ?? ''

export const authMiddleware = createMiddleware<AuthEnv>(async (c, next) => {
  // Internal service calls (legacy header)
  const internalHeader = c.req.header('x-internal-token')
  if (internalHeader === internalToken) {
    c.set('apiKeyScope', 'read')
    return next()
  }

  // Auth provider internal API key (used by /api/kf/* endpoints)
  const headerAuth = c.req.header('authorization')
  if (authInternalApiKey && headerAuth === `Bearer ${authInternalApiKey}`) {
    c.set('apiKeyScope', 'admin')
    return next()
  }

  // API key auth via Bearer token
  if (headerAuth?.startsWith('Bearer ')) {
    const token = headerAuth.slice(7)
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

  // Session cookie auth via better-auth
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (session?.user) {
    // session.user.id = KF Auth sub = accounts.id (shared ID)
    c.set('sessionUserId', session.user.id)
    c.set('accountId', session.user.id)
    c.set('apiKeyScope', 'admin')
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
