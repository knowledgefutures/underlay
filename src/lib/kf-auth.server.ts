/**
 * Lightweight OIDC client for KF Auth.
 *
 * Two base URLs:
 *   KF_AUTH_URL          — browser-facing (e.g. localhost:3000)
 *   KF_AUTH_INTERNAL_URL — server-to-server (e.g. host.docker.internal:3000 in Docker)
 *                          Falls back to KF_AUTH_URL when not set (production).
 */

import crypto from 'node:crypto'

const KF_AUTH_URL = process.env.KF_AUTH_URL ?? 'http://localhost:3000'
const KF_AUTH_INTERNAL_URL = process.env.KF_AUTH_INTERNAL_URL ?? KF_AUTH_URL
const KF_AUTH_CLIENT_ID = process.env.KF_AUTH_CLIENT_ID ?? 'kf_underlay'
const KF_AUTH_CLIENT_SECRET = process.env.KF_AUTH_CLIENT_SECRET ?? ''
const APP_URL = process.env.APP_URL ?? 'http://localhost:4100'
const REDIRECT_URI = `${APP_URL}/auth/callback`

// BetterAuth OIDC endpoints (well-known paths)
const AUTHORIZE_PATH = '/api/auth/oauth2/authorize'
const TOKEN_PATH = '/api/auth/oauth2/token'
const USERINFO_PATH = '/api/auth/oauth2/userinfo'

// --- PKCE helpers ---

/** Generate a random code_verifier (43–128 chars, URL-safe). */
export function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url')
}

/** Derive the S256 code_challenge from a code_verifier. */
export function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url')
}

/**
 * Build the URL to redirect the user to for authentication.
 * Uses KF_AUTH_URL (browser-facing).
 * Returns the URL and the PKCE code_verifier (must be stored server-side).
 */
export function buildAuthorizeUrl(state: string): { url: string; codeVerifier: string } {
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = generateCodeChallenge(codeVerifier)
  const params = new URLSearchParams({
    client_id: KF_AUTH_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'openid profile email',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  })
  return { url: `${KF_AUTH_URL}${AUTHORIZE_PATH}?${params}`, codeVerifier }
}

interface TokenResponse {
  access_token: string
  token_type: string
  expires_in: number
  id_token?: string
  refresh_token?: string
}

/**
 * Exchange an authorization code for tokens.
 * Uses KF_AUTH_INTERNAL_URL (server-to-server).
 */
export async function exchangeCode(code: string, codeVerifier: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: KF_AUTH_CLIENT_ID,
    client_secret: KF_AUTH_CLIENT_SECRET,
    code_verifier: codeVerifier,
  })

  const res = await fetch(`${KF_AUTH_INTERNAL_URL}${TOKEN_PATH}`, {
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

export interface KFOrg {
  id: string
  name: string
  slug: string
  type: 'personal' | 'shared'
  role: string
}

export interface KFUserInfo {
  sub: string
  name?: string
  email?: string
  picture?: string
  'https://knowledgefutures.org/orgs'?: KFOrg[]
}

/**
 * Fetch user info from KF Auth using an access token.
 * Uses KF_AUTH_INTERNAL_URL (server-to-server).
 */
export async function fetchUserInfo(accessToken: string): Promise<KFUserInfo> {
  const res = await fetch(`${KF_AUTH_INTERNAL_URL}${USERINFO_PATH}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  if (!res.ok) {
    throw new Error(`UserInfo failed: ${res.status}`)
  }

  return res.json() as Promise<KFUserInfo>
}

export { KF_AUTH_CLIENT_ID, KF_AUTH_URL, REDIRECT_URI }
