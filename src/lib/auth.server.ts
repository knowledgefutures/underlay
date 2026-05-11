import { eq } from 'drizzle-orm'
import { db, schema } from '../db/client.server.js'

export interface SessionUser {
  id: string
  slug: string
  displayName: string | null
  email: string | null
  type: string
  bio: string | null
  avatarUrl: string | null
  orgs: Array<{ slug: string; displayName: string | null; role: string }>
}

/**
 * Extract the session cookie from a Request object and look up the user.
 * Returns the user data or null if not authenticated.
 */
export async function getSessionUser(request: Request): Promise<SessionUser | null> {
  const cookieHeader = request.headers.get('cookie')
  if (!cookieHeader) return null

  // Parse session cookie
  const cookies = Object.fromEntries(
    cookieHeader.split(';').map((c) => {
      const [key, ...rest] = c.trim().split('=')
      return [key, rest.join('=')] as [string, string]
    }),
  )

  let sessionId = cookies['session']
  if (!sessionId) return null

  // Strip signature if present (legacy signed cookies)
  const dotIdx = sessionId.lastIndexOf('.')
  if (dotIdx > 0) {
    sessionId = sessionId.slice(0, dotIdx)
  }

  // Look up session
  const [session] = await db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.id, sessionId))
    .limit(1)

  if (!session || new Date(session.expiresAt) <= new Date()) {
    return null
  }

  // Look up user
  const [user] = await db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.id, session.userId))
    .limit(1)

  if (!user) return null

  // Look up org memberships
  const memberships = await db
    .select({
      orgSlug: schema.accounts.slug,
      orgDisplayName: schema.accounts.displayName,
      role: schema.orgMemberships.role,
    })
    .from(schema.orgMemberships)
    .innerJoin(schema.accounts, eq(schema.orgMemberships.orgId, schema.accounts.id))
    .where(eq(schema.orgMemberships.userId, user.id))

  return {
    id: user.id,
    slug: user.slug,
    displayName: user.displayName,
    email: user.email,
    type: user.type,
    bio: user.bio,
    avatarUrl: user.avatarUrl,
    orgs: memberships.map((m) => ({
      slug: m.orgSlug,
      displayName: m.orgDisplayName,
      role: m.role,
    })),
  }
}
