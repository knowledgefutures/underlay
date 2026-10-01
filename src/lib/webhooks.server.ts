/**
 * Webhook delivery — fire registered endpoints when a new version is created.
 *
 * Flow:
 *  1. At version commit, `enqueueWebhookDeliveries` writes a `pending` row per
 *     matching (enabled, bump-filter) webhook. Cheap and durable; never blocks
 *     the commit response.
 *  2. The commit handler kicks off `dispatchDeliveries` without awaiting — a
 *     best-effort immediate attempt.
 *  3. `runRetrySweep` (in-process interval, started from server.ts) retries
 *     rows that are still pending (e.g. after a restart) or failed and due,
 *     with exponential backoff up to MAX_ATTEMPTS.
 *  4. `purgeOldDeliveries` drops rows older than the retention window. Wired
 *     both as an in-process daily interval and as `tool:pruneWebhookLogs`.
 *
 * Framework-free: no Hono/React imports, callable from routes, intervals, and
 * the cron tool alike.
 */
import crypto from 'node:crypto'
import dns from 'node:dns'
import { isIP, type LookupFunction } from 'node:net'

import { and, eq, inArray, lt, lte, or, sql } from 'drizzle-orm'
import { Agent, fetch as undiciFetch } from 'undici'

import { db, schema } from '../db/client.server.js'

const DELIVERY_TIMEOUT_MS = 10_000
const MAX_ATTEMPTS = 5
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
const SWEEP_INTERVAL_MS = 60_000
const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000
const SWEEP_BATCH = 100
const BACKOFF_BASE_MS = 60_000 // 1 min
const BACKOFF_CAP_MS = 6 * 60 * 60 * 1000 // 6 h
const SIGNATURE_HEADER = 'x-underlay-signature'

export type BumpType = 'major' | 'minor' | 'patch'

export interface WebhookVersionInfo {
  id: number
  semver: string
  hash: string
  major: number
  minor: number
  patch: number
  recordCount: number
  fileCount: number
}

// --- SSRF protection ---

/** Parse an IPv6 literal (already validated by isIP) into its eight 16-bit groups. */
function parseIPv6(ip: string): number[] | null {
  let s = ip.toLowerCase()
  const zone = s.indexOf('%')
  if (zone !== -1) s = s.slice(0, zone)
  const dotted = s.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (dotted) {
    const [a = 0, b = 0, c = 0, d = 0] = dotted.slice(1).map((n) => parseInt(n, 10))
    s = `${s.slice(0, -dotted[0].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves[1] ? halves[1].split(':') : []
  const fill = 8 - head.length - tail.length
  if (halves.length === 1 ? fill !== 0 : fill < 0) return null
  const groups = [...head, ...Array<string>(fill).fill('0'), ...tail].map((g) => parseInt(g, 16))
  return groups.length === 8 && groups.every((g) => Number.isInteger(g)) ? groups : null
}

/**
 * Addresses that must never be POSTed to: private, loopback, link-local,
 * unique-local, carrier-grade NAT, benchmarking, multicast and reserved ranges,
 * plus NAT64 (64:ff9b::/96) and IPv6 forms that embed an IPv4 address.
 */
export function isPrivateIp(ip: string): boolean {
  const kind = isIP(ip)
  if (kind === 4) {
    const [a = 0, b = 0] = ip.split('.').map((n) => parseInt(n, 10))
    if (a === 10) return true
    if (a === 127) return true
    if (a === 0) return true
    if (a === 169 && b === 254) return true // link-local (incl. cloud metadata 169.254.169.254)
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true // carrier-grade NAT
    if (a === 198 && (b === 18 || b === 19)) return true // benchmarking 198.18.0.0/15
    if (a >= 224) return true // multicast 224/4 and reserved 240/4 (incl. broadcast)
    return false
  }
  if (kind === 6) {
    const g = parseIPv6(ip)
    if (!g) return true // unparseable: fail closed
    const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g
    if (g.slice(0, 7).every((x) => x === 0) && g7 <= 1) return true // :: and ::1
    if ((g0 & 0xffc0) === 0xfe80) return true // link-local fe80::/10
    if ((g0 & 0xfe00) === 0xfc00) return true // unique-local fc00::/7
    if ((g0 & 0xff00) === 0xff00) return true // multicast ff00::/8
    if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return true // NAT64 64:ff9b::/96
    // IPv4-mapped (::ffff:a.b.c.d) and deprecated IPv4-compatible (::a.b.c.d)
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) {
      return isPrivateIp(`${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`)
    }
    return false
  }
  return false
}

/** `URL.hostname` keeps the brackets around IPv6 literals; strip them for isIP. */
function bareHost(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '')
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h.endsWith('.local') || h.endsWith('.internal')) return true
  return false
}

/**
 * Validate a webhook URL for shape and obvious SSRF vectors. Syntactic checks
 * only (no DNS) — safe to call synchronously at save time. `allowInsecure`
 * permits http:// outside production for local testing.
 */
export function validateWebhookUrl(
  raw: string,
  { allowInsecure = process.env.NODE_ENV !== 'production' } = {},
): { ok: true; url: string } | { ok: false; reason: string } {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return { ok: false, reason: 'Invalid URL' }
  }
  if (parsed.protocol !== 'https:' && !(allowInsecure && parsed.protocol === 'http:')) {
    return { ok: false, reason: 'Webhook URL must use https' }
  }
  const host = bareHost(parsed.hostname)
  if (isBlockedHostname(host)) {
    return { ok: false, reason: 'Webhook URL host is not allowed' }
  }
  // Literal IP in the URL — reject private ranges up front.
  if (isIP(host) && isPrivateIp(host)) {
    return { ok: false, reason: 'Webhook URL resolves to a private address' }
  }
  return { ok: true, url: parsed.toString() }
}

class BlockedAddressError extends Error {
  constructor() {
    super('Webhook host resolves to a private address')
    this.name = 'BlockedAddressError'
  }
}

type ResolvedAddress = { address: string; family: number }
type Resolver = (hostname: string, options: dns.LookupOptions) => Promise<ResolvedAddress[]>

const resolveAll: Resolver = (hostname, options) =>
  dns.promises.lookup(hostname, { ...options, all: true })

/**
 * A `net.connect` lookup that fails the connection if any resolved address is
 * blocked, and otherwise hands back exactly the addresses it checked. Checking
 * here, rather than in a separate step before `fetch`, means the socket connects
 * to the address that was validated — a DNS answer that changes between check
 * and connect (rebinding) can't slip through.
 */
export function createCheckedLookup(
  resolve: Resolver = resolveAll,
  isBlocked: (ip: string) => boolean = isPrivateIp,
): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, options).then(
      (addresses) => {
        if (addresses.length === 0 || addresses.some(({ address }) => isBlocked(address))) {
          return callback(new BlockedAddressError(), '', 0)
        }
        if (options.all) return callback(null, addresses)
        callback(null, addresses[0]!.address, addresses[0]!.family)
      },
      (err: NodeJS.ErrnoException) => callback(err, '', 0),
    )
  }
}

/**
 * An undici Agent whose connections only go to addresses that passed the SSRF
 * check. TLS SNI and the Host header still use the original hostname.
 */
export function createPinnedAgent(lookup = createCheckedLookup()): Agent {
  return new Agent({ connect: { lookup } })
}

const pinnedAgent = createPinnedAgent()

type WebhookFetchResult = Awaited<ReturnType<typeof undiciFetch>>

/**
 * `fetch` for webhook targets: connections are pinned to checked addresses and
 * redirects are errors. Literal-IP hosts never reach the Agent's lookup, so
 * private ones are rejected here before connecting.
 */
export async function webhookFetch(
  url: string,
  init: NonNullable<Parameters<typeof undiciFetch>[1]>,
  dispatcher: Agent = pinnedAgent,
): Promise<WebhookFetchResult> {
  const host = bareHost(new URL(url).hostname)
  if (isIP(host) && isPrivateIp(host)) throw new BlockedAddressError()
  return undiciFetch(url, { ...init, dispatcher, redirect: 'error' })
}

// --- Signing ---

export function signPayload(secret: string, body: string): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`
}

export function generateWebhookSecret(): string {
  return `ulwhsec_${crypto.randomBytes(24).toString('hex')}`
}

// --- Enqueue ---

/** drizzle db or a transaction handle — both expose the same query builder. */
type Executor = typeof db

/** Precedence-based bump type from the change flags used by deriveSemver. */
export function bumpTypeFromChanges(schemaChanged: boolean, recordsChanged: boolean): BumpType {
  if (schemaChanged) return 'major'
  if (recordsChanged) return 'minor'
  return 'patch'
}

/**
 * Insert a `pending` delivery row for every enabled webhook on the collection
 * whose bump filter includes `bumpType`. Returns the new delivery ids (for
 * immediate dispatch). Never throws into the caller's critical path — resolve
 * failures are surfaced by the caller's try/catch.
 */
export async function enqueueWebhookDeliveries(
  version: WebhookVersionInfo,
  bumpType: BumpType,
  collectionId: string,
  exec: Executor = db,
): Promise<string[]> {
  const hooks = await exec
    .select({ id: schema.collectionWebhooks.id, bumpFilter: schema.collectionWebhooks.bumpFilter })
    .from(schema.collectionWebhooks)
    .where(
      and(
        eq(schema.collectionWebhooks.collectionId, collectionId),
        eq(schema.collectionWebhooks.enabled, true),
      ),
    )

  const matching = hooks.filter((h) => h.bumpFilter.includes(bumpType))
  if (matching.length === 0) return []

  const owner = await resolveOwnerSlug(collectionId, exec)
  if (!owner) return []

  const payload = {
    event: 'version.created',
    collection: { owner: owner.orgSlug, slug: owner.collectionSlug },
    version: {
      semver: version.semver,
      hash: version.hash,
      major: version.major,
      minor: version.minor,
      patch: version.patch,
      recordCount: version.recordCount,
      fileCount: version.fileCount,
    },
    bumpType,
  }

  const rows = await exec
    .insert(schema.webhookDeliveries)
    .values(
      matching.map((h) => ({
        webhookId: h.id,
        collectionId,
        versionId: version.id,
        semver: version.semver,
        bumpType,
        event: 'version.created',
        payload,
        status: 'pending' as const,
      })),
    )
    .returning({ id: schema.webhookDeliveries.id })

  return rows.map((r) => r.id)
}

async function resolveOwnerSlug(
  collectionId: string,
  exec: Executor = db,
): Promise<{ orgSlug: string; collectionSlug: string } | null> {
  const [row] = await exec
    .select({
      orgSlug: schema.organization.slug,
      collectionSlug: schema.collections.slug,
    })
    .from(schema.collections)
    .innerJoin(schema.organization, eq(schema.collections.organizationId, schema.organization.id))
    .where(eq(schema.collections.id, collectionId))
    .limit(1)
  return row ?? null
}

// --- Delivery ---

/** Deliver a single row by id. Records the outcome; never throws. */
export async function deliverOne(deliveryId: string): Promise<void> {
  const [row] = await db
    .select({
      id: schema.webhookDeliveries.id,
      attempts: schema.webhookDeliveries.attempts,
      status: schema.webhookDeliveries.status,
      event: schema.webhookDeliveries.event,
      payload: schema.webhookDeliveries.payload,
      webhookId: schema.webhookDeliveries.webhookId,
      url: schema.collectionWebhooks.url,
      secret: schema.collectionWebhooks.secret,
      enabled: schema.collectionWebhooks.enabled,
    })
    .from(schema.webhookDeliveries)
    .innerJoin(
      schema.collectionWebhooks,
      eq(schema.webhookDeliveries.webhookId, schema.collectionWebhooks.id),
    )
    .where(eq(schema.webhookDeliveries.id, deliveryId))
    .limit(1)

  if (!row) return
  if (row.status === 'success') return

  const attempt = row.attempts + 1
  const deliveryTimestamp = new Date()

  if (!row.enabled) {
    await markFailed(deliveryId, attempt, null, 'Webhook disabled', 0, /* terminal */ true)
    return
  }

  const body = JSON.stringify({
    ...(row.payload as Record<string, unknown>),
    delivery: { id: row.id, timestamp: deliveryTimestamp.toISOString() },
  })

  const startedAt = Date.now()
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS)
    let res: WebhookFetchResult
    try {
      res = await webhookFetch(row.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Underlay-Webhook/1.0',
          'X-Underlay-Event': String(row.event),
          'X-Underlay-Delivery': row.id,
          [SIGNATURE_HEADER]: signPayload(row.secret, body),
        },
        body,
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }

    const durationMs = Date.now() - startedAt
    // Release the pooled connection; we never read the response body.
    void res.body?.cancel().catch(() => {})
    if (res.ok) {
      await db
        .update(schema.webhookDeliveries)
        .set({
          status: 'success',
          attempts: attempt,
          responseCode: res.status,
          error: null,
          durationMs,
          nextAttemptAt: null,
          deliveredAt: new Date(),
        })
        .where(eq(schema.webhookDeliveries.id, deliveryId))
      await db
        .update(schema.collectionWebhooks)
        .set({ lastDeliveryAt: new Date() })
        .where(eq(schema.collectionWebhooks.id, row.webhookId))
    } else {
      await markFailed(deliveryId, attempt, res.status, `HTTP ${res.status}`, durationMs)
    }
  } catch (err) {
    const durationMs = Date.now() - startedAt
    // undici wraps lookup failures as `TypeError: fetch failed`; keep the blocked-address reason.
    const reason =
      err instanceof Error && err.cause instanceof BlockedAddressError ? err.cause : err
    const message = reason instanceof Error ? reason.message : String(reason)
    await markFailed(deliveryId, attempt, null, message, durationMs)
  }
}

async function markFailed(
  deliveryId: string,
  attempt: number,
  responseCode: number | null,
  error: string,
  durationMs: number,
  terminal = false,
): Promise<void> {
  const exhausted = terminal || attempt >= MAX_ATTEMPTS
  const backoff = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_CAP_MS)
  await db
    .update(schema.webhookDeliveries)
    .set({
      status: 'failed',
      attempts: attempt,
      responseCode,
      error: error.slice(0, 2000),
      durationMs,
      // Once exhausted, stop scheduling retries (sweep filters on attempts < MAX).
      nextAttemptAt: exhausted ? null : new Date(Date.now() + backoff),
      deliveredAt: new Date(),
    })
    .where(eq(schema.webhookDeliveries.id, deliveryId))
}

/** Fire-and-forget dispatch of freshly enqueued deliveries. */
export function dispatchDeliveries(ids: string[]): void {
  if (ids.length === 0) return
  void Promise.allSettled(ids.map((id) => deliverOne(id)))
}

/** Reset a delivery for an immediate manual retry. Returns false if not retriable/not found. */
export async function retryDelivery(deliveryId: string, collectionId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.webhookDeliveries.id })
    .from(schema.webhookDeliveries)
    .where(
      and(
        eq(schema.webhookDeliveries.id, deliveryId),
        eq(schema.webhookDeliveries.collectionId, collectionId),
      ),
    )
    .limit(1)
  if (!row) return false
  // Give it a fresh attempt budget and dispatch now.
  await db
    .update(schema.webhookDeliveries)
    .set({ status: 'pending', attempts: 0, nextAttemptAt: null })
    .where(eq(schema.webhookDeliveries.id, deliveryId))
  dispatchDeliveries([deliveryId])
  return true
}

// --- Background jobs ---

/** Pick up due, non-terminal deliveries and (re)attempt them. */
export async function runRetrySweep(): Promise<number> {
  const now = new Date()
  const due = await db
    .select({ id: schema.webhookDeliveries.id })
    .from(schema.webhookDeliveries)
    .where(
      and(
        inArray(schema.webhookDeliveries.status, ['pending', 'failed']),
        lt(schema.webhookDeliveries.attempts, MAX_ATTEMPTS),
        or(
          sql`${schema.webhookDeliveries.nextAttemptAt} IS NULL`,
          lte(schema.webhookDeliveries.nextAttemptAt, now),
        ),
      ),
    )
    .orderBy(schema.webhookDeliveries.createdAt)
    .limit(SWEEP_BATCH)

  for (const { id } of due) {
    await deliverOne(id)
  }
  return due.length
}

/** Delete deliveries older than the retention window. */
export async function purgeOldDeliveries(): Promise<number> {
  const cutoff = new Date(Date.now() - RETENTION_MS)
  const deleted = await db
    .delete(schema.webhookDeliveries)
    .where(lt(schema.webhookDeliveries.createdAt, cutoff))
    .returning({ id: schema.webhookDeliveries.id })
  return deleted.length
}

let jobsStarted = false

/** Start the in-process retry sweep + purge intervals. Idempotent per process. */
export function startWebhookBackgroundJobs(): void {
  if (jobsStarted) return
  jobsStarted = true

  setInterval(() => {
    runRetrySweep().catch((err) => console.error('[webhooks] retry sweep failed:', err))
  }, SWEEP_INTERVAL_MS).unref()

  setInterval(() => {
    purgeOldDeliveries()
      .then((n) => {
        if (n > 0) console.log(`[webhooks] purged ${n} delivery log row(s) older than 30 days`)
      })
      .catch((err) => console.error('[webhooks] purge failed:', err))
  }, PURGE_INTERVAL_MS).unref()
}
