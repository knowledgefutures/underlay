import { eq } from 'drizzle-orm'

import { db, schema } from '../db/client.server.js'
import { auth } from './auth.js'

export interface SessionUser {
  id: string
  displayName: string | null
  avatarUrl: string | null
  defaultOrg: { slug: string; displayName: string | null } | null
  orgs: Array<{ slug: string; displayName: string | null; role: string }>
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

  const memberships = await db
    .select({
      orgId: schema.organization.id,
      orgSlug: schema.organization.slug,
      orgName: schema.organization.name,
      isDefault: schema.organization.isDefault,
      role: schema.member.role,
    })
    .from(schema.member)
    .innerJoin(schema.organization, eq(schema.member.organizationId, schema.organization.id))
    .where(eq(schema.member.userId, u.id))

  const defaultOrg = memberships.find((m) => m.isDefault) ?? null

  return {
    id: u.id,
    displayName: defaultOrg?.orgName ?? u.name,
    avatarUrl: u.image ?? null,
    defaultOrg: defaultOrg ? { slug: defaultOrg.orgSlug, displayName: defaultOrg.orgName } : null,
    orgs: memberships.map((m) => ({
      slug: m.orgSlug,
      displayName: m.orgName,
      role: m.role,
    })),
  }
}
