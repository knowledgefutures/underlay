/**
 * Storage locations a customer adds for mirrors (edge-redesign.md, "Placements":
 * Credentials and verification).
 *
 * - Credentials are encrypted with the deployment's LOCATION_KEY (AES-GCM) and
 *   never returned to clients.
 * - Write-only credentials are enough for a mirror. Read access unlocks the
 *   read-back check, restore, and reading the location as a repository.
 * - Requests to customer endpoints go through `ports.locationFetch`, which on
 *   Node refuses private addresses: an endpoint is a user-supplied URL.
 * - The setup check writes a small object under the prefix, reads it back when
 *   it can, and tries an anonymous read: a location that serves objects to
 *   anyone is flagged public, and may hold public sets only.
 */
import { PrefixedStore, type Store, s3Store } from '@underlay/protocol'
import { eq } from 'drizzle-orm'

import * as schema from '../db/schema.js'
import type { Ports } from '../ports.js'

export type LocationRow = typeof schema.storageLocations.$inferSelect

export interface LocationCredentials {
  accessKeyId: string
  secretAccessKey: string
}

const enc = new TextEncoder()
const dec = new TextDecoder()
const b64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
const unb64 = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))

async function aesKey(ports: Ports): Promise<CryptoKey> {
  if (!ports.locationKey)
    throw new LocationError('LOCATION_KEY is not configured on this deployment')
  const raw = unb64(ports.locationKey)
  if (raw.length !== 32) throw new LocationError('LOCATION_KEY must be 32 bytes, base64url')
  return crypto.subtle.importKey('raw', raw as Uint8Array<ArrayBuffer>, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ])
}

export class LocationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LocationError'
  }
}

/** `v1.<iv>.<ciphertext>`, base64url; the location id is authenticated data. */
export async function encryptCredentials(
  ports: Ports,
  locationId: string,
  creds: LocationCredentials,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(locationId) },
    await aesKey(ports),
    enc.encode(JSON.stringify(creds)),
  )
  return `v1.${b64(iv)}.${b64(new Uint8Array(ct))}`
}

export async function decryptCredentials(
  ports: Ports,
  loc: LocationRow,
): Promise<LocationCredentials> {
  const [v, iv, ct] = (loc.credentials ?? '').split('.')
  if (v !== 'v1' || !iv || !ct) throw new LocationError(`Location ${loc.id} has no credentials`)
  const pt = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: unb64(iv) as Uint8Array<ArrayBuffer>,
      additionalData: enc.encode(loc.id),
    },
    await aesKey(ports),
    unb64(ct) as Uint8Array<ArrayBuffer>,
  )
  return JSON.parse(dec.decode(pt)) as LocationCredentials
}

/** A Request as plain fetch arguments (a Request's fields don't spread). */
export async function requestInit(req: Request): Promise<RequestInit> {
  const body = req.body ? await req.arrayBuffer() : null
  return { method: req.method, headers: req.headers, ...(body ? { body } : {}) }
}

/** The fetch for customer endpoints. */
export const fetchFor = (ports: Ports) =>
  ports.locationFetch ??
  (async (req: Request) => ports.outboundFetch(req.url, await requestInit(req)))

/** The repository store of a customer location: its bucket under its prefix. */
export async function locationStore(ports: Ports, loc: LocationRow): Promise<Store> {
  if (loc.kind !== 's3') throw new LocationError(`Location ${loc.id} is not a customer location`)
  const creds = await decryptCredentials(ports, loc)
  const store = s3Store({
    endpoint: loc.endpoint!,
    bucket: loc.bucket!,
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    region: loc.region ?? 'auto',
    fetch: fetchFor(ports),
  })
  return loc.prefix ? new PrefixedStore(store, loc.prefix) : store
}

/** Validate a customer endpoint URL. */
export function checkEndpoint(endpoint: unknown): string | null {
  if (typeof endpoint !== 'string') return '"endpoint" must be a URL'
  let u: URL
  try {
    u = new URL(endpoint)
  } catch {
    return '"endpoint" must be a URL'
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return '"endpoint" must be http(s)'
  if (u.username || u.password || u.search || u.hash) return '"endpoint" must be a plain origin'
  return null
}

export interface CheckResult {
  ok: boolean
  /** Objects under the prefix can be read without credentials. */
  publicRead: boolean
  readBack: boolean
  error: string | null
}

const CHECK_KEY = '.underlay/check.json'

/** Write, read back (when allowed) and probe for anonymous reads; record the outcome. */
export async function checkLocation(ports: Ports, loc: LocationRow): Promise<CheckResult> {
  const result: CheckResult = { ok: false, publicRead: false, readBack: false, error: null }
  try {
    const store = await locationStore(ports, loc)
    const nonce = crypto.randomUUID()
    await store.put(CHECK_KEY, JSON.stringify({ nonce, at: new Date().toISOString() }), {
      contentType: 'application/json',
    })
    if (loc.permissions === 'read_write') {
      const back = await store.get(CHECK_KEY)
      if (!back || !(await back.text()).includes(nonce)) {
        throw new LocationError('Wrote a check object but could not read it back')
      }
      result.readBack = true
    }
    const key = [loc.prefix, CHECK_KEY].filter(Boolean).join('/')
    const url = `${loc.endpoint!.replace(/\/+$/, '')}/${loc.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`
    const anon = await fetchFor(ports)(new Request(url)).catch(() => null)
    result.publicRead = anon?.ok === true
    await anon?.body?.cancel()
    result.ok = true
  } catch (err) {
    result.error = (err as Error).message.slice(0, 500)
  }
  await ports.db
    .update(schema.storageLocations)
    .set({
      status: result.ok ? 'active' : 'broken',
      lastError: result.error,
      ...(result.ok ? { verifiedAt: new Date() } : {}),
    })
    .where(eq(schema.storageLocations.id, loc.id))
  return result
}
