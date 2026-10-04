/**
 * Account (organization) slug rules. Org slugs are the first path segment of
 * every owner URL, so they must not collide with top-level routes.
 */

export const RESERVED_SLUGS = new Set([
  // Top-level pages (test/slug.test.ts keeps this in step with web's routes).
  'admin',
  'dashboard',
  'docs',
  'explore',
  'forgot-password',
  'invitations',
  'login',
  'logout',
  'new',
  'new-org',
  'protocol',
  'records',
  'report',
  'reset-password',
  'schemas',
  'settings',
  'signup',
  'superadmin',
  // Server routes and redirects (/api, /blog → the KF site).
  'api',
  'blog',
  // Held back for later pages.
  'about',
  'connect',
  'create',
  'delete',
  'edit',
  'help',
  'search',
  'support',
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

/**
 * Candidate slug for a user's default org, derived from their email's local
 * part. Falls back to `user` when the local part is too short or reserved
 * (e.g. `admin@…`); `attempt` > 0 appends a numeric suffix for collisions.
 */
export function defaultOrgSlugCandidate(email: string, attempt = 0): string {
  const local = (email.split('@')[0] ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 30)
    .replace(/^-+|-+$/g, '')
  const base = local.length < 2 || RESERVED_SLUGS.has(local) ? 'user' : local
  return attempt === 0 ? base : `${base}-${attempt}`
}
