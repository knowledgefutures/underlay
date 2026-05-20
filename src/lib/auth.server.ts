import { eq } from 'drizzle-orm'

import { db, schema } from '../db/client.server.js'
import { auth } from './better-auth.js'
import { getKfProfile } from './kf-profile-cache.server.js'

export interface SessionUser {
  id: string
  slug: string
  displayName: string | null
  type: string
  bio: string | null
  avatarUrl: string | null
  orgs: Array<{ slug: string; displayName: string | null; role: string }>
}

/**
 * Extract the session cookie from a Request object and look up the user.
 * Returns the user data or null if not authenticated.
 *
 * For user accounts, displayName and avatarUrl are fetched from KF Auth
 * (via in-memory cache with 5-min TTL). For org accounts, they come from
 * the local DB.
 */
export async function getSessionUser(request: Request): Promise<SessionUser | null> {
  // Use better-auth to validate session from cookies
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return null

  const userId = session.user.id

  // Look up domain account
  const [account] = await db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.id, userId))
    .limit(1)

  if (!account) return null

  // For user accounts, fetch profile from KF Auth (name + image).
  // For org accounts, use locally stored displayName + avatarUrl.
  let displayName = account.displayName
  let avatarUrl = account.avatarUrl

  if (account.type === 'user') {
    const profile = await getKfProfile(account.id)
    if (profile) {
      displayName = profile.name
      avatarUrl = profile.image
    }
  }

  // Look up org memberships
  const memberships = await db
    .select({
      orgSlug: schema.accounts.slug,
      orgDisplayName: schema.accounts.displayName,
      role: schema.orgMemberships.role,
    })
    .from(schema.orgMemberships)
    .innerJoin(schema.accounts, eq(schema.orgMemberships.orgId, schema.accounts.id))
    .where(eq(schema.orgMemberships.userId, account.id))

  return {
    id: account.id,
    slug: account.slug,
    displayName,
    type: account.type,
    bio: account.bio,
    avatarUrl,
    orgs: memberships.map((m) => ({
      slug: m.orgSlug,
      displayName: m.orgDisplayName,
      role: m.role,
    })),
  }
}
