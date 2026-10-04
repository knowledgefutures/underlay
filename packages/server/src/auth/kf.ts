/**
 * KF Auth beyond sign-in: a user's profile and role (OIDC userinfo with their
 * stored token, refreshed when it expires) and, when the deployment has the
 * service key, the internal API for the KF orgs a user belongs to. Ported from
 * v1's `src/lib/auth.server.ts` and `src/lib/auth-internal.server.ts`.
 *
 * Every call fails soft: KF Auth being down costs a role or an org list, never
 * a page.
 */
import { and, eq } from 'drizzle-orm'

import * as schema from '../db/schema.js'
import type { Db } from '../ports.js'

export interface KfConfig {
  /** Issuer URL for server-to-server calls. */
  internalUrl: string
  clientId: string
  clientSecret: string
  /** Shared secret for KF Auth's internal API (`AUTH_INTERNAL_API_KEY`); optional. */
  internalApiKey?: string | undefined
}

export interface KfProfile {
  name: string | null
  image: string | null
  /** 'admin' for stewards. */
  role: string | null
}

export interface KfOrg {
  id: string
  name: string
  slug: string
  type: 'personal' | 'shared'
  role: string
}

export interface Kf {
  /** Profile for the app shell; cached for 30 s per isolate. */
  profile(userId: string): Promise<KfProfile | null>
  /** The user's KF role, read fresh: for authorization. */
  role(userId: string): Promise<string | null>
  /** KF orgs the user belongs to; [] without the internal API. */
  orgs(userId: string): Promise<KfOrg[]>
  /** Whether the user belongs to KF org `kfOrgId`. */
  entitled(userId: string, kfOrgId: string): Promise<boolean>
  /** The user's personal KF org (else their first), for new orgs. */
  defaultOrgId(userId: string): Promise<string | null>
  /** Whether an Authorization header carries the internal API key. */
  isInternalCall(authorization: string | undefined): boolean
}

const PROFILE_TTL_MS = 30_000
const TIMEOUT_MS = 5_000

export function createKf(db: Db, cfg: KfConfig, fetcher: typeof fetch = fetch): Kf {
  const profiles = new Map<string, { profile: KfProfile; at: number }>()
  const call = (url: string, init: RequestInit = {}) =>
    fetcher(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })

  async function accessToken(userId: string): Promise<string | null> {
    const [acct] = await db
      .select()
      .from(schema.account)
      .where(and(eq(schema.account.userId, userId), eq(schema.account.providerId, 'kf-auth')))
      .limit(1)
    if (!acct) return null
    if (acct.accessToken && (acct.accessTokenExpiresAt?.getTime() ?? 0) > Date.now() + 30_000) {
      return acct.accessToken
    }
    if (!acct.refreshToken) return null
    const res = await call(`${cfg.internalUrl}/api/auth/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: acct.refreshToken,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
      }),
    })
    if (!res.ok) return null
    const tokens = (await res.json()) as {
      access_token?: string
      refresh_token?: string
      expires_in?: number
    }
    if (!tokens.access_token) return null
    await db
      .update(schema.account)
      .set({
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? acct.refreshToken,
        accessTokenExpiresAt: tokens.expires_in
          ? new Date(Date.now() + tokens.expires_in * 1000)
          : null,
        updatedAt: new Date(),
      })
      .where(eq(schema.account.id, acct.id))
    return tokens.access_token
  }

  async function fetchProfile(userId: string): Promise<KfProfile | null> {
    try {
      const token = await accessToken(userId)
      if (!token) return null
      const res = await call(`${cfg.internalUrl}/api/auth/oauth2/userinfo`, {
        headers: { authorization: `Bearer ${token}` },
      })
      if (!res.ok) return null
      const p = (await res.json()) as Record<string, unknown>
      const str = (v: unknown) => (typeof v === 'string' ? v : null)
      return {
        name: str(p.name),
        image: str(p.picture),
        role: str(p['https://knowledgefutures.org/role']) ?? str(p.role),
      }
    } catch {
      return null
    }
  }

  async function internal<T>(path: string): Promise<T | null> {
    if (!cfg.internalApiKey) return null
    try {
      const res = await call(`${cfg.internalUrl}/api/internal${path}`, {
        headers: { authorization: `Bearer ${cfg.internalApiKey}` },
      })
      return res.ok ? ((await res.json()) as T) : null
    } catch {
      return null
    }
  }

  async function orgsOf(kfUserId: string): Promise<KfOrg[]> {
    const data = await internal<{ orgs?: KfOrg[] } | KfOrg[]>(`/users/${kfUserId}/orgs`)
    return Array.isArray(data) ? data : (data?.orgs ?? [])
  }

  /** A KF user id by exact email: the search also matches names and hides emails. */
  async function kfUserByEmail(email: string): Promise<string | null> {
    const found = await internal<{ users?: { id: string }[] }>(
      `/users/search?q=${encodeURIComponent(email)}`,
    )
    const wanted = email.trim().toLowerCase()
    for (const u of found?.users ?? []) {
      const full = await internal<{ email?: string }>(`/users/${u.id}`)
      if (full?.email?.trim().toLowerCase() === wanted) return u.id
    }
    return null
  }

  const kf: Kf = {
    async profile(userId) {
      const hit = profiles.get(userId)
      if (hit && Date.now() - hit.at < PROFILE_TTL_MS) return hit.profile
      const profile = await fetchProfile(userId)
      if (profile) profiles.set(userId, { profile, at: Date.now() })
      return profile
    },
    async role(userId) {
      return (await fetchProfile(userId))?.role ?? null
    },
    async orgs(userId) {
      if (!cfg.internalApiKey) return []
      const [acct] = await db
        .select({ accountId: schema.account.accountId })
        .from(schema.account)
        .where(and(eq(schema.account.userId, userId), eq(schema.account.providerId, 'kf-auth')))
        .limit(1)
      if (!acct) return []
      let orgs = await orgsOf(acct.accountId)
      if (orgs.length === 0) {
        const [u] = await db
          .select({ email: schema.user.email })
          .from(schema.user)
          .where(eq(schema.user.id, userId))
          .limit(1)
        const kfUserId = u?.email ? await kfUserByEmail(u.email) : null
        if (kfUserId) orgs = await orgsOf(kfUserId)
      }
      return orgs
    },
    async entitled(userId, kfOrgId) {
      return (await kf.orgs(userId)).some((o) => o.id === kfOrgId)
    },
    async defaultOrgId(userId) {
      const orgs = await kf.orgs(userId)
      return (orgs.find((o) => o.type === 'personal') ?? orgs[0])?.id ?? null
    },
    isInternalCall(authorization) {
      return (
        !!cfg.internalApiKey && timingSafeEqual(authorization ?? '', `Bearer ${cfg.internalApiKey}`)
      )
    },
  }
  return kf
}

function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a)
  const y = new TextEncoder().encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}
