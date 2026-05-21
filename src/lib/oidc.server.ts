/**
 * Generic OIDC client with auto-discovery.
 *
 * Reads endpoints from the provider's .well-known/openid-configuration.
 * Works with any standards-compliant OIDC provider (KF Auth, Keycloak, Auth0, etc.).
 *
 * Env vars:
 *   OIDC_ISSUER_URL          — browser-facing issuer URL
 *   OIDC_ISSUER_INTERNAL_URL — server-to-server URL for Docker (falls back to OIDC_ISSUER_URL)
 *   OIDC_CLIENT_ID           — OAuth client ID
 *   OIDC_CLIENT_SECRET       — OAuth client secret
 *   OIDC_ORGS_CLAIM          — custom claim key for org memberships (default: https://knowledgefutures.org/orgs)
 */

import crypto from 'node:crypto'

// --- Config (with backward-compat fallbacks) ---

const OIDC_ISSUER_URL = process.env.OIDC_ISSUER_URL ?? 'http://localhost:3000'

const OIDC_ISSUER_INTERNAL_URL = process.env.OIDC_ISSUER_INTERNAL_URL ?? OIDC_ISSUER_URL

const OIDC_CLIENT_ID = process.env.OIDC_CLIENT_ID ?? 'kf_underlay'

const OIDC_CLIENT_SECRET = process.env.OIDC_CLIENT_SECRET ?? ''

const OIDC_ORGS_CLAIM = process.env.OIDC_ORGS_CLAIM ?? 'https://knowledgefutures.org/orgs'

const APP_URL = process.env.APP_URL ?? 'http://localhost:4100'
const REDIRECT_URI = `${APP_URL}/auth/callback`

// --- OIDC Discovery ---

interface OIDCDiscovery {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint: string
  jwks_uri?: string
}

let discoveryCache: OIDCDiscovery | null = null
let discoveryPromise: Promise<OIDCDiscovery> | null = null

/**
 * Fetch and cache the OIDC discovery document.
 * Uses the internal URL for server-to-server fetch.
 * Throws if discovery fails — app should not start without valid OIDC config.
 */
async function discover(): Promise<OIDCDiscovery> {
  if (discoveryCache) return discoveryCache
  if (discoveryPromise) return discoveryPromise

  discoveryPromise = (async () => {
    const url = `${OIDC_ISSUER_INTERNAL_URL}/.well-known/openid-configuration`
    const res = await fetch(url)
    if (!res.ok) {
      throw new Error(
        `OIDC discovery failed: ${res.status} from ${url}. ` +
          `Ensure OIDC_ISSUER_URL points to a valid OIDC provider.`,
      )
    }
    const config = (await res.json()) as OIDCDiscovery
    discoveryCache = config
    return config
  })()

  return discoveryPromise
}

/**
 * Initialize OIDC — call at app startup to fail fast if provider is unreachable.
 */
export async function initOidc(): Promise<void> {
  await discover()
}

/**
 * Rewrite a discovered endpoint URL to use the internal host.
 * Discovery may return URLs with the public host (BETTER_AUTH_URL),
 * but server-to-server calls must use OIDC_ISSUER_INTERNAL_URL.
 */
function internalEndpoint(discoveredUrl: string): string {
  const url = new URL(discoveredUrl)
  const base = new URL(OIDC_ISSUER_INTERNAL_URL)
  url.protocol = base.protocol
  url.host = base.host
  return url.toString()
}

// --- PKCE helpers ---

/** Generate a random code_verifier (43–128 chars, URL-safe). */
export function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url')
}

/** Derive the S256 code_challenge from a code_verifier. */
export function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url')
}

// --- OIDC Flows ---

/**
 * Build the URL to redirect the user to for authentication.
 * Uses the discovered authorization_endpoint.
 * Returns the URL and the PKCE code_verifier (must be stored server-side).
 */
export async function buildAuthorizeUrl(
  state: string,
): Promise<{ url: string; codeVerifier: string }> {
  const config = await discover()
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = generateCodeChallenge(codeVerifier)

  // Use the browser-facing issuer URL for authorize (user's browser navigates here)
  // Discovery may return an internal URL, so construct from OIDC_ISSUER_URL + path
  const authorizeUrl = new URL(config.authorization_endpoint)
  // Replace host with the browser-facing URL if discovery returned an internal one
  const browserBase = new URL(OIDC_ISSUER_URL)
  authorizeUrl.protocol = browserBase.protocol
  authorizeUrl.host = browserBase.host

  const params = new URLSearchParams({
    client_id: OIDC_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'openid profile email',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  })

  return { url: `${authorizeUrl.toString()}?${params}`, codeVerifier }
}

export interface TokenResponse {
  access_token: string
  token_type: string
  expires_in: number
  id_token?: string
  refresh_token?: string
}

/**
 * Exchange an authorization code for tokens.
 * Uses the discovered token_endpoint (server-to-server).
 */
export async function exchangeCode(code: string, codeVerifier: string): Promise<TokenResponse> {
  const config = await discover()
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: OIDC_CLIENT_ID,
    client_secret: OIDC_CLIENT_SECRET,
    code_verifier: codeVerifier,
  })

  const res = await fetch(internalEndpoint(config.token_endpoint), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Token exchange failed: ${res.status} ${text}`)
  }

  return res.json() as Promise<TokenResponse>
}

export interface OIDCOrg {
  id: string
  name: string
  slug: string
  type: 'personal' | 'shared'
  role: string
}

export interface OIDCUserInfo {
  sub: string
  name?: string
  email?: string
  picture?: string
  [key: string]: unknown
}

/**
 * Fetch user info from the OIDC provider using an access token.
 * Uses the discovered userinfo_endpoint (server-to-server).
 */
export async function fetchUserInfo(accessToken: string): Promise<OIDCUserInfo> {
  const config = await discover()
  const res = await fetch(internalEndpoint(config.userinfo_endpoint), {
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  if (!res.ok) {
    throw new Error(`UserInfo failed: ${res.status}`)
  }

  return res.json() as Promise<OIDCUserInfo>
}

/**
 * Extract org memberships from the userinfo response.
 * Uses the configurable OIDC_ORGS_CLAIM key.
 */
export function extractOrgs(userInfo: OIDCUserInfo): OIDCOrg[] {
  const orgs = userInfo[OIDC_ORGS_CLAIM]
  if (Array.isArray(orgs)) return orgs as OIDCOrg[]
  return []
}

// --- Exports ---

export {
  OIDC_ISSUER_URL,
  OIDC_ISSUER_INTERNAL_URL,
  OIDC_CLIENT_ID,
  OIDC_CLIENT_SECRET,
  OIDC_ORGS_CLAIM,
  APP_URL,
  REDIRECT_URI,
}
