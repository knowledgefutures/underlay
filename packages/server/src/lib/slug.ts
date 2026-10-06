/**
 * Slug rules. An org slug is the first path segment of every owner URL
 * (`/:owner`), so it must not collide with the site's own top-level paths, now
 * or later; a collection slug is the second (`/:owner/:slug`), so it must not
 * collide with an org's own pages. Reservations only bind new and renamed slugs:
 * an existing org or collection keeps its slug.
 */

/** Words no org may take: today's top-level paths, and those an app usually grows. */
export const RESERVED_ORG_SLUGS = new Set([
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
  // Server routes and redirects.
  'agent',
  'api',
  'ark',
  'blog',
  // Sign-in and accounts.
  'account',
  'accounts',
  'auth',
  'callback',
  'invite',
  'join',
  'me',
  'oauth',
  'password',
  'profile',
  'register',
  'session',
  'sessions',
  'sign-in',
  'sign-out',
  'sign-up',
  'signin',
  'signout',
  'sso',
  'user',
  'users',
  'verify',
  // Organizations and people.
  'member',
  'members',
  'org',
  'organization',
  'organizations',
  'orgs',
  'people',
  'team',
  'teams',
  // Browsing and the app's own nouns.
  'browse',
  'collection',
  'collections',
  'data',
  'datasets',
  'discover',
  'featured',
  'feed',
  'files',
  'home',
  'labels',
  'popular',
  'record',
  'schema',
  'search',
  'tags',
  'topics',
  'trending',
  'types',
  'versions',
  // Account pages an app grows.
  'activity',
  'billing',
  'checkout',
  'inbox',
  'invoices',
  'keys',
  'messages',
  'notifications',
  'plans',
  'preferences',
  'pricing',
  'subscription',
  'tokens',
  'usage',
  // About, help and legal.
  'about',
  'abuse',
  'accessibility',
  'changelog',
  'community',
  'contact',
  'cookies',
  'dmca',
  'events',
  'faq',
  'guide',
  'guides',
  'help',
  'legal',
  'license',
  'news',
  'press',
  'privacy',
  'security',
  'status',
  'support',
  'terms',
  'tutorials',
  'updates',
  // Actions.
  'compare',
  'create',
  'delete',
  'diff',
  'download',
  'downloads',
  'edit',
  'export',
  'import',
  'mirror',
  'mirrors',
  'pull',
  'push',
  'query',
  'restore',
  'sync',
  'upload',
  'uploads',
  // Machine paths and infrastructure.
  'app',
  'apps',
  'assets',
  'cdn',
  'cli',
  'console',
  'developer',
  'developers',
  'email',
  'graphql',
  'health',
  'llms',
  'mail',
  'mcp',
  'metrics',
  'robots',
  'rss',
  'sdk',
  'sitemap',
  'spec',
  'static',
  'v1',
  'v2',
  'webhooks',
  'www',
  // Names that would read as us, or as nobody.
  'anonymous',
  'internal',
  'kf',
  'knowledge-futures',
  'knowledgefutures',
  'moderator',
  'null',
  'official',
  'root',
  'staff',
  'underlay',
  'undefined',
  '404',
  '500',
])

/** Words no collection may take: an org's own pages under `/:owner/`, now or later. */
export const RESERVED_COLLECTION_SLUGS = new Set([
  'settings',
  'activity',
  'billing',
  'collections',
  'members',
  'new',
  'people',
  'usage',
])

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

function validate(slug: unknown, reserved: Set<string>): string | null {
  if (!slug || typeof slug !== 'string') return 'Slug is required'
  if (slug.length < 2) return 'Slug must be at least 2 characters'
  if (slug.length > 64) return 'Slug must be at most 64 characters'
  if (!SLUG_RE.test(slug)) {
    return 'Slug must be lowercase alphanumeric with hyphens, and cannot start or end with a hyphen'
  }
  if (reserved.has(slug)) return 'That slug is reserved'
  return null
}

/** An org slug's problem, or null when it's acceptable. */
export const validateOrgSlug = (slug: unknown) => validate(slug, RESERVED_ORG_SLUGS)

/** A collection slug's problem, or null when it's acceptable. */
export const validateCollectionSlug = (slug: unknown) => validate(slug, RESERVED_COLLECTION_SLUGS)

/**
 * Candidate slug for a user's default org, from their email's local part. A
 * local part that is too short or reserved (`admin@…`, `support@…`) gets a
 * numeric suffix from the start (`support-1`); `attempt` > 0 counts collisions.
 */
export function defaultOrgSlugCandidate(email: string, attempt = 0): string {
  const local = (email.split('@')[0] ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 30)
    .replace(/^-+|-+$/g, '')
  if (local.length < 2 || RESERVED_ORG_SLUGS.has(local)) return `${local || 'user'}-${attempt + 1}`
  return attempt === 0 ? local : `${local}-${attempt}`
}
