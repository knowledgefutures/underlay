import { and, desc, eq } from 'drizzle-orm'
import { type Context, Hono } from 'hono'
import { openApi } from 'hono-zod-openapi'
import { z } from 'zod'

import { db, schema } from '../db/client.server.js'
import { getOrgRole, resolveCollection } from '../lib/version-helpers.server.js'
import {
  dispatchDeliveries,
  generateWebhookSecret,
  retryDelivery,
  validateWebhookUrl,
} from '../lib/webhooks.server.js'
import { type AuthEnv, requireAuth } from './auth.server.js'

const app = new Hono<AuthEnv>()

const bumpFilterSchema = z
  .array(z.enum(['major', 'minor', 'patch']))
  .min(1, 'Select at least one version type')

/**
 * Resolve the collection and verify the caller may manage its webhooks:
 * owner/admin role in the owning org, plus API-key collection scoping.
 * Webhook secrets are sensitive, so management is gated to owner/admin
 * (mirrors the delete-collection gate), not any org member.
 */
async function authorizeWebhookAccess<E extends AuthEnv>(
  c: Context<E>,
  owner: string,
  slug: string,
): Promise<{ collectionId: string } | { error: Response }> {
  const collection = await resolveCollection(owner, slug)
  if (!collection) {
    return { error: c.json({ error: 'Not found', statusCode: 404 }, 404) }
  }
  const role = await getOrgRole(c.get('userId'), collection.organizationId)
  if (role !== 'owner' && role !== 'admin') {
    return { error: c.json({ error: 'Forbidden', statusCode: 403 }, 403) }
  }
  const scoped = c.get('apiKeyCollectionIds')
  if (scoped && !scoped.includes(collection.id)) {
    return {
      error: c.json({ error: 'API key is not scoped to this collection', statusCode: 403 }, 403),
    }
  }
  return { collectionId: collection.id }
}

// List webhooks (secrets omitted)
app.get(
  '/:owner/:slug/webhooks',
  requireAuth('write'),
  openApi({
    tags: ['Webhooks'],
    summary: 'List webhooks for a collection',
    request: { param: z.object({ owner: z.string(), slug: z.string() }) },
    responses: { 200: z.any() },
  }),
  async (c) => {
    const { owner, slug } = c.req.valid('param')
    const auth = await authorizeWebhookAccess(c, owner, slug)
    if ('error' in auth) return auth.error

    const hooks = await db
      .select({
        id: schema.collectionWebhooks.id,
        url: schema.collectionWebhooks.url,
        bumpFilter: schema.collectionWebhooks.bumpFilter,
        enabled: schema.collectionWebhooks.enabled,
        createdAt: schema.collectionWebhooks.createdAt,
        lastDeliveryAt: schema.collectionWebhooks.lastDeliveryAt,
      })
      .from(schema.collectionWebhooks)
      .where(eq(schema.collectionWebhooks.collectionId, auth.collectionId))
      .orderBy(desc(schema.collectionWebhooks.createdAt))

    return c.json({ webhooks: hooks })
  },
)

// Create a webhook — returns the signing secret once
app.post(
  '/:owner/:slug/webhooks',
  requireAuth('write'),
  openApi({
    tags: ['Webhooks'],
    summary: 'Create a webhook',
    request: {
      param: z.object({ owner: z.string(), slug: z.string() }),
      json: z.object({
        url: z.string().url(),
        bumpFilter: bumpFilterSchema.optional(),
        enabled: z.boolean().optional(),
      }),
    },
    responses: { 201: z.any() },
  }),
  async (c) => {
    const { owner, slug } = c.req.valid('param')
    const { url, bumpFilter, enabled } = c.req.valid('json')
    const auth = await authorizeWebhookAccess(c, owner, slug)
    if ('error' in auth) return auth.error

    const check = validateWebhookUrl(url)
    if (!check.ok) return c.json({ error: check.reason, statusCode: 422 }, 422)

    const secret = generateWebhookSecret()
    const [created] = await db
      .insert(schema.collectionWebhooks)
      .values({
        collectionId: auth.collectionId,
        url: check.url,
        bumpFilter: bumpFilter ?? ['major', 'minor', 'patch'],
        enabled: enabled ?? true,
        secret,
        createdBy: c.get('userId') ?? null,
      })
      .returning({
        id: schema.collectionWebhooks.id,
        url: schema.collectionWebhooks.url,
        bumpFilter: schema.collectionWebhooks.bumpFilter,
        enabled: schema.collectionWebhooks.enabled,
        createdAt: schema.collectionWebhooks.createdAt,
      })

    // Secret is shown exactly once, at creation time.
    return c.json({ ...created, secret }, 201)
  },
)

// Update a webhook
app.patch(
  '/:owner/:slug/webhooks/:id',
  requireAuth('write'),
  openApi({
    tags: ['Webhooks'],
    summary: 'Update a webhook',
    request: {
      param: z.object({ owner: z.string(), slug: z.string(), id: z.string() }),
      json: z.object({
        url: z.string().url().optional(),
        bumpFilter: bumpFilterSchema.optional(),
        enabled: z.boolean().optional(),
      }),
    },
    responses: { 200: z.any() },
  }),
  async (c) => {
    const { owner, slug, id } = c.req.valid('param')
    const updates = c.req.valid('json')
    const auth = await authorizeWebhookAccess(c, owner, slug)
    if ('error' in auth) return auth.error

    const set: Record<string, unknown> = {}
    if (updates.url !== undefined) {
      const check = validateWebhookUrl(updates.url)
      if (!check.ok) return c.json({ error: check.reason, statusCode: 422 }, 422)
      set.url = check.url
    }
    if (updates.bumpFilter !== undefined) set.bumpFilter = updates.bumpFilter
    if (updates.enabled !== undefined) set.enabled = updates.enabled
    if (Object.keys(set).length === 0) return c.json({ ok: true })

    const [updated] = await db
      .update(schema.collectionWebhooks)
      .set(set)
      .where(
        and(
          eq(schema.collectionWebhooks.id, id),
          eq(schema.collectionWebhooks.collectionId, auth.collectionId),
        ),
      )
      .returning({
        id: schema.collectionWebhooks.id,
        url: schema.collectionWebhooks.url,
        bumpFilter: schema.collectionWebhooks.bumpFilter,
        enabled: schema.collectionWebhooks.enabled,
      })

    if (!updated) return c.json({ error: 'Not found', statusCode: 404 }, 404)
    return c.json(updated)
  },
)

// Delete a webhook (its deliveries cascade)
app.delete(
  '/:owner/:slug/webhooks/:id',
  requireAuth('write'),
  openApi({
    tags: ['Webhooks'],
    summary: 'Delete a webhook',
    request: { param: z.object({ owner: z.string(), slug: z.string(), id: z.string() }) },
    responses: { 200: z.any() },
  }),
  async (c) => {
    const { owner, slug, id } = c.req.valid('param')
    const auth = await authorizeWebhookAccess(c, owner, slug)
    if ('error' in auth) return auth.error

    const deleted = await db
      .delete(schema.collectionWebhooks)
      .where(
        and(
          eq(schema.collectionWebhooks.id, id),
          eq(schema.collectionWebhooks.collectionId, auth.collectionId),
        ),
      )
      .returning({ id: schema.collectionWebhooks.id })

    if (deleted.length === 0) return c.json({ error: 'Not found', statusCode: 404 }, 404)
    return c.json({ ok: true })
  },
)

// Delivery log for a webhook
app.get(
  '/:owner/:slug/webhooks/:id/deliveries',
  requireAuth('write'),
  openApi({
    tags: ['Webhooks'],
    summary: 'List recent deliveries for a webhook',
    request: { param: z.object({ owner: z.string(), slug: z.string(), id: z.string() }) },
    responses: { 200: z.any() },
  }),
  async (c) => {
    const { owner, slug, id } = c.req.valid('param')
    const auth = await authorizeWebhookAccess(c, owner, slug)
    if ('error' in auth) return auth.error

    const parsedLimit = Number.parseInt(c.req.query('limit') ?? '50', 10)
    const limit = Math.min(Number.isFinite(parsedLimit) ? parsedLimit : 50, 200)

    // Confirm the webhook belongs to this collection before listing its log.
    const [hook] = await db
      .select({ id: schema.collectionWebhooks.id })
      .from(schema.collectionWebhooks)
      .where(
        and(
          eq(schema.collectionWebhooks.id, id),
          eq(schema.collectionWebhooks.collectionId, auth.collectionId),
        ),
      )
      .limit(1)
    if (!hook) return c.json({ error: 'Not found', statusCode: 404 }, 404)

    const deliveries = await db
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
      .where(eq(schema.webhookDeliveries.webhookId, id))
      .orderBy(desc(schema.webhookDeliveries.createdAt))
      .limit(limit)

    return c.json({ deliveries })
  },
)

// Send a test delivery
app.post(
  '/:owner/:slug/webhooks/:id/test',
  requireAuth('write'),
  openApi({
    tags: ['Webhooks'],
    summary: 'Send a test delivery',
    request: { param: z.object({ owner: z.string(), slug: z.string(), id: z.string() }) },
    responses: { 200: z.any() },
  }),
  async (c) => {
    const { owner, slug, id } = c.req.valid('param')
    const auth = await authorizeWebhookAccess(c, owner, slug)
    if ('error' in auth) return auth.error

    const [hook] = await db
      .select({ id: schema.collectionWebhooks.id })
      .from(schema.collectionWebhooks)
      .where(
        and(
          eq(schema.collectionWebhooks.id, id),
          eq(schema.collectionWebhooks.collectionId, auth.collectionId),
        ),
      )
      .limit(1)
    if (!hook) return c.json({ error: 'Not found', statusCode: 404 }, 404)

    const payload = {
      event: 'ping',
      collection: { owner, slug },
      version: null,
      bumpType: 'patch' as const,
      test: true,
    }
    const [delivery] = await db
      .insert(schema.webhookDeliveries)
      .values({
        webhookId: id,
        collectionId: auth.collectionId,
        bumpType: 'patch',
        event: 'ping',
        payload,
        status: 'pending',
      })
      .returning({ id: schema.webhookDeliveries.id })

    dispatchDeliveries([delivery!.id])
    return c.json({ ok: true, deliveryId: delivery!.id })
  },
)

// Retry a delivery
app.post(
  '/:owner/:slug/webhooks/:id/deliveries/:deliveryId/retry',
  requireAuth('write'),
  openApi({
    tags: ['Webhooks'],
    summary: 'Retry a delivery',
    request: {
      param: z.object({
        owner: z.string(),
        slug: z.string(),
        id: z.string(),
        deliveryId: z.string(),
      }),
    },
    responses: { 200: z.any() },
  }),
  async (c) => {
    const { owner, slug, deliveryId } = c.req.valid('param')
    const auth = await authorizeWebhookAccess(c, owner, slug)
    if ('error' in auth) return auth.error

    const ok = await retryDelivery(deliveryId, auth.collectionId)
    if (!ok) return c.json({ error: 'Not found', statusCode: 404 }, 404)
    return c.json({ ok: true })
  },
)

export default app
