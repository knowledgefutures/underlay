/**
 * D1 read replication (v2-scale-review.md S8): which requests any replica may
 * answer. An anonymous GET or HEAD may read slightly behind the primary; a
 * signed-in user, an API key (header or ?token=), a write, and sign-in itself
 * read the primary, so they always see their own writes without bookmarks.
 */
export function readsAnyReplica(req: Request): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  const url = new URL(req.url)
  if (url.pathname.startsWith('/api/auth/') || url.pathname === '/login') return false
  if (req.headers.has('authorization') || url.searchParams.has('token')) return false
  return !/session_token=/.test(req.headers.get('cookie') ?? '')
}
