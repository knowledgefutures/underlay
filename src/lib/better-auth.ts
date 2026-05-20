/**
 * Better-auth configuration for OIDC client mode.
 *
 * Uses the genericOAuth plugin to authenticate against KF Auth (or any OIDC provider).
 * Better-auth manages: user table, session table, OAuth account linkage, cookies, CSRF.
 * The app keeps its own `accounts` table (users + orgs domain model) — linked by shared ID.
 */

import crypto from 'node:crypto'

import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { genericOAuth } from 'better-auth/plugins/generic-oauth'
import { eq } from 'drizzle-orm'

import { db, schema } from '../db/client.server.js'

// --- Config (with backward-compat fallbacks) ---

const OIDC_ISSUER_URL =
  process.env.OIDC_ISSUER_URL ?? process.env.KF_AUTH_URL ?? 'http://localhost:3000'

const OIDC_ISSUER_INTERNAL_URL =
  process.env.OIDC_ISSUER_INTERNAL_URL ?? process.env.KF_AUTH_INTERNAL_URL ?? OIDC_ISSUER_URL

const OIDC_CLIENT_ID = process.env.OIDC_CLIENT_ID ?? process.env.KF_AUTH_CLIENT_ID ?? 'kf_underlay'

const OIDC_CLIENT_SECRET = process.env.OIDC_CLIENT_SECRET ?? process.env.KF_AUTH_CLIENT_SECRET ?? ''

const OIDC_ORGS_CLAIM = process.env.OIDC_ORGS_CLAIM ?? 'https://knowledgefutures.org/orgs'

const APP_URL = process.env.APP_URL ?? 'http://localhost:4100'

// --- Temp storage: pass OAuth sub from getUserInfo → user.create.before ---
// Keyed by email to be safe across concurrent requests.
const pendingOAuthSubs = new Map<string, string>()

// --- Account upsert (same logic as before, runs on every login) ---

interface OIDCOrg {
  id: string
  name: string
  slug: string
  type: 'personal' | 'shared'
  role: string
}

async function upsertAccount(profile: Record<string, unknown>) {
  const kfUserId = profile.sub as string
  const orgs = (profile[OIDC_ORGS_CLAIM] ?? []) as OIDCOrg[]
  const personalOrg = orgs.find((o) => o.type === 'personal')

  const [existing] = await db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, kfUserId))
    .limit(1)

  if (existing) {
    // Update personal org link if it changed
    if (personalOrg) {
      await db
        .update(schema.accounts)
        .set({ kfOrgId: personalOrg.id })
        .where(eq(schema.accounts.id, kfUserId))
    }
  } else {
    // Create new account — derive slug from email or name
    const email = profile.email as string | undefined
    const name = profile.name as string | undefined
    const baseSlug = (email?.split('@')[0] ?? name ?? 'user')
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 30)

    // Ensure slug is unique
    let slug = baseSlug
    let attempt = 0
    while (true) {
      const [conflict] = await db
        .select({ id: schema.accounts.id })
        .from(schema.accounts)
        .where(eq(schema.accounts.slug, slug))
        .limit(1)

      if (!conflict) break
      attempt++
      slug = `${baseSlug}-${attempt}`
    }

    await db.insert(schema.accounts).values({
      id: kfUserId,
      slug,
      type: 'user',
      kfOrgId: personalOrg?.id ?? null,
    })
  }
}

// --- Better-auth instance ---

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.oauthAccount,
      verification: schema.verification,
    },
  }),
  baseURL: APP_URL,
  basePath: '/api/auth',
  secret: process.env.SESSION_SECRET ?? 'dev-secret-change-me',

  advanced: {
    database: {
      generateId: () => crypto.randomUUID(),
    },
    cookiePrefix: 'ul',
  },

  plugins: [
    genericOAuth({
      config: [
        {
          providerId: 'kf-auth',
          clientId: OIDC_CLIENT_ID,
          clientSecret: OIDC_CLIENT_SECRET,
          // Browser-facing (user redirect)
          authorizationUrl: `${OIDC_ISSUER_URL}/api/auth/oauth2/authorize`,
          // Server-to-server (code exchange, userinfo)
          tokenUrl: `${OIDC_ISSUER_INTERNAL_URL}/api/auth/oauth2/token`,
          scopes: ['openid', 'profile', 'email'],
          pkce: true,
          getUserInfo: async (tokens) => {
            const res = await fetch(`${OIDC_ISSUER_INTERNAL_URL}/api/auth/oauth2/userinfo`, {
              headers: { Authorization: `Bearer ${tokens.accessToken}` },
            })
            if (!res.ok) throw new Error(`UserInfo failed: ${res.status}`)
            const profile = (await res.json()) as Record<string, unknown>

            // Store sub for user.create.before hook (so user.id = kf auth sub)
            const email = profile.email as string
            const sub = profile.sub as string
            if (email) pendingOAuthSubs.set(email, sub)

            // Upsert the domain `accounts` row (runs every login)
            await upsertAccount(profile)

            return {
              id: sub,
              name: (profile.name as string) ?? undefined,
              email,
              image: (profile.picture as string) ?? undefined,
              emailVerified: !!profile.email_verified,
            }
          },
        },
      ],
    }),
  ],

  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          // Override the generated UUID with the KF Auth sub
          // so that user.id === accounts.id (shared ID space)
          const sub = pendingOAuthSubs.get(user.email)
          if (sub) {
            pendingOAuthSubs.delete(sub)
            return { data: { ...user, id: sub } }
          }
          return { data: user }
        },
      },
    },
  },
})
