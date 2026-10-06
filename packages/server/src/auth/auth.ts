/**
 * Sign-in, sessions, organizations and API keys: better-auth, as in v1, over the
 * v2 SQLite schema (D1 or libsql). The tables keep v1's fields so users,
 * sessions and keys migrate across unchanged.
 *
 * KF Auth is the only sign-in method (OIDC via genericOAuth). The `kf_underlay`
 * client is shared by www, next and staging; each host needs its callback
 * registered in kf-auth (edge-redesign-build.md, finding 14).
 *
 * D1 has no interactive transactions, so the adapter runs without them.
 */
import { apiKey } from '@better-auth/api-key'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { APIError } from 'better-auth/api'
import { genericOAuth } from 'better-auth/plugins'
import { organization } from 'better-auth/plugins/organization'
import { and, eq, inArray, ne } from 'drizzle-orm'

import type { Principal } from '../api/access.js'
import type { Authenticate } from '../app.js'
import * as schema from '../db/schema.js'
import { defaultOrgSlugCandidate, validateOrgSlug } from '../lib/slug.js'
import type { Db, Ports } from '../ports.js'
import type { Kf } from './kf.js'

export interface AuthConfig {
  appUrl: string
  /** better-auth secret (v1's SESSION_SECRET). */
  secret: string
  oidc: {
    /** Public issuer URL (browser redirects). */
    issuerUrl: string
    /** Issuer URL for server-to-server calls; on Workers the same as issuerUrl. */
    internalUrl: string
    clientId: string
    clientSecret: string
  }
  /** Extra trusted origins (e.g. http:// variants in dev). */
  trustedOrigins?: string[]
}

function assertValidSlug(slug: unknown) {
  const err = validateOrgSlug(slug)
  if (err) throw new APIError('BAD_REQUEST', { message: err })
}

export function createAuth(
  db: Db,
  cfg: AuthConfig,
  waitUntil: (p: Promise<unknown>) => void,
  kf?: Kf,
) {
  const oidc = cfg.oidc
  return betterAuth({
    database: drizzleAdapter(db, { provider: 'sqlite', schema, transaction: false }),
    baseURL: cfg.appUrl,
    basePath: '/api/auth',
    secret: cfg.secret,
    trustedOrigins: [cfg.appUrl, ...(cfg.trustedOrigins ?? [])],
    advanced: {
      database: { generateId: () => crypto.randomUUID() },
      backgroundTasks: { handler: waitUntil },
    },
    plugins: [
      genericOAuth({
        config: [
          {
            providerId: 'kf-auth',
            authorizationUrl: `${oidc.issuerUrl}/api/auth/oauth2/authorize`,
            tokenUrl: `${oidc.internalUrl}/api/auth/oauth2/token`,
            userInfoUrl: `${oidc.internalUrl}/api/auth/oauth2/userinfo`,
            clientId: oidc.clientId,
            clientSecret: oidc.clientSecret,
            scopes: ['openid', 'profile', 'email', 'offline_access'],
            pkce: true,
            mapProfileToUser: (profile) => ({
              name: profile.name ?? profile.email?.split('@')[0] ?? 'User',
              email: profile.email,
              image: profile.picture ?? null,
            }),
          },
        ],
      }),
      organization({
        schema: {
          organization: {
            additionalFields: {
              bio: { type: 'string', required: false, input: true },
              website: { type: 'string', required: false, input: true },
              // Set only by the logo upload (api/avatars.ts), never by a client.
              avatarUrl: { type: 'string', required: false, input: false },
              // Server-controlled, as in v1: a caller must not claim another
              // institution's NAAN or the default-org flag.
              arkNaan: { type: 'string', required: false, input: false },
              // Picked in the new-org form, and checked in the hooks below against
              // the caller's own KF orgs: /api/kf/summary trusts it.
              kfOrgId: { type: 'string', required: false, input: true },
              isDefault: { type: 'boolean', required: false, input: false, defaultValue: false },
            },
          },
        },
        organizationHooks: {
          beforeCreateOrganization: async ({ organization: org, user }) => {
            assertValidSlug(org.slug)
            // Logo fields would take any URL; logos come from the upload only.
            const base = { ...org, logo: null, avatarUrl: null }
            const asked = (org as { kfOrgId?: string | null }).kfOrgId
            if (asked && kf && (await kf.entitled(user.id, asked))) return { data: base }
            // Not one of theirs (or none asked): the server's choice, never the client's.
            const kfOrgId = kf ? await kf.defaultOrgId(user.id) : null
            return { data: { ...base, kfOrgId: kfOrgId ?? null } }
          },
          beforeUpdateOrganization: async ({ organization: org, user }) => {
            if (org.slug !== undefined) assertValidSlug(org.slug)
            // Clearing is allowed; setting needs membership of that KF org.
            const asked = (org as { kfOrgId?: string | null }).kfOrgId
            if (!asked || (kf && (await kf.entitled(user.id, asked)))) return
            throw new APIError('FORBIDDEN', { message: 'Not a KF organization you belong to' })
          },
        },
      }),
      apiKey({
        defaultPrefix: 'ul',
        customKeyGenerator: async ({ length }) => {
          const { generateRandomString } = await import('better-auth/crypto')
          return `ul_${generateRandomString(length, 'a-z', 'A-Z')}`
        },
        enableMetadata: true,
        // Don't make requests wait on the lastRequest write (v1 setting).
        deferUpdates: true,
        keyExpiration: { minExpiresIn: 0 },
        rateLimit: { enabled: false },
        permissions: {
          defaultPermissions: async (_referenceId, ctx) => {
            // A key never acts beyond its holder's role (api/access.ts capRole), so
            // the client may ask for any scope: admin keys keep the holder's admin
            // powers, write keys act as members.
            const scope = ctx.body?.metadata?.scope
            if (scope === 'admin') return { collections: ['admin', 'write', 'read'] }
            if (scope === 'write') return { collections: ['write', 'read'] }
            return { collections: ['read'] }
          },
        },
      }),
    ],
    databaseHooks: {
      account: {
        create: {
          after: async (account) => {
            // One account per provider per user (v1).
            await db
              .delete(schema.account)
              .where(
                and(
                  eq(schema.account.userId, account.userId),
                  eq(schema.account.providerId, account.providerId),
                  ne(schema.account.id, account.id),
                ),
              )
            // Link the personal org to the user's KF org. Not at user creation: KF
            // Auth's internal API is looked up through this account row.
            if (kf && account.providerId === 'kf-auth') {
              const kfOrgId = await kf.defaultOrgId(account.userId)
              if (kfOrgId) {
                const [own] = await db
                  .select({ id: schema.organization.id, kfOrgId: schema.organization.kfOrgId })
                  .from(schema.organization)
                  .innerJoin(
                    schema.member,
                    eq(schema.member.organizationId, schema.organization.id),
                  )
                  .where(
                    and(
                      eq(schema.member.userId, account.userId),
                      eq(schema.organization.isDefault, true),
                    ),
                  )
                  .limit(1)
                if (own && !own.kfOrgId) {
                  await db
                    .update(schema.organization)
                    .set({ kfOrgId })
                    .where(eq(schema.organization.id, own.id))
                }
              }
            }
          },
        },
      },
      user: {
        create: {
          after: async (user) => {
            // Every user gets a personal (default) organization, as in v1: the
            // first free of 50 candidate slugs, read in one query.
            const candidates = Array.from({ length: 50 }, (_, i) =>
              defaultOrgSlugCandidate(user.email, i),
            )
            const taken = new Set(
              (
                await db
                  .select({ slug: schema.organization.slug })
                  .from(schema.organization)
                  .where(inArray(schema.organization.slug, candidates))
              ).map((r) => r.slug),
            )
            const slug =
              candidates.find((s) => !taken.has(s)) ??
              `${candidates[0]!.replace(/-\d+$/, '')}-${crypto.randomUUID().slice(0, 8)}`
            const orgId = crypto.randomUUID()
            await db.batch([
              db
                .insert(schema.organization)
                .values({ id: orgId, name: user.name, slug, isDefault: true }),
              db
                .insert(schema.member)
                .values({ organizationId: orgId, userId: user.id, role: 'owner' }),
            ])
          },
        },
      },
    },
  })
}

export type Auth = ReturnType<typeof createAuth>

/** A Bearer key (or ?token=) that isn't a valid key: the request gets 401, not anonymity. */
export class InvalidKeyError extends Error {
  constructor() {
    super('Invalid or expired API key')
    this.name = 'InvalidKeyError'
  }
}

export const keyConfig = {
  /** How long an isolate trusts a key row it read (a revoked key works this much longer). */
  cacheMs: 30_000,
  /** `last_request` is written at most this often per key, not on every request. */
  lastRequestEveryMs: 60 * 60 * 1000,
}

type KeyRow = typeof schema.apikey.$inferSelect
const keyRows = new WeakMap<object, Map<string, { at: number; row: KeyRow | null }>>()

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

/** better-auth stores JSON columns as strings, older rows twice over. */
function jsonColumn<T>(v: unknown): T | null {
  let out = v
  for (let i = 0; i < 2 && typeof out === 'string'; i++) {
    try {
      out = JSON.parse(out)
    } catch {
      return null
    }
  }
  return (out as T) ?? null
}

/** A key's row by its hash (better-auth's: unpadded base64url SHA-256), cached briefly. */
async function keyRow(db: Db, key: string): Promise<KeyRow | null> {
  const hashed = b64url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))),
  )
  let cache = keyRows.get(db)
  if (!cache) keyRows.set(db, (cache = new Map()))
  const hit = cache.get(hashed)
  if (hit && Date.now() - hit.at < keyConfig.cacheMs) return hit.row
  const [row] = await db
    .select()
    .from(schema.apikey)
    .where(and(eq(schema.apikey.key, hashed), eq(schema.apikey.configId, 'default')))
    .limit(1)
  if (cache.size > 1_000) cache.clear()
  cache.set(hashed, { at: Date.now(), row: row ?? null })
  return row ?? null
}

/**
 * Verify an API key against its row directly. better-auth's verifyApiKey writes
 * the row on every request (lastRequest, updatedAt), a D1 write per keyed call;
 * here `last_request` is written at most hourly. Keys with a usage limit
 * (`remaining`) still go through better-auth, which counts them down.
 */
async function verifyKey(auth: Auth, ports: Ports, key: string): Promise<Principal | null> {
  const row = await keyRow(ports.db, key)
  if (!row || row.enabled === false) return null
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null
  let k = row as unknown as {
    referenceId: string
    permissions?: unknown
    metadata?: unknown
  }
  if (row.remaining !== null) {
    const result = await auth.api.verifyApiKey({ body: { key } }).catch(() => null)
    if (!result?.valid || !result.key) return null
    k = result.key as unknown as typeof k
  } else if (
    !row.lastRequest ||
    Date.now() - row.lastRequest.getTime() > keyConfig.lastRequestEveryMs
  ) {
    const now = new Date()
    row.lastRequest = now
    ports.waitUntil(
      ports.db
        .update(schema.apikey)
        .set({ lastRequest: now })
        .where(eq(schema.apikey.id, row.id))
        .then(() => {})
        .catch((err: unknown) => console.error('[auth] lastRequest write failed', err)),
    )
  }
  const perms = jsonColumn<Record<string, string[]>>(k.permissions)?.collections ?? []
  const scope = perms.includes('admin') ? 'admin' : perms.includes('write') ? 'write' : 'read'
  const metadata = jsonColumn<{ collectionIds?: string[] }>(k.metadata)
  const [org] = await ports.db
    .select({ id: schema.organization.id })
    .from(schema.organization)
    .where(eq(schema.organization.id, k.referenceId))
    .limit(1)
  return {
    userId: k.referenceId,
    scope,
    collectionIds: metadata?.collectionIds?.length ? metadata.collectionIds : null,
    ...(org ? { orgId: org.id } : {}),
  }
}

/**
 * The request authenticator: API keys (Bearer, or ?token= on GET for share
 * links), then the session cookie. A key that doesn't verify throws
 * InvalidKeyError (401), rather than passing as anonymous.
 */
export function authenticator(getAuth: (ports: Ports) => Auth): Authenticate {
  return async (req, ports) => {
    const auth = getAuth(ports)
    const bearer = req.headers.get('authorization')
    const queryToken =
      req.method === 'GET' || req.method === 'HEAD'
        ? new URL(req.url).searchParams.get('token')
        : null
    // The scheme is case-insensitive (RFC 9110 §11.1). `Bearer` with no token
    // (headers arrive trimmed) is a key that doesn't verify, not anonymity.
    const scheme = bearer && /^bearer(\s+|$)/i.exec(bearer)
    const key = scheme ? bearer.slice(scheme[0].length).trim() : queryToken
    if (scheme && !key) throw new InvalidKeyError()
    if (key) {
      const principal = await verifyKey(auth, ports, key)
      if (!principal) throw new InvalidKeyError()
      return principal
    }
    try {
      const session = await auth.api.getSession({ headers: req.headers })
      if (session) {
        return {
          userId: session.user.id,
          scope: 'session',
          collectionIds: null,
          sessionId: session.session.id,
        }
      }
    } catch {
      // No session.
    }
    return null
  }
}
