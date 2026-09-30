/**
 * Account (organization) slug rules. Org slugs are the first path segment of
 * every owner URL, so they must not collide with top-level routes.
 */

export const RESERVED_SLUGS = new Set([
  'explore',
  'docs',
  'connect',
  'blog',
  'dashboard',
  'settings',
  'api',
  'login',
  'signup',
  'admin',
  'about',
  'help',
  'support',
  'search',
  'new',
  'create',
  'edit',
  'delete',
  '404',
  '500',
])

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

/** Returns an error message, or null when the slug is acceptable. */
export function validateSlug(slug: unknown): string | null {
  if (!slug || typeof slug !== 'string') return 'Slug is required'
  if (slug.length < 2) return 'Slug must be at least 2 characters'
  if (slug.length > 64) return 'Slug must be at most 64 characters'
  if (!SLUG_RE.test(slug)) {
    return 'Slug must be lowercase alphanumeric with hyphens, and cannot start or end with a hyphen'
  }
  if (RESERVED_SLUGS.has(slug)) return 'That slug is reserved'
  return null
}
