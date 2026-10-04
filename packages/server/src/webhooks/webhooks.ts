/**
 * Webhooks: v1's payload, headers and signature, delivered by jobs.
 *
 *   version.published job → one delivery row per enabled, matching webhook →
 *   one webhooks.deliver job per row; failures retry as delayed jobs with
 *   exponential backoff (1 min doubling, capped at 6 h), up to 5 attempts.
 *
 * Receivers verify `x-underlay-signature: sha256=<hex HMAC-SHA256(secret, body)>`.
 *
 * SSRF: URLs are checked at registration (scheme, blocked hostnames, private IP
 * literals). On Workers there is no private network to reach. On Node, the
 * deployment's outbound fetch resolves and refuses private addresses
 * (Ports.outboundFetch).
 */
import { createHmac, randomBytes } from 'node:crypto'

import type { BumpType } from '@underlay/protocol'
import { and, eq, lt } from 'drizzle-orm'

import { chunks } from '../db/chunks.js'
import * as schema from '../db/schema.js'
import { registerJob } from '../jobs.js'
import type { Ports } from '../ports.js'

const DELIVERY_TIMEOUT_MS = 10_000
export const MAX_ATTEMPTS = 5
const BACKOFF_BASE_S = 60
const BACKOFF_CAP_S = 6 * 60 * 60
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const SIGNATURE_HEADER = 'x-underlay-signature'

export const generateWebhookSecret = () => `ulwhsec_${randomBytes(24).toString('hex')}`
export const signPayload = (secret: string, body: string) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`

// --- SSRF checks (ported from v1) ---------------------------------------------------

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

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
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff)
    ? groups
    : null
}

export function ipKind(s: string): 0 | 4 | 6 {
  const m = IPV4.exec(s)
  if (m) return m.slice(1).every((n) => Number(n) <= 255) ? 4 : 0
  return s.includes(':') && parseIPv6(s) ? 6 : 0
}

/** Private, loopback, link-local, CGNAT, benchmarking, multicast, reserved, NAT64 and embedded IPv4. */
export function isPrivateIp(ip: string): boolean {
  const kind = ipKind(ip)
  if (kind === 4) {
    const [a = 0, b = 0] = ip.split('.').map((n) => parseInt(n, 10))
    if (a === 10 || a === 127 || a === 0) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    if (a === 198 && (b === 18 || b === 19)) return true
    return a >= 224
  }
  if (kind === 6) {
    const g = parseIPv6(ip)
    if (!g) return true
    const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g
    if (g.slice(0, 7).every((x) => x === 0) && g7 <= 1) return true
    if ((g0 & 0xffc0) === 0xfe80) return true
    if ((g0 & 0xfe00) === 0xfc00) return true
    if ((g0 & 0xff00) === 0xff00) return true
    if (g0 === 0x64 && g1 === 0xff9b && !g2 && !g3 && !g4 && !g5) return true
    if (!g0 && !g1 && !g2 && !g3 && !g4 && (g5 === 0xffff || g5 === 0)) {
      return isPrivateIp(`${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`)
    }
    return false
  }
  return false
}

const bareHost = (h: string) => (h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h)

export function validateWebhookUrl(
  raw: string,
  allowInsecure: boolean,
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
  const host = bareHost(parsed.hostname).toLowerCase().replace(/\.$/, '')
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return { ok: false, reason: 'Webhook URL host is not allowed' }
  }
  if (ipKind(host) && isPrivateIp(host))
    return { ok: false, reason: 'Webhook URL resolves to a private address' }
  return { ok: true, url: parsed.toString() }
}

// --- Enqueue and deliver ----------------------------------------------------------------

/** After a version is published: a delivery row and a job per matching webhook. */
export async function enqueueDeliveries(
  ports: Ports,
  versionId: string,
  bump: BumpType,
): Promise<number> {
  const { db } = ports
  const [row] = await db
    .select({ v: schema.versions, c: schema.collections, o: schema.organization })
    .from(schema.versions)
    .innerJoin(schema.collections, eq(schema.collections.id, schema.versions.collectionId))
    .innerJoin(schema.organization, eq(schema.organization.id, schema.collections.organizationId))
    .where(eq(schema.versions.id, versionId))
    .limit(1)
  if (!row) return 0
  const hooks = (
    await db
      .select()
      .from(schema.collectionWebhooks)
      .where(
        and(
          eq(schema.collectionWebhooks.collectionId, row.c.id),
          eq(schema.collectionWebhooks.enabled, true),
        ),
      )
  ).filter((h) => h.bumpFilter.includes(bump))
  if (hooks.length === 0) return 0
  // Idempotent per (webhook, version): a retried job doesn't double-deliver.
  const existing = await db
    .select({ webhookId: schema.webhookDeliveries.webhookId })
    .from(schema.webhookDeliveries)
    .where(eq(schema.webhookDeliveries.versionId, versionId))
  const done = new Set(existing.map((e) => e.webhookId))
  const payload = {
    event: 'version.created',
    collection: { owner: row.o.slug, slug: row.c.slug },
    version: {
      semver: row.v.semver,
      hash: row.v.hash,
      major: row.v.major,
      minor: row.v.minor,
      patch: row.v.patch,
      recordCount: row.v.recordCount,
      fileCount: row.v.fileCount,
    },
    bumpType: bump,
  }
  const fresh = hooks.filter((h) => !done.has(h.id))
  if (fresh.length === 0) return 0
  // A few rows per statement: each binds about 16 parameters, and D1 allows 100.
  const rows: { id: string }[] = []
  for (const part of chunks(fresh, 5)) {
    rows.push(
      ...(await db
        .insert(schema.webhookDeliveries)
        .values(
          part.map((h) => ({
            webhookId: h.id,
            collectionId: row.c.id,
            versionId,
            semver: row.v.semver,
            bumpType: bump,
            payload,
          })),
        )
        .returning({ id: schema.webhookDeliveries.id })),
    )
  }
  await ports.jobs.enqueueBatch(rows.map((r) => ({ type: 'webhooks.deliver', deliveryId: r.id })))
  return rows.length
}

export async function deliver(ports: Ports, deliveryId: string): Promise<void> {
  const { db } = ports
  const [row] = await db
    .select({ d: schema.webhookDeliveries, h: schema.collectionWebhooks })
    .from(schema.webhookDeliveries)
    .innerJoin(
      schema.collectionWebhooks,
      eq(schema.collectionWebhooks.id, schema.webhookDeliveries.webhookId),
    )
    .where(eq(schema.webhookDeliveries.id, deliveryId))
    .limit(1)
  if (!row || row.d.status === 'success') return
  const attempt = row.d.attempts + 1
  const body = JSON.stringify({
    ...row.d.payload,
    delivery: { id: row.d.id, timestamp: new Date().toISOString() },
  })

  const record = async (
    ok: boolean,
    responseCode: number | null,
    error: string | null,
    durationMs: number,
    terminal = false,
  ) => {
    const exhausted = !ok && (terminal || attempt >= MAX_ATTEMPTS)
    const delay = Math.min(BACKOFF_BASE_S * 2 ** (attempt - 1), BACKOFF_CAP_S)
    await db
      .update(schema.webhookDeliveries)
      .set({
        status: ok ? 'success' : 'failed',
        attempts: attempt,
        responseCode,
        error: error?.slice(0, 2000) ?? null,
        durationMs,
        nextAttemptAt: ok || exhausted ? null : new Date(Date.now() + delay * 1000),
        deliveredAt: new Date(),
      })
      .where(eq(schema.webhookDeliveries.id, deliveryId))
    if (ok) {
      await db
        .update(schema.collectionWebhooks)
        .set({ lastDeliveryAt: new Date() })
        .where(eq(schema.collectionWebhooks.id, row.h.id))
    } else if (!exhausted) {
      await ports.jobs.enqueue({ type: 'webhooks.deliver', deliveryId }, { delaySeconds: delay })
    }
  }

  if (!row.h.enabled) return record(false, null, 'Webhook disabled', 0, true)
  const started = Date.now()
  try {
    const res = await ports.outboundFetch(row.h.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Underlay-Webhook/2.0',
        'x-underlay-event': row.d.event,
        'x-underlay-delivery': row.d.id,
        [SIGNATURE_HEADER]: signPayload(row.h.secret, body),
      },
      body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      redirect: 'manual',
    })
    void res.body?.cancel().catch(() => {})
    await record(res.ok, res.status, res.ok ? null : `HTTP ${res.status}`, Date.now() - started)
  } catch (err) {
    await record(
      false,
      null,
      err instanceof Error ? err.message : String(err),
      Date.now() - started,
    )
  }
}

export async function purgeOldDeliveries(ports: Ports): Promise<void> {
  await ports.db
    .delete(schema.webhookDeliveries)
    .where(lt(schema.webhookDeliveries.createdAt, new Date(Date.now() - RETENTION_MS)))
}

registerJob('webhooks.deliver', async (job, ports) => deliver(ports, String(job.deliveryId)))
