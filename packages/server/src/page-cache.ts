/**
 * Anonymous page cache: a UI page rendered for a visitor with no session, no key, and no
 * cookie at all is kept in the colo's cache (`ports.cache`, the Cache API on Workers) and
 * served to the next such visitor without rendering it again.
 *
 * Only pages. API responses are not cached: an anonymous API call is metered and billed
 * to the collection's owner (billing/usage.ts), and a cached one would not be.
 *
 * Who gets a cached page: a GET with no principal, no `Cookie` and no `Authorization`
 * header, and no `token` in the query. Anyone signed in, holding a key or a share link, or
 * carrying any cookie gets a fresh render, and never fills the cache. What is kept: a 200
 * HTML response with no `Set-Cookie` and nothing marking it private.
 *
 * How fresh. A collection's pages (`/:owner/:collection/...`) are keyed by the collection's
 * head version, visibility, and last update in D1, read on every request: a push, a
 * visibility change, or an edit shows at once, and a collection made private is never served
 * from here again. Other pages (home, explore, an organization, a record or schema by hash)
 * are kept `TTL_SECONDS`; the docs an hour. Every key holds the build (a deploy renders anew,
 * never naming assets the new build lacks) and the denylist (a takedown shows at once).
 */
import { and, eq } from 'drizzle-orm'
import type { Context } from 'hono'

import type { AppEnv } from './app.js'
import * as schema from './db/schema.js'
import { deniedHashes } from './lib/limits.js'

/** How long a page that is not a collection's is kept. */
export const TTL_SECONDS = 60
const DOCS_TTL_SECONDS = 60 * 60
/** A collection's page, keyed by its state: kept until that changes, or this long. */
const COLLECTION_TTL_SECONDS = 10 * 60

/** First path segments that are never an owner: forms, accounts, and admin. */
const RESERVED = new Set([
  'admin',
  'api',
  'auth',
  'dashboard',
  'forgot-password',
  'invitations',
  'login',
  'logout',
  'new',
  'new-org',
  'report',
  'reset-password',
  'settings',
  'signup',
  'superadmin',
])

type Policy =
  | { kind: 'ttl'; seconds: number }
  | { kind: 'collection'; owner: string; slug: string }
  | null

/** Whether a page may be cached, and how it is kept fresh. */
export function pagePolicy(path: string): Policy {
  const parts = path.split('/').filter(Boolean)
  if (parts.length === 0 || (parts.length === 1 && parts[0] === 'explore'))
    return { kind: 'ttl', seconds: TTL_SECONDS }
  const first = parts[0]!
  if (first === 'docs') return { kind: 'ttl', seconds: DOCS_TTL_SECONDS }
  if (RESERVED.has(first) || parts.includes('settings')) return null
  if (first === 'records' || first === 'schemas') return { kind: 'ttl', seconds: TTL_SECONDS }
  if (parts.length === 1) return { kind: 'ttl', seconds: TTL_SECONDS }
  return {
    kind: 'collection',
    owner: decodeURIComponent(first),
    slug: decodeURIComponent(parts[1]!),
  }
}

/** Whether this request is anonymous in every way a page could tell. */
function anonymous(c: Context<AppEnv>): boolean {
  if (c.req.method !== 'GET' || c.var.principal) return false
  const h = c.req.raw.headers
  if (h.has('cookie') || h.has('authorization')) return false
  return !new URL(c.req.url).searchParams.has('token')
}

function fnv(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(16)
}

/** The denylist, as a short tag: any change makes every key new. */
async function denyTag(c: Context<AppEnv>): Promise<string> {
  const denied = await deniedHashes(c.var.ports.db)
  return denied.size === 0 ? '0' : `${denied.size}.${fnv([...denied].sort().join(','))}`
}

/** The key for a request, or null when its page must not be cached. */
async function keyFor(
  c: Context<AppEnv>,
  buildId: string,
): Promise<{ key: string; seconds: number } | null> {
  if (!anonymous(c)) return null
  const url = new URL(c.req.url)
  const policy = pagePolicy(url.pathname)
  if (!policy) return null
  let state = ''
  let seconds = policy.kind === 'ttl' ? policy.seconds : COLLECTION_TTL_SECONDS
  if (policy.kind === 'collection') {
    const [row] = await c.var.ports.db
      .select({
        public: schema.collections.public,
        head: schema.collections.headVersionId,
        updatedAt: schema.collections.updatedAt,
      })
      .from(schema.collections)
      .innerJoin(schema.organization, eq(schema.organization.id, schema.collections.organizationId))
      .where(
        and(eq(schema.organization.slug, policy.owner), eq(schema.collections.slug, policy.slug)),
      )
      .limit(1)
    // Not found, or private: rendered fresh (a 404 for this visitor), never kept.
    if (!row?.public) return null
    state = `${row.head ?? 'none'}.${row.updatedAt?.getTime() ?? 0}`
  } else seconds = policy.seconds
  const tag = await denyTag(c)
  return {
    key: `page/${buildId}/${tag}/${state}/${encodeURIComponent(url.pathname + url.search)}`,
    seconds,
  }
}

const enc = new TextEncoder()
const dec = new TextDecoder()

/** Headers a cached page keeps: what the render set, never a cookie. */
function keptHeaders(res: Response): [string, string][] {
  const out: [string, string][] = []
  res.headers.forEach((v, k) => {
    if (k !== 'set-cookie' && k !== 'date' && k !== 'content-length') out.push([k, v])
  })
  return out
}

/**
 * Serve a page from the cache when this visitor may have one, else render it and keep the
 * result when it may be kept. `render` is the page renderer.
 */
export async function cachedPage(
  c: Context<AppEnv>,
  buildId: string | undefined,
  render: () => Promise<Response>,
): Promise<Response> {
  const k = buildId ? await keyFor(c, buildId).catch(() => null) : null
  if (!k) return render()
  const cache = c.var.ports.cache
  const hit = await cache.get(k.key).catch(() => null)
  if (hit) {
    const nl = hit.indexOf(10)
    const head = JSON.parse(dec.decode(hit.subarray(0, nl))) as {
      at: number
      headers: [string, string][]
    }
    if (Date.now() - head.at < k.seconds * 1000) {
      const res = new Response(hit.slice(nl + 1) as Uint8Array<ArrayBuffer>, {
        status: 200,
        headers: head.headers,
      })
      res.headers.set('x-underlay-page-cache', 'hit')
      return res
    }
  }
  const res = await render()
  const type = res.headers.get('content-type') ?? ''
  const control = res.headers.get('cache-control') ?? ''
  if (
    res.status !== 200 ||
    !res.body ||
    res.headers.has('set-cookie') ||
    !type.startsWith('text/html') ||
    /private|no-store/.test(control)
  )
    return res
  const [toClient, toCache] = res.body.tee()
  const headers = keptHeaders(res)
  const keep = new Response(toCache)
    .arrayBuffer()
    .then((body) => {
      const head = enc.encode(`${JSON.stringify({ at: Date.now(), headers })}\n`)
      const all = new Uint8Array(head.byteLength + body.byteLength)
      all.set(head)
      all.set(new Uint8Array(body), head.byteLength)
      return cache.put(k.key, all, { ttlSeconds: k.seconds })
    })
    .catch((err: unknown) => console.error('[page-cache] put', err))
  c.var.ports.waitUntil(keep)
  const out = new Response(toClient, res)
  out.headers.set('x-underlay-page-cache', 'miss')
  return out
}
