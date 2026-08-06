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

/**
 * Best-effort client IP for anonymous rate limiting. The LEFTMOST
 * `X-Forwarded-For` entry is set by the client and trivially spoofable (rotate
 * it to defeat the limit), so prefer `cf-connecting-ip` — which Cloudflare
 * overwrites at the edge and a client cannot forge when the origin is only
 * reachable through it — and otherwise use the RIGHTMOST hop, the address the
 * trusted reverse proxy actually observed.
 */
function clientIp(c: { req: { header: (name: string) => string | undefined } }): string {
  const cf = c.req.header('cf-connecting-ip')
  if (cf) return cf.trim()
  const xff = c.req.header('x-forwarded-for')
  if (xff) {
    const parts = xff
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (parts.length > 0) return parts[parts.length - 1]!
  }
  return 'unknown'
}

setInterval(() => {
  const now = Date.now()
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt < now) buckets.delete(key)
  }
}, 60_000)

export const rateLimitMiddleware = createMiddleware<AuthEnv>(async (c, next) => {
  const userId = c.get('userId')
  const key = userId ? `user:${userId}` : `ip:${clientIp(c)}`
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
