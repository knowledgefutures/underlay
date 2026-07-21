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
import { isIP } from 'node:net'

import { and, eq, inArray, lt, lte, or, sql } from 'drizzle-orm'

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

/** Private / loopback / link-local / unique-local ranges that must never be POSTed to. */
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
    return false
  }
  if (kind === 6) {
    const norm = ip.toLowerCase()
    if (norm === '::1' || norm === '::') return true

    const firstVal = parseInt(norm.split(':')[0] || '0', 16)
    if (!Number.isNaN(firstVal) && (firstVal & 0xffc0) === 0xfe80) return true // link-local fe80::/10

    if (norm.startsWith('fc') || norm.startsWith('fd')) return true // unique-local
    // IPv4-mapped (::ffff:a.b.c.d)
    const mapped = norm.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) return isPrivateIp(mapped[1]!)
    return false
  }
  return false
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
  const host = parsed.hostname
  if (isBlockedHostname(host)) {
    return { ok: false, reason: 'Webhook URL host is not allowed' }
  }
  // Literal IP in the URL — reject private ranges up front.
  if (isIP(host) && isPrivateIp(host)) {
    return { ok: false, reason: 'Webhook URL resolves to a private address' }
  }
  return { ok: true, url: parsed.toString() }
}

/**
 * Delivery-time SSRF check: resolve the hostname and reject if any resolved
 * address is private. Catches DNS names that point at internal infrastructure.
 */
async function assertResolvesPublic(hostname: string): Promise<void> {
  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error('Webhook host resolves to a private address')
    return
  }
  const { lookup } = await import('node:dns/promises')
  const results = await lookup(hostname, { all: true })
  for (const { address } of results) {
    if (isPrivateIp(address)) throw new Error('Webhook host resolves to a private address')
  }
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
    const { hostname } = new URL(row.url)
    await assertResolvesPublic(hostname)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(row.url, {
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
        redirect: 'error',
      })
    } finally {
      clearTimeout(timer)
    }

    const durationMs = Date.now() - startedAt
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
    const message = err instanceof Error ? err.message : String(err)
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
