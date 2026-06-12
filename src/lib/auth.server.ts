import { and, eq } from 'drizzle-orm'

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

async function refreshAccessToken(acct: {
  refreshToken: string | null
  accessToken: string | null
  accessTokenExpiresAt: Date | null
}): Promise<string | null> {
  if (
    acct.accessToken &&
    acct.accessTokenExpiresAt &&
    acct.accessTokenExpiresAt.getTime() > Date.now() + 30_000
  ) {
    return acct.accessToken
  }
  if (!acct.refreshToken) return null
  try {
    const tokenUrl = `${KF_AUTH_INTERNAL_URL}/api/auth/oauth2/token`
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: acct.refreshToken,
        client_id: process.env.OIDC_CLIENT_ID ?? 'kf_underlay',
        client_secret: process.env.OIDC_CLIENT_SECRET ?? '',
      }),
    })
    if (!res.ok) return null
    const tokens = await res.json()
    if (!tokens.access_token) return null
    await db
      .update(schema.account)
      .set({
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? acct.refreshToken,
        accessTokenExpiresAt: tokens.expires_in
          ? new Date(Date.now() + tokens.expires_in * 1000)
          : null,
      })
      .where(eq(schema.account.accessToken, acct.accessToken!))
    return tokens.access_token
  } catch {
    return null
  }
}

async function fetchKfRole(userId: string): Promise<string | null> {
  try {
    const [acct] = await db
      .select({
        accessToken: schema.account.accessToken,
        refreshToken: schema.account.refreshToken,
        accessTokenExpiresAt: schema.account.accessTokenExpiresAt,
      })
      .from(schema.account)
      .where(and(eq(schema.account.userId, userId), eq(schema.account.providerId, 'kf-auth')))
      .limit(1)
    if (!acct) return null
    const token = await refreshAccessToken(acct)
    if (!token) return null
    const res = await fetch(`${KF_AUTH_INTERNAL_URL}/api/auth/oauth2/userinfo`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return null
    const profile = await res.json()
    return profile['https://knowledgefutures.org/role'] ?? profile.role ?? null
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
