import { eq } from 'drizzle-orm'

import { db, schema } from '../db/client.server.js'
import { auth, KF_AUTH_INTERNAL_URL } from './auth.js'

export interface SessionUser {
  id: string
  slug: string | null
  displayName: string | null
  avatarUrl: string | null
  kfRole: string | null
  defaultOrg: { slug: string; displayName: string | null } | null
  orgs: Array<{
    organizationId: string
    slug: string
    displayName: string | null
    role: string
    isDefault: boolean | null
  }>
}

async function fetchKfRole(userId: string): Promise<string | null> {
  try {
    const [acct] = await db
      .select({ accessToken: schema.account.accessToken })
      .from(schema.account)
      .where(eq(schema.account.userId, userId))
      .limit(1)
    if (!acct?.accessToken) return null
    const res = await fetch(`${KF_AUTH_INTERNAL_URL}/api/auth/oauth2/userinfo`, {
      headers: { Authorization: `Bearer ${acct.accessToken}` },
    })
    if (!res.ok) return null
    const profile = await res.json()
    return profile.role ?? null
  } catch {
    return null
  }
}

export async function getSessionUser(request: Request): Promise<SessionUser | null> {
  let session: Awaited<ReturnType<typeof auth.api.getSession>>
  try {
    session = await auth.api.getSession({ headers: request.headers })
  } catch {
    return null
  }
  if (!session) return null

  const u = session.user

  const [memberships, kfRole] = await Promise.all([
    db
      .select({
        orgId: schema.organization.id,
        orgSlug: schema.organization.slug,
        orgName: schema.organization.name,
        isDefault: schema.organization.isDefault,
        role: schema.member.role,
      })
      .from(schema.member)
      .innerJoin(schema.organization, eq(schema.member.organizationId, schema.organization.id))
      .where(eq(schema.member.userId, u.id)),
    fetchKfRole(u.id),
  ])

  const defaultOrg = memberships.find((m) => m.isDefault) ?? null

  return {
    id: u.id,
    slug: defaultOrg?.orgSlug ?? null,
    displayName: defaultOrg?.orgName ?? u.name,
    avatarUrl: u.image ?? null,
    kfRole,
    defaultOrg: defaultOrg ? { slug: defaultOrg.orgSlug, displayName: defaultOrg.orgName } : null,
    orgs: memberships.map((m) => ({
      organizationId: m.orgId,
      slug: m.orgSlug,
      displayName: m.orgName,
      role: m.role,
      isDefault: m.isDefault,
    })),
  }
}
