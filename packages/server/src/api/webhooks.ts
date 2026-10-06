/**
 * Webhook management (v1 shapes), mounted at /api/collections. Org owners and
 * admins only.
 *
 *   GET    /:owner/:slug/webhooks
 *   POST   /:owner/:slug/webhooks                         {url, bumpFilter?, enabled?} → secret, once
 *   PATCH  /:owner/:slug/webhooks/:id
 *   DELETE /:owner/:slug/webhooks/:id
 *   POST   /:owner/:slug/webhooks/:id/test                a signed ping, logged as a delivery
 *   GET    /:owner/:slug/webhooks/:id/deliveries?limit
 *   POST   /:owner/:slug/webhooks/:id/deliveries/:deliveryId/retry
 */
import { and, desc, eq } from 'drizzle-orm'
import { type Context, Hono } from 'hono'

import type { AppEnv } from '../app.js'
import * as schema from '../db/schema.js'
import { generateWebhookSecret, validateWebhookUrl } from '../webhooks/webhooks.js'
import { type CollectionAccess, jsonError, requireCollection } from './access.js'

const BUMPS = ['major', 'minor', 'patch'] as const
type Bump = (typeof BUMPS)[number]
const bumpList = (v: unknown): Bump[] | null =>
  Array.isArray(v) && v.length > 0 && v.every((b) => BUMPS.includes(b)) ? (v as Bump[]) : null

const publicFields = {
  id: schema.collectionWebhooks.id,
  url: schema.collectionWebhooks.url,
  bumpFilter: schema.collectionWebhooks.bumpFilter,
  enabled: schema.collectionWebhooks.enabled,
  createdAt: schema.collectionWebhooks.createdAt,
  lastDeliveryAt: schema.collectionWebhooks.lastDeliveryAt,
}

async function requireAdmin(c: Context<AppEnv>): Promise<CollectionAccess | Response> {
  const access = await requireCollection(c, 'write')
  if (access instanceof Response) return access
  if (access.role !== 'owner' && access.role !== 'admin') return jsonError(c, 403, 'Forbidden')
  return access
}

const allowInsecure = (c: Context<AppEnv>) =>
  c.var.config.deployment === 'dev' || c.var.config.deployment === 'test'

export function webhookRoutes() {
  const app = new Hono<AppEnv>()

  app.get('/:owner/:slug/webhooks', async (c) => {
    const access = await requireAdmin(c)
    if (access instanceof Response) return access
    const webhooks = await c.var.ports.db
      .select(publicFields)
      .from(schema.collectionWebhooks)
      .where(eq(schema.collectionWebhooks.collectionId, access.collection.id))
      .orderBy(desc(schema.collectionWebhooks.createdAt))
    return c.json({ webhooks })
  })

  app.post('/:owner/:slug/webhooks', async (c) => {
    const access = await requireAdmin(c)
    if (access instanceof Response) return access
    const body = (await c.req.json().catch(() => null)) as {
      url?: unknown
      bumpFilter?: unknown
      enabled?: unknown
    } | null
    if (typeof body?.url !== 'string') return jsonError(c, 400, '"url" is required')
    const check = validateWebhookUrl(body.url, allowInsecure(c))
    if (!check.ok) return jsonError(c, 422, check.reason)
    const bumpFilter = body.bumpFilter === undefined ? [...BUMPS] : bumpList(body.bumpFilter)
    if (!bumpFilter)
      return jsonError(c, 400, '"bumpFilter" must be a non-empty list of major, minor, patch')
    const secret = generateWebhookSecret()
    const [created] = await c.var.ports.db
      .insert(schema.collectionWebhooks)
      .values({
        collectionId: access.collection.id,
        url: check.url,
        bumpFilter,
        secret,
        enabled: body.enabled !== false,
        createdBy: c.var.principal?.userId ?? null,
      })
      .returning(publicFields)
    return c.json({ ...created, secret }, 201)
  })

  app.patch('/:owner/:slug/webhooks/:id', async (c) => {
    const access = await requireAdmin(c)
    if (access instanceof Response) return access
    const body = (await c.req.json().catch(() => ({}))) as {
      url?: unknown
      bumpFilter?: unknown
      enabled?: unknown
    }
    const set: Partial<typeof schema.collectionWebhooks.$inferInsert> = {}
    if (body.url !== undefined) {
      if (typeof body.url !== 'string') return jsonError(c, 400, '"url" must be a string')
      const check = validateWebhookUrl(body.url, allowInsecure(c))
      if (!check.ok) return jsonError(c, 422, check.reason)
      set.url = check.url
    }
    if (body.bumpFilter !== undefined) {
      const b = bumpList(body.bumpFilter)
      if (!b)
        return jsonError(c, 400, '"bumpFilter" must be a non-empty list of major, minor, patch')
      set.bumpFilter = b
    }
    if (body.enabled !== undefined) set.enabled = body.enabled === true
    if (Object.keys(set).length === 0) return c.json({ ok: true })
    const [updated] = await c.var.ports.db
      .update(schema.collectionWebhooks)
      .set({ ...set, updatedAt: new Date() })
      .where(
        and(
          eq(schema.collectionWebhooks.id, c.req.param('id')),
          eq(schema.collectionWebhooks.collectionId, access.collection.id),
        ),
      )
      .returning(publicFields)
    return updated ? c.json(updated) : jsonError(c, 404, 'Not found')
  })

  app.delete('/:owner/:slug/webhooks/:id', async (c) => {
    const access = await requireAdmin(c)
    if (access instanceof Response) return access
    const deleted = await c.var.ports.db
      .delete(schema.collectionWebhooks)
      .where(
        and(
          eq(schema.collectionWebhooks.id, c.req.param('id')),
          eq(schema.collectionWebhooks.collectionId, access.collection.id),
        ),
      )
      .returning({ id: schema.collectionWebhooks.id })
    return deleted.length ? c.json({ ok: true }) : jsonError(c, 404, 'Not found')
  })

  app.post('/:owner/:slug/webhooks/:id/test', async (c) => {
    const access = await requireAdmin(c)
    if (access instanceof Response) return access
    const { db } = c.var.ports
    const [hook] = await db
      .select({ id: schema.collectionWebhooks.id })
      .from(schema.collectionWebhooks)
      .where(
        and(
          eq(schema.collectionWebhooks.id, c.req.param('id')),
          eq(schema.collectionWebhooks.collectionId, access.collection.id),
        ),
      )
      .limit(1)
    if (!hook) return jsonError(c, 404, 'Not found')
    const [delivery] = await db
      .insert(schema.webhookDeliveries)
      .values({
        webhookId: hook.id,
        collectionId: access.collection.id,
        bumpType: 'patch',
        event: 'ping',
        payload: {
          event: 'ping',
          collection: { owner: access.owner.slug, slug: access.collection.slug },
          version: null,
          bumpType: 'patch',
          test: true,
        },
      })
      .returning({ id: schema.webhookDeliveries.id })
    await c.var.ports.jobs.enqueue({ type: 'webhooks.deliver', deliveryId: delivery!.id })
    return c.json({ ok: true, deliveryId: delivery!.id })
  })

  app.get('/:owner/:slug/webhooks/:id/deliveries', async (c) => {
    const access = await requireAdmin(c)
    if (access instanceof Response) return access
    const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 50) || 50))
    const deliveries = await c.var.ports.db
      .select({
        id: schema.webhookDeliveries.id,
        event: schema.webhookDeliveries.event,
        semver: schema.webhookDeliveries.semver,
        bumpType: schema.webhookDeliveries.bumpType,
        status: schema.webhookDeliveries.status,
        attempts: schema.webhookDeliveries.attempts,
        responseCode: schema.webhookDeliveries.responseCode,
        error: schema.webhookDeliveries.error,
        durationMs: schema.webhookDeliveries.durationMs,
        createdAt: schema.webhookDeliveries.createdAt,
        deliveredAt: schema.webhookDeliveries.deliveredAt,
      })
      .from(schema.webhookDeliveries)
      .where(
        and(
          eq(schema.webhookDeliveries.webhookId, c.req.param('id')),
          eq(schema.webhookDeliveries.collectionId, access.collection.id),
        ),
      )
      .orderBy(desc(schema.webhookDeliveries.createdAt))
      .limit(limit)
    return c.json({ deliveries })
  })

  app.post('/:owner/:slug/webhooks/:id/deliveries/:deliveryId/retry', async (c) => {
    const access = await requireAdmin(c)
    if (access instanceof Response) return access
    const [d] = await c.var.ports.db
      .select({ id: schema.webhookDeliveries.id })
      .from(schema.webhookDeliveries)
      .where(
        and(
          eq(schema.webhookDeliveries.id, c.req.param('deliveryId')),
          eq(schema.webhookDeliveries.webhookId, c.req.param('id')),
          eq(schema.webhookDeliveries.collectionId, access.collection.id),
        ),
      )
      .limit(1)
    if (!d) return jsonError(c, 404, 'Not found')
    await c.var.ports.db
      .update(schema.webhookDeliveries)
      .set({ status: 'pending', attempts: 0 })
      .where(eq(schema.webhookDeliveries.id, d.id))
    await c.var.ports.jobs.enqueue({ type: 'webhooks.deliver', deliveryId: d.id })
    return c.json({ ok: true, status: 'pending' })
  })

  return app
}
