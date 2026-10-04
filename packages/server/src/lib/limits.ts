import * as schema from '../db/schema.js'
/**
 * Abuse controls (edge-redesign.md, "Files"; v2-alignment-review.md, "Abuse
 * controls"): request budgets for /api/*, and the hash denylist.
 *
 * Budgets are v1's: 60 requests a minute per IP when anonymous, 5,000 per user.
 * On Workers they're the rate-limit binding (per location, approximate); on Node
 * a fixed window in memory.
 *
 * The denylist is a table of file and record hashes that are never served:
 * file redirects and presigns, record reads and listings. It is small and
 * read on most requests, so each isolate holds a copy for a minute.
 */
import type { Db, RateLimiter } from '../ports.js'

export const LIMITS = { anon: 60, user: 5_000 } as const
const WINDOW_MS = 60_000

/** A fixed-window limiter in memory (Node, one process). */
export function memoryRateLimiter(limits: { anon: number; user: number } = LIMITS): RateLimiter {
  const windows = new Map<string, { count: number; resetAt: number }>()
  let sweptAt = Date.now()
  return {
    async check(kind, key) {
      const now = Date.now()
      if (now - sweptAt > WINDOW_MS) {
        for (const [k, w] of windows) if (w.resetAt < now) windows.delete(k)
        sweptAt = now
      }
      const id = `${kind}:${key}`
      let w = windows.get(id)
      if (!w || w.resetAt < now) windows.set(id, (w = { count: 0, resetAt: now + WINDOW_MS }))
      return ++w.count <= limits[kind]
    },
  }
}

/** The binding's shape (wrangler.jsonc "ratelimits"). */
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

/** Cloudflare's rate-limit bindings, one per kind. */
export function bindingRateLimiter(b: {
  anon: RateLimitBinding
  user: RateLimitBinding
}): RateLimiter {
  return { check: async (kind, key) => (await b[kind].limit({ key })).success }
}

/**
 * The client's address for anonymous budgets. cf-connecting-ip is set by
 * Cloudflare and can't be forged through it; otherwise the rightmost
 * X-Forwarded-For hop is what the trusted proxy saw (the leftmost is the
 * client's to write).
 */
export function clientIp(headers: Headers): string {
  const cf = headers.get('cf-connecting-ip')
  if (cf) return cf.trim()
  const hops = (headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return hops.at(-1) ?? 'unknown'
}

const DENY_TTL_MS = 60_000
const denyCache = new WeakMap<object, { at: number; hashes: Promise<Set<string>> }>()

/** Blocked hashes (files and records), cached per database for a minute. */
export function deniedHashes(db: Db): Promise<Set<string>> {
  const hit = denyCache.get(db)
  if (hit && Date.now() - hit.at < DENY_TTL_MS) return hit.hashes
  const hashes = db
    .select({ hash: schema.denylist.hash })
    .from(schema.denylist)
    .then((rows) => new Set(rows.map((r) => r.hash)))
  // A failed read isn't cached.
  hashes.catch(() => denyCache.delete(db))
  denyCache.set(db, { at: Date.now(), hashes })
  return hashes
}

/** Forget the cached denylist (after this isolate changes it). */
export function forgetDenylist(db: Db): void {
  denyCache.delete(db)
}

/** Whether a hash is blocked. Accepts `sha256:`-prefixed file hashes. */
export async function isDenied(db: Db, hash: string): Promise<boolean> {
  return (await deniedHashes(db)).has(hash.replace(/^sha256:/, ''))
}
