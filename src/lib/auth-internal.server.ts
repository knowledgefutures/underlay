/**
 * Auth provider internal API client.
 *
 * Optional — only active when AUTH_INTERNAL_API_URL + AUTH_INTERNAL_API_KEY are set.
 * When the internal API is unavailable, apps fall back to OIDC userinfo data only.
 *
 * Env vars:
 *   AUTH_INTERNAL_API_URL — base URL for internal API (falls back to OIDC_ISSUER_INTERNAL_URL)
 *   AUTH_INTERNAL_API_KEY — shared secret for service-to-service calls
 */

const OIDC_ISSUER_URL = process.env.OIDC_ISSUER_URL ?? 'http://localhost:3000'
const OIDC_ISSUER_INTERNAL_URL = process.env.OIDC_ISSUER_INTERNAL_URL ?? OIDC_ISSUER_URL
const AUTH_INTERNAL_API_URL = process.env.AUTH_INTERNAL_API_URL ?? OIDC_ISSUER_INTERNAL_URL

const AUTH_INTERNAL_API_KEY = process.env.AUTH_INTERNAL_API_KEY ?? ''

/** Whether the internal API is configured and available. */
export const hasInternalApi = Boolean(AUTH_INTERNAL_API_KEY)

// --- Types ---

export interface AuthOrg {
  id: string
  name: string
  slug: string
  type: 'personal' | 'shared'
  role: string
}

export interface AuthProfile {
  name: string
  image: string | null
}

// --- Profile cache (in-memory, 5-minute TTL) ---

const TTL_MS = 5 * 60 * 1000

interface CachedProfile {
  name: string
  image: string | null
  fetchedAt: number
}

const profileCache = new Map<string, CachedProfile>()

/**
 * Fetch a user's profile (name, image) from the auth internal API.
 * Uses an in-memory cache with a 5-minute TTL.
 * Returns null if internal API is not configured or request fails.
 */
export async function getAuthProfile(userId: string): Promise<AuthProfile | null> {
  if (!hasInternalApi) return null

  const cached = profileCache.get(userId)
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) {
    return { name: cached.name, image: cached.image }
  }

  try {
    const res = await fetch(`${AUTH_INTERNAL_API_URL}/api/internal/users/${userId}`, {
      headers: { Authorization: `Bearer ${AUTH_INTERNAL_API_KEY}` },
    })
    if (!res.ok) return null

    const data = (await res.json()) as {
      id: string
      name: string
      email: string
      image: string | null
    }
    const entry: CachedProfile = { name: data.name, image: data.image, fetchedAt: Date.now() }
    profileCache.set(userId, entry)
    return { name: entry.name, image: entry.image }
  } catch (e) {
    console.error(`Failed to fetch auth profile for ${userId}:`, e)
    if (cached) return { name: cached.name, image: cached.image }
    return null
  }
}

/**
 * Fetch all orgs a user belongs to from the auth internal API.
 * Returns empty array if internal API is not configured or request fails.
 */
export async function fetchAuthOrgs(userId: string): Promise<AuthOrg[]> {
  if (!hasInternalApi) return []

  const res = await fetch(`${AUTH_INTERNAL_API_URL}/api/internal/users/${userId}/orgs`, {
    headers: { Authorization: `Bearer ${AUTH_INTERNAL_API_KEY}` },
  })
  if (!res.ok) {
    console.error(`Failed to fetch orgs for ${userId}: ${res.status}`)
    return []
  }
  const data = (await res.json()) as { orgs?: AuthOrg[] } | AuthOrg[]
  if (Array.isArray(data)) return data
  return data.orgs ?? []
}

/**
 * Fetch a single user's full profile including email from the auth internal API.
 * Used for cases where email is needed but not stored locally.
 * Returns null if internal API is not configured or request fails.
 */
export async function getAuthUserWithEmail(
  userId: string,
): Promise<{ id: string; name: string; email: string; image: string | null } | null> {
  if (!hasInternalApi) return null

  try {
    const res = await fetch(`${AUTH_INTERNAL_API_URL}/api/internal/users/${userId}`, {
      headers: { Authorization: `Bearer ${AUTH_INTERNAL_API_KEY}` },
    })
    if (!res.ok) return null
    return (await res.json()) as { id: string; name: string; email: string; image: string | null }
  } catch {
    return null
  }
}

/**
 * Resolve a kf-auth user ID by email address using the search endpoint.
 * Returns the first matching user's ID, or null.
 */
export async function resolveKfUserByEmail(email: string): Promise<string | null> {
  if (!hasInternalApi) return null

  try {
    const res = await fetch(
      `${AUTH_INTERNAL_API_URL}/api/internal/users/search?q=${encodeURIComponent(email)}`,
      { headers: { Authorization: `Bearer ${AUTH_INTERNAL_API_KEY}` } },
    )
    if (!res.ok) return null
    const data = (await res.json()) as { users: { id: string; name: string | null }[] }
    return data.users?.[0]?.id ?? null
  } catch {
    return null
  }
}

/**
 * Resolve a user's KF Auth orgs given their Underlay userId.
 * Tries the account's OIDC subject first, falls back to email-based lookup.
 */
export async function resolveUserKfOrgs(userId: string, db: any, schema: any): Promise<AuthOrg[]> {
  if (!hasInternalApi) return []

  const { and, eq } = await import('drizzle-orm')
  const [acct] = await db
    .select({ accountId: schema.account.accountId })
    .from(schema.account)
    .where(and(eq(schema.account.userId, userId), eq(schema.account.providerId, 'kf-auth')))
    .limit(1)
  if (!acct) return []

  let orgs = await fetchAuthOrgs(acct.accountId)
  if (orgs.length === 0) {
    const [u] = await db
      .select({ email: schema.user.email })
      .from(schema.user)
      .where(eq(schema.user.id, userId))
      .limit(1)
    if (u?.email) {
      const kfUserId = await resolveKfUserByEmail(u.email)
      if (kfUserId) orgs = await fetchAuthOrgs(kfUserId)
    }
  }
  return orgs
}

/**
 * Resolve the personal KF org ID for a user. Returns null if unavailable.
 */
export async function resolveDefaultKfOrgId(
  userId: string,
  db: any,
  schema: any,
): Promise<string | null> {
  const orgs = await resolveUserKfOrgs(userId, db, schema)
  const personal = orgs.find((o) => o.type === 'personal')
  return personal?.id ?? orgs[0]?.id ?? null
}

export { AUTH_INTERNAL_API_URL, AUTH_INTERNAL_API_KEY, OIDC_ISSUER_INTERNAL_URL }
