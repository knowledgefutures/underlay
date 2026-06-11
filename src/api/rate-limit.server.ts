import { createMiddleware } from 'hono/factory'

import type { AuthEnv } from './auth.server.js'

const WINDOW_MS = 60_000
const ANON_LIMIT = 60
const AUTH_LIMIT = 5_000

interface Bucket {
  count: number
  resetAt: number
}

const buckets = new Map<string, Bucket>()

setInterval(() => {
  const now = Date.now()
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt < now) buckets.delete(key)
  }
}, 60_000)

export const rateLimitMiddleware = createMiddleware<AuthEnv>(async (c, next) => {
  const userId = c.get('userId')
  const key = userId
    ? `user:${userId}`
    : `ip:${c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'}`
  const limit = userId ? AUTH_LIMIT : ANON_LIMIT

  const now = Date.now()
  let bucket = buckets.get(key)
  if (!bucket || bucket.resetAt < now) {
    bucket = { count: 0, resetAt: now + WINDOW_MS }
    buckets.set(key, bucket)
  }

  bucket.count++
  const remaining = Math.max(0, limit - bucket.count)
  const resetSeconds = Math.ceil((bucket.resetAt - now) / 1000)

  c.header('X-RateLimit-Limit', String(limit))
  c.header('X-RateLimit-Remaining', String(remaining))
  c.header('X-RateLimit-Reset', String(resetSeconds))

  if (bucket.count > limit) {
    c.header('Retry-After', String(resetSeconds))
    return c.json({ error: 'Rate limit exceeded', statusCode: 429 }, 429)
  }

  return next()
})
