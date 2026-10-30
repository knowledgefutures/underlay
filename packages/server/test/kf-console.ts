/**
 * KF Auth as the console's token issuer, without the network: a local EdDSA key,
 * its JWKS served by a stub fetch, and a signer for `KF-Console-Token`s.
 */
import { exportJWK, generateKeyPair, SignJWT } from 'jose'

import { createKf } from '../src/auth/kf.js'
import type { Db } from '../src/ports.js'

export const ISSUER_URL = 'https://kf.test'
export const INTERNAL_URL = 'http://kf-internal'
export const CLIENT_ID = 'kf_underlay'

export interface TokenOptions {
  iss?: string
  aud?: string
  sub?: string
  iat?: number
  exp?: number
  key?: CryptoKey
}

export async function kfConsole(db: Db) {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { extractable: true })
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'EdDSA', use: 'sig' }
  let jwksFetches = 0
  const fetcher = (async (input: RequestInfo | URL) => {
    if (String(input) !== `${INTERNAL_URL}/api/auth/jwks`)
      return new Response('{}', { status: 404 })
    jwksFetches++
    return Response.json({ keys: [jwk] })
  }) as typeof fetch
  const kf = createKf(
    db,
    { issuerUrl: ISSUER_URL, internalUrl: INTERNAL_URL, clientId: CLIENT_ID, clientSecret: 's' },
    fetcher,
  )
  /** A console token for `GET htu`, as KF signs them; `claims` and `opts` change it. */
  const sign = (htu: string, claims: Record<string, unknown> = {}, opts: TokenOptions = {}) => {
    const now = Math.floor(Date.now() / 1000)
    return new SignJWT({ htm: 'GET', htu, ...claims })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'k1', typ: 'JWT' })
      .setIssuer(opts.iss ?? `${ISSUER_URL}/api/auth`)
      .setAudience(opts.aud ?? CLIENT_ID)
      .setSubject(opts.sub ?? 'kf-console')
      .setIssuedAt(opts.iat ?? now)
      .setExpirationTime(opts.exp ?? now + 60)
      .setJti(crypto.randomUUID())
      .sign(opts.key ?? privateKey)
  }
  return { kf, sign, jwksFetches: () => jwksFetches }
}
