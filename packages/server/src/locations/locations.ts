/**
 * Storage locations a customer adds for mirrors (edge-redesign.md, "Placements":
 * Credentials and verification).
 *
 * - Credentials are encrypted with the deployment's LOCATION_KEY (AES-GCM) and
 *   never returned to clients.
 * - A location's credentials read and write: the check reads back what it wrote.
 * - The signing region comes from the endpoint, and the check corrects it when
 *   the bucket names another one (S3 answers with `x-amz-bucket-region`).
 * - An endpoint is a user-supplied URL: it must be https, and its host may not
 *   be a private name or address (dev and test deployments allow local http).
 *   Requests to it go through `ports.locationFetch`, which on Node also refuses
 *   hosts that resolve to private addresses.
 * - The setup check writes a small object under the prefix, reads it back, and
 *   tries an anonymous read: a location that serves objects to anyone is
 *   flagged public, and may hold public sets only.
 */
import { type LifecycleRule, PrefixedStore, S3Store, type Store, s3Store } from '@underlay/protocol'
import { and, asc, eq, isNull, lt, ne, or } from 'drizzle-orm'

import * as schema from '../db/schema.js'
import { registerJob } from '../jobs.js'
import type { Ports } from '../ports.js'
import { ipKind, isPrivateIp } from '../webhooks/webhooks.js'

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
    region: loc.region ?? regionFor(loc.endpoint!),
    fetch: fetchFor(ports),
  })
  return loc.prefix ? new PrefixedStore(store, loc.prefix) : store
}

export const locationChecks = { everyMs: 24 * 60 * 60 * 1000, perSweep: 3 }

/**
 * Re-check customer locations not checked for a day, a few at a time (the cron
 * sweep): credentials get revoked, buckets change, lifecycle rules appear.
 */
export async function recheckLocations(ports: Ports): Promise<number> {
  const due = await ports.db
    .select({ id: schema.storageLocations.id })
    .from(schema.storageLocations)
    .where(
      and(
        eq(schema.storageLocations.kind, 's3'),
        ne(schema.storageLocations.status, 'disabled'),
        or(
          isNull(schema.storageLocations.checkedAt),
          lt(schema.storageLocations.checkedAt, new Date(Date.now() - locationChecks.everyMs)),
        ),
      ),
    )
    .orderBy(asc(schema.storageLocations.checkedAt))
    .limit(locationChecks.perSweep)
  await ports.jobs.enqueueBatch(due.map((l) => ({ type: 'locations.check', locationId: l.id })))
  return due.length
}

registerJob('locations.check', async (job, ports) => {
  const [loc] = await ports.db
    .select()
    .from(schema.storageLocations)
    .where(eq(schema.storageLocations.id, String(job.locationId)))
  if (loc && loc.kind === 's3' && loc.status !== 'disabled') await checkLocation(ports, loc)
})

/** Validate a customer endpoint URL: a plain https origin on a public host. */
export function checkEndpoint(endpoint: unknown, allowLocal = false): string | null {
  if (typeof endpoint !== 'string') return '"endpoint" must be a URL'
  let u: URL
  try {
    u = new URL(endpoint)
  } catch {
    return '"endpoint" must be a URL'
  }
  if (u.protocol !== 'https:' && !(allowLocal && u.protocol === 'http:'))
    return '"endpoint" must be https'
  if (u.username || u.password || u.search || u.hash) return '"endpoint" must be a plain origin'
  if (allowLocal) return null
  const host = u.hostname
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.$/, '')
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    !host.includes('.') ||
    (ipKind(host) && isPrivateIp(host))
  ) {
    return '"endpoint" must be a public host'
  }
  return null
}

/**
 * The signing region an endpoint implies: AWS and most S3-compatible hosts name
 * it (`s3.eu-west-2.amazonaws.com`, `s3.us-west-004.backblazeb2.com`), R2 signs
 * with `auto`, and anything else gets us-east-1, which S3-compatible servers
 * accept by default. The location check corrects it from the bucket's answer.
 */
export function regionFor(endpoint: string): string {
  let host: string
  try {
    host = new URL(endpoint).hostname.toLowerCase()
  } catch {
    return 'us-east-1'
  }
  if (host.endsWith('.r2.cloudflarestorage.com')) return 'auto'
  const named = /(?:^|\.)s3[.-](?:dualstack\.)?([a-z]{2}(?:-[a-z]+)+-\d+)\./.exec(host)
  return named?.[1] ?? 'us-east-1'
}

/**
 * The region a bucket says it's in. S3 sends `x-amz-bucket-region` on a HEAD of
 * the bucket, even when it refuses the request; other servers send nothing.
 */
async function bucketRegion(ports: Ports, loc: LocationRow): Promise<string | null> {
  const url = `${loc.endpoint!.replace(/\/+$/, '')}/${encodeURIComponent(loc.bucket!)}`
  const res = await fetchFor(ports)(new Request(url, { method: 'HEAD' })).catch(() => null)
  await res?.body?.cancel()
  const region = res?.headers.get('x-amz-bucket-region')?.trim()
  return region && /^[a-z0-9-]{1,64}$/.test(region) ? region : null
}

export interface CheckResult {
  ok: boolean
  /** Objects under the prefix can be read without credentials. */
  publicRead: boolean
  readBack: boolean
  error: string | null
  /** Things that don't stop mirroring but should be fixed (a lifecycle rule we can't read, say). */
  warnings: string[]
}

/**
 * Bucket lifecycle rules that touch a location's prefix. A rule that expires
 * objects there would delete what mirrors wrote: the check fails. One that moves
 * them to another storage class, or rules these credentials can't read, warn.
 */
async function lifecycleProblems(store: Store, prefix: string) {
  const s3 = store instanceof PrefixedStore ? store.inner : store
  if (!(s3 instanceof S3Store)) return { error: null, warnings: [] as string[] }
  const rules = await s3.lifecycleRules()
  const where = prefix ? `${prefix.replace(/\/+$/, '')}/` : ''
  const shown = where || 'the whole bucket'
  if (rules === 'none') return { error: null, warnings: [] }
  if (rules === 'unreadable') {
    return {
      error: null,
      warnings: [
        `These credentials can't read the bucket's lifecycle rules; make sure none deletes objects under ${shown}.`,
      ],
    }
  }
  const touches = (r: LifecycleRule) => where.startsWith(r.prefix) || r.prefix.startsWith(where)
  const deleting = rules.filter((r) => r.expires && touches(r))
  const moving = rules.filter((r) => r.transitions && touches(r))
  return {
    error: deleting.length
      ? `Lifecycle rule ${deleting.map((r) => `"${r.id || r.prefix || '(unnamed)'}"`).join(', ')} deletes objects under ${shown}, where mirrors write. Exclude it from the rule.`
      : null,
    warnings: moving.map(
      (r) =>
        `Lifecycle rule "${r.id || r.prefix || '(unnamed)'}" moves objects under ${shown} to another storage class, where reads may fail.`,
    ),
  }
}

const CHECK_KEY = '.underlay/check.json'

/** Write the check object; on a failure, retry once in the region the bucket names. */
async function writeCheck(ports: Ports, loc: LocationRow, body: string) {
  try {
    const store = await locationStore(ports, loc)
    await store.put(CHECK_KEY, body, { contentType: 'application/json' })
    return { store, loc }
  } catch (err) {
    const region = await bucketRegion(ports, loc)
    if (!region || region === loc.region) throw err
    const moved = { ...loc, region }
    const store = await locationStore(ports, moved)
    await store.put(CHECK_KEY, body, { contentType: 'application/json' })
    await ports.db
      .update(schema.storageLocations)
      .set({ region })
      .where(eq(schema.storageLocations.id, loc.id))
    return { store, loc: moved }
  }
}

/** Write, read back and probe for anonymous reads; record the outcome. */
export async function checkLocation(ports: Ports, loc: LocationRow): Promise<CheckResult> {
  const result: CheckResult = {
    ok: false,
    publicRead: false,
    readBack: false,
    error: null,
    warnings: [],
  }
  try {
    const nonce = crypto.randomUUID()
    const written = await writeCheck(
      ports,
      loc,
      JSON.stringify({ nonce, at: new Date().toISOString() }),
    )
    const store = written.store
    loc = written.loc
    const back = await store.get(CHECK_KEY)
    if (!back || !(await back.text()).includes(nonce)) {
      throw new LocationError('Wrote a check object but could not read it back')
    }
    result.readBack = true
    const key = [loc.prefix, CHECK_KEY].filter(Boolean).join('/')
    const url = `${loc.endpoint!.replace(/\/+$/, '')}/${loc.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`
    const anon = await fetchFor(ports)(new Request(url)).catch(() => null)
    result.publicRead = anon?.ok === true
    await anon?.body?.cancel()
    const lifecycle = await lifecycleProblems(store, loc.prefix)
    result.warnings.push(...lifecycle.warnings)
    if (lifecycle.error) throw new LocationError(lifecycle.error)
    result.ok = true
  } catch (err) {
    result.error = (err as Error).message.slice(0, 500)
  }
  await ports.db
    .update(schema.storageLocations)
    .set({
      status: result.ok ? 'active' : 'broken',
      // A working location keeps its warnings where the page shows problems.
      lastError:
        result.error ?? (result.warnings.length ? `Warning: ${result.warnings.join(' ')}` : null),
      checkedAt: new Date(),
      ...(result.ok ? { verifiedAt: new Date() } : {}),
    })
    .where(eq(schema.storageLocations.id, loc.id))
  return result
}
