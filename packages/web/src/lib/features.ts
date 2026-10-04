/**
 * v1 features whose v2 APIs haven't landed yet.
 *
 * Pages that load data degrade on their own: when the API answers 404 they show
 * a "not available yet" state, and light up once it answers. These flags cover
 * the links and controls that would otherwise lead straight to a 404 (an export
 * download, ARK settings, the discussion drawer). Flip one when its API ships.
 */
export const features = {
  /** GET /api/collections/:owner/:slug/export */
  export: true,
  /** /api/ark/*, /api/collections/:owner/:slug/ark*, /api/accounts/:slug/ark */
  ark: true,
  /** /api/pages/:page/comments and /api/admin/discussion */
  discussion: true,
} as const

/**
 * Whether a 404 came from v2's catch-all for an API route it doesn't have,
 * rather than from a route reporting a missing record or schema (those name
 * what's missing). Pages use it to say "not available yet" instead of "not found".
 */
export async function routeMissing(res: Response): Promise<boolean> {
  if (res.status !== 404) return false
  const body = (await res
    .clone()
    .json()
    .catch(() => null)) as { error?: unknown } | null
  return body?.error === 'Not found'
}
