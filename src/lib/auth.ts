import { apiKey } from '@better-auth/api-key'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { genericOAuth } from 'better-auth/plugins'
import { organization } from 'better-auth/plugins/organization'
import { and, eq, ne } from 'drizzle-orm'

import { db, schema } from '../db/client.server.js'

const KF_AUTH_URL = process.env.OIDC_ISSUER_URL ?? 'http://localhost:3000'
const KF_AUTH_INTERNAL_URL = process.env.OIDC_ISSUER_INTERNAL_URL ?? KF_AUTH_URL

if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET must be set in production')
}

const APP_URL = process.env.APP_URL ?? 'http://localhost:4100'

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg' }),
  baseURL: APP_URL,
  basePath: '/api/auth',
  secret: process.env.SESSION_SECRET ?? 'dev-secret-change-me',
  trustedOrigins: [APP_URL, new URL(APP_URL).origin.replace('https://', 'http://')],

  advanced: {
    database: {
      generateId: () => crypto.randomUUID(),
    },
  },

  plugins: [
    genericOAuth({
      config: [
        {
          providerId: 'kf-auth',
          authorizationUrl: `${KF_AUTH_URL}/api/auth/oauth2/authorize`,
          tokenUrl: `${KF_AUTH_INTERNAL_URL}/api/auth/oauth2/token`,
          userInfoUrl: `${KF_AUTH_INTERNAL_URL}/api/auth/oauth2/userinfo`,
          clientId: process.env.OIDC_CLIENT_ID ?? 'kf_underlay',
          clientSecret: process.env.OIDC_CLIENT_SECRET ?? '',
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
            // Not client-settable: arkNaan is set via the validated ARK endpoint,
            // and isDefault is server-controlled (the signup hook marks the
            // personal org) — otherwise a caller could claim another
            // institution's NAAN or hijack default-org selection.
            arkNaan: { type: 'string', required: false, input: false },
            // kfOrgId stays user-selectable (the new-org UI offers a picker) but
            // is validated against the caller's entitled KF orgs in the hook below.
            kfOrgId: { type: 'string', required: false, input: true },
            isDefault: { type: 'boolean', required: false, input: false, defaultValue: false },
          },
        },
      },
      organizationHooks: {
        beforeCreateOrganization: async ({ organization: orgData, user }) => {
          // A client-supplied kfOrgId must be one the caller actually belongs to
          // — otherwise the org would spoof its way into another institution's KF
          // dashboard (kf-summary trusts organization.kfOrgId). Validate it; on
          // any mismatch, fall through to the server-resolved default.
          if (orgData.kfOrgId) {
            try {
              const { resolveUserKfOrgs } = await import('./auth-internal.server.js')
              const allowed = await resolveUserKfOrgs(user.id, db, schema)
              if (allowed.some((o: { id: string }) => o.id === orgData.kfOrgId)) return
            } catch (err) {
              console.error('[org hook] failed to validate kfOrgId:', err)
            }
          }
          try {
            const { resolveDefaultKfOrgId } = await import('./auth-internal.server.js')
            const kfOrgId = await resolveDefaultKfOrgId(user.id, db, schema)
            return { data: { kfOrgId: kfOrgId ?? undefined } }
          } catch (err) {
            console.error('[org hook] failed to resolve kfOrgId:', err)
          }
          // No valid kfOrgId — ensure the unvalidated client value is not persisted.
          return { data: { kfOrgId: undefined } }
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
      keyExpiration: {
        minExpiresIn: 0,
      },
      rateLimit: {
        enabled: false,
      },
      permissions: {
        defaultPermissions: async (_referenceId, ctx) => {
          // `metadata` is client-controlled, so a caller must NOT be able to
          // grant themselves 'admin' by passing metadata.scope='admin'. Admin
          // keys are minted out-of-band (server-side), never through this
          // self-service create endpoint — cap client-requested scope at write.
          const scope = ctx.body?.metadata?.scope
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
          try {
            await db
              .delete(schema.account)
              .where(
                and(
                  eq(schema.account.userId, account.userId),
                  eq(schema.account.providerId, account.providerId),
                  ne(schema.account.id, account.id),
                ),
              )
          } catch (err) {
            console.error('[auth hook] account.create.after cleanup failed:', err)
          }
          if (account.providerId === 'kf-auth' && account.accessToken) {
            try {
              const res = await fetch(`${KF_AUTH_INTERNAL_URL}/api/auth/oauth2/userinfo`, {
                headers: { Authorization: `Bearer ${account.accessToken}` },
              })
              if (res.ok) {
                const profile = await res.json()
                const updates: Record<string, string> = {}
                if (profile.name) updates.name = profile.name
                if (profile.picture) updates.image = profile.picture
                if (Object.keys(updates).length > 0) {
                  await db
                    .update(schema.user)
                    .set(updates)
                    .where(eq(schema.user.id, account.userId))
                }
              }
            } catch (err) {
              console.error('[auth hook] profile sync failed:', err)
            }
          }
        },
      },
    },
    user: {
      create: {
        after: async (user) => {
          console.log('[auth hook] user.create.after starting for:', user.email)
          try {
            const baseSlug = (user.email.split('@')[0] ?? 'user')
              .toLowerCase()
              .replace(/[^a-z0-9-]/g, '-')
              .replace(/-+/g, '-')
              .slice(0, 30)

            let slug = baseSlug
            let attempt = 0
            while (true) {
              const [conflict] = await db
                .select({ id: schema.organization.id })
                .from(schema.organization)
                .where(eq(schema.organization.slug, slug))
                .limit(1)
              if (!conflict) break
              attempt++
              slug = `${baseSlug}-${attempt}`
            }

            let kfOrgId: string | null = null
            try {
              const { resolveDefaultKfOrgId } = await import('./auth-internal.server.js')
              kfOrgId = await resolveDefaultKfOrgId(user.id, db, schema)
            } catch (err) {
              console.error('[auth hook] failed to resolve kfOrgId for default org:', err)
            }

            const orgId = crypto.randomUUID()
            await db.insert(schema.organization).values({
              id: orgId,
              name: user.name,
              slug,
              isDefault: true,
              ...(kfOrgId ? { kfOrgId } : {}),
            })

            await db.insert(schema.member).values({
              id: crypto.randomUUID(),
              organizationId: orgId,
              userId: user.id,
              role: 'owner',
            })
            console.log(
              '[auth hook] default org created:',
              slug,
              kfOrgId ? `kfOrgId=${kfOrgId}` : '(no kfOrgId)',
            )
          } catch (err) {
            console.error('[auth hook] user.create.after failed:', err)
          }
        },
      },
    },
  },
})

export { KF_AUTH_URL, KF_AUTH_INTERNAL_URL }
