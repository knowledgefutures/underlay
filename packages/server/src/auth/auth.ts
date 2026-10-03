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
import { and, eq, ne } from 'drizzle-orm'

import type { Principal } from '../api/access.js'
import type { Authenticate } from '../app.js'
import * as schema from '../db/schema.js'
import { defaultOrgSlugCandidate, validateSlug } from '../lib/slug.js'
import type { Db, Ports } from '../ports.js'

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
  const err = validateSlug(slug)
  if (err) throw new APIError('BAD_REQUEST', { message: err })
}

export function createAuth(db: Db, cfg: AuthConfig, waitUntil: (p: Promise<unknown>) => void) {
  const kf = cfg.oidc
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
            authorizationUrl: `${kf.issuerUrl}/api/auth/oauth2/authorize`,
            tokenUrl: `${kf.internalUrl}/api/auth/oauth2/token`,
            userInfoUrl: `${kf.internalUrl}/api/auth/oauth2/userinfo`,
            clientId: kf.clientId,
            clientSecret: kf.clientSecret,
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
              avatarUrl: { type: 'string', required: false, input: true },
              // Server-controlled, as in v1: a caller must not claim another
              // institution's NAAN or the default-org flag.
              arkNaan: { type: 'string', required: false, input: false },
              kfOrgId: { type: 'string', required: false, input: false },
              isDefault: { type: 'boolean', required: false, input: false, defaultValue: false },
            },
          },
        },
        organizationHooks: {
          beforeCreateOrganization: async ({ organization: org }) => {
            assertValidSlug(org.slug)
          },
          beforeUpdateOrganization: async ({ organization: org }) => {
            if (org.slug !== undefined) assertValidSlug(org.slug)
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
            // metadata is client-controlled: 'admin' is clamped to write, as in v1.
            const scope = ctx.body?.metadata?.scope
            if (scope === 'write' || scope === 'admin') return { collections: ['write', 'read'] }
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
          },
        },
      },
      user: {
        create: {
          after: async (user) => {
            // Every user gets a personal (default) organization, as in v1.
            let attempt = 0
            let slug = defaultOrgSlugCandidate(user.email, attempt)
            for (;;) {
              const [taken] = await db
                .select({ id: schema.organization.id })
                .from(schema.organization)
                .where(eq(schema.organization.slug, slug))
                .limit(1)
              if (!taken) break
              slug = defaultOrgSlugCandidate(user.email, ++attempt)
            }
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

/**
 * The request authenticator: API keys (Bearer, or ?token= on GET for share
 * links), then the session cookie. An invalid Bearer key is anonymous here; the
 * routes answer 401/403 as needed.
 */
export function authenticator(getAuth: (ports: Ports) => Auth): Authenticate {
  return async (req, ports) => {
    const auth = getAuth(ports)
    const bearer = req.headers.get('authorization')
    const queryToken =
      req.method === 'GET' || req.method === 'HEAD'
        ? new URL(req.url).searchParams.get('token')
        : null
    const key = bearer?.startsWith('Bearer ') ? bearer.slice(7) : queryToken
    if (key) {
      try {
        const result = await auth.api.verifyApiKey({ body: { key } })
        if (result?.valid && result.key) {
          const k = result.key as unknown as {
            referenceId: string
            permissions?: Record<string, string[]> | null
            metadata?: { collectionIds?: string[] } | null
          }
          const perms = k.permissions?.collections ?? []
          const scope = perms.includes('admin')
            ? 'admin'
            : perms.includes('write')
              ? 'write'
              : 'read'
          const [org] = await ports.db
            .select({ id: schema.organization.id })
            .from(schema.organization)
            .where(eq(schema.organization.id, k.referenceId))
            .limit(1)
          const principal: Principal = {
            userId: k.referenceId,
            scope,
            collectionIds: k.metadata?.collectionIds?.length ? k.metadata.collectionIds : null,
            ...(org ? { orgId: org.id } : {}),
          }
          return principal
        }
      } catch {
        // Invalid or expired key: anonymous.
      }
    }
    try {
      const session = await auth.api.getSession({ headers: req.headers })
      if (session) return { userId: session.user.id, scope: 'session', collectionIds: null }
    } catch {
      // No session.
    }
    return null
  }
}
