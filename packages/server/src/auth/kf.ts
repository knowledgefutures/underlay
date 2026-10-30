/**
 * KF Auth beyond sign-in: a user's profile and role (OIDC userinfo with their
 * stored token, refreshed when it expires), the internal API for the KF orgs a
 * user belongs to (called as the app, with its client credentials), and the
 * check on calls from the console (its signed `KF-Console-Token`). Ported from
 * v1's `src/lib/auth.server.ts` and `src/lib/auth-internal.server.ts`; the
 * console side follows kf-console's docs/calling-kf.md.
 *
 * Every call fails soft: KF Auth being down costs a role or an org list, never
 * a page.
 *
 * Refreshes are single-flight per user in an isolate: KF Auth rotates refresh
 * tokens, so of two refreshes with the same token the second fails. One in
 * another isolate can still lose that race, so a failed refresh reads the
 * account row again for the token the winner stored.
 */
import { and, eq } from 'drizzle-orm'
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose'

import * as schema from '../db/schema.js'
import type { Db } from '../ports.js'

export interface KfConfig {
  /** KF Auth's public origin: console tokens are issued by `<issuerUrl>/api/auth`. */
  issuerUrl: string
  /** Issuer URL for server-to-server calls. */
  internalUrl: string
  /** This app's client (`kf_underlay`): the audience of console tokens. */
  clientId: string
  /** Its secret: with the id, the Basic credentials for KF Auth's internal API. */
  clientSecret: string
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
  /**
   * The user's KF role, read fresh: for authorization. When KF Auth can't be
   * read, the role read in the last 30 s.
   */
  role(userId: string): Promise<string | null>
  /** KF orgs the user belongs to; [] without a client secret. */
  orgs(userId: string): Promise<KfOrg[]>
  /** Whether the user belongs to KF org `kfOrgId`. */
  entitled(userId: string, kfOrgId: string): Promise<boolean>
  /** The user's personal KF org (else their first), for new orgs. */
  defaultOrgId(userId: string): Promise<string | null>
  /**
   * Whether `token` (a request's `KF-Console-Token`) is the console calling
   * `method registeredUrl` on this app. The registered URL, not the one the
   * request arrived at, which a proxy may have rewritten.
   */
  isConsoleCall(token: string | undefined, method: string, registeredUrl: string): Promise<boolean>
}

const PROFILE_TTL_MS = 30_000
const TIMEOUT_MS = 5_000
/** Console tokens live 60 s; KF allows 30 s of clock skew. */
const CONSOLE_TOKEN_MAX_AGE_S = 60
const CLOCK_SKEW_S = 30

export interface KfOptions {
  /** How long a failed refresh waits before it reads the account row again. */
  rereadDelayMs?: number
}

type AccountRow = typeof schema.account.$inferSelect

/** A stored access token good for at least 30 s more. */
const usable = (acct: AccountRow) =>
  acct.accessToken && (acct.accessTokenExpiresAt?.getTime() ?? 0) > Date.now() + 30_000
    ? acct.accessToken
    : null

export function createKf(
  db: Db,
  cfg: KfConfig,
  fetcher: typeof fetch = fetch,
  opts: KfOptions = {},
): Kf {
  const rereadDelayMs = opts.rereadDelayMs ?? 500
  const profiles = new Map<string, { profile: KfProfile; at: number }>()
  /** Refreshes in flight, by user. */
  const refreshing = new Map<string, Promise<string | null>>()
  const call = (url: string, init: RequestInit = {}) =>
    fetcher(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
  const basic = `Basic ${btoa(`${cfg.clientId}:${cfg.clientSecret}`)}`
  const issuer = `${cfg.issuerUrl}/api/auth`
  // Cached per isolate; fetched again when a token names a new key (keys rotate).
  const consoleKeys = createRemoteJWKSet(new URL(`${cfg.internalUrl}/api/auth/jwks`), {
    timeoutDuration: TIMEOUT_MS,
    [customFetch]: (url, init) => fetcher(url, init),
  })

  const account = async (userId: string): Promise<AccountRow | null> => {
    const [acct] = await db
      .select()
      .from(schema.account)
      .where(and(eq(schema.account.userId, userId), eq(schema.account.providerId, 'kf-auth')))
      .limit(1)
    return acct ?? null
  }

  async function accessToken(userId: string): Promise<string | null> {
    const acct = await account(userId)
    if (!acct) return null
    const token = usable(acct)
    if (token) return token
    if (!acct.refreshToken) return null
    let flight = refreshing.get(userId)
    if (!flight) {
      flight = refresh(userId, acct).finally(() => refreshing.delete(userId))
      refreshing.set(userId, flight)
    }
    return flight
  }

  /** Refresh the token; when that fails, the token another refresh stored meanwhile. */
  async function refresh(userId: string, acct: AccountRow): Promise<string | null> {
    const token = await refreshWith(acct)
    if (token) return token
    await new Promise((r) => setTimeout(r, rereadDelayMs))
    const again = await account(userId)
    const stored = again && usable(again)
    if (stored) return stored
    console.warn(`[kf] no usable token for user ${userId} after a failed refresh`)
    return null
  }

  async function refreshWith(acct: AccountRow): Promise<string | null> {
    const res = await call(`${cfg.internalUrl}/api/auth/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: acct.refreshToken ?? '',
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
      }),
    }).catch((err: unknown) => {
      console.warn(`[kf] token refresh for user ${acct.userId} failed:`, String(err))
      return null
    })
    if (!res) return null
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.warn(
        `[kf] token refresh for user ${acct.userId} failed: ${res.status} ${body.slice(0, 200)}`,
      )
      return null
    }
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
      if (!res.ok) {
        console.warn(`[kf] userinfo for user ${userId} failed: ${res.status}`)
        return null
      }
      const p = (await res.json()) as Record<string, unknown>
      const str = (v: unknown) => (typeof v === 'string' ? v : null)
      return {
        name: str(p.name),
        image: str(p.picture),
        role: str(p['https://knowledgefutures.org/role']) ?? str(p.role),
      }
    } catch (err) {
      console.warn(`[kf] profile for user ${userId} failed:`, String(err))
      return null
    }
  }

  async function internal<T>(path: string): Promise<T | null> {
    if (!cfg.clientSecret) return null
    try {
      const res = await call(`${cfg.internalUrl}/api/internal${path}`, {
        headers: { authorization: basic },
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
      const profile = await fetchProfile(userId)
      if (profile) {
        profiles.set(userId, { profile, at: Date.now() })
        return profile.role
      }
      // KF Auth couldn't say: the role read in the last 30 s, if any.
      const hit = profiles.get(userId)
      return hit && Date.now() - hit.at < PROFILE_TTL_MS ? hit.profile.role : null
    },
    async orgs(userId) {
      if (!cfg.clientSecret) return []
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
    async isConsoleCall(token, method, registeredUrl) {
      if (!token) return false
      try {
        const { payload } = await jwtVerify(token, consoleKeys, {
          issuer,
          audience: cfg.clientId,
          // What tells it apart from an ID token, which has the same issuer and audience.
          subject: 'kf-console',
          algorithms: ['EdDSA'],
          maxTokenAge: CONSOLE_TOKEN_MAX_AGE_S,
          clockTolerance: CLOCK_SKEW_S,
        })
        const url = new URL(registeredUrl)
        return payload.htm === method && payload.htu === `${url.origin}${url.pathname}`
      } catch (err) {
        console.warn('[kf] console token refused:', String(err))
        return false
      }
    },
  }
  return kf
}
