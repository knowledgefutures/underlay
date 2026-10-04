/**
 * Storage locations and mirror placements (edge-redesign.md, "Placements").
 * Org owners and admins manage them; members can read mirror status.
 *
 *   GET    /api/orgs/:org/locations
 *   POST   /api/orgs/:org/locations                 {name, endpoint, bucket, region?, prefix?,
 *                                                    accessKeyId, secretAccessKey, permissions}
 *   POST   /api/orgs/:org/locations/:id/check
 *   DELETE /api/orgs/:org/locations/:id             (its placements go too; bucket contents stay)
 *   GET    /api/orgs/:org/placements                org defaults, inherited by every collection
 *   POST   /api/orgs/:org/placements                {locationId, sets}
 *   DELETE /api/orgs/:org/placements/:id            and the org's mirrors to that location
 *   GET    /api/collections/:owner/:slug/placements primary and mirrors, with progress, lag and
 *                                                    whether each mirror comes from an org default
 *   POST   /api/collections/:owner/:slug/placements {locationId, sets}
 *   POST   /api/collections/:owner/:slug/placements/:id/sync
 *   DELETE /api/collections/:owner/:slug/placements/:id  (409 for one from an org default)
 *   POST   /api/orgs/:org/restores                  {locationId, collectionId, slug, name?,
 *                                                    trustKeyIds?}: rebuild a collection here
 *   GET    /api/orgs/:org/restores/:id
 *
 * A location that serves objects without credentials may only hold public sets.
 * Deleting a mirror never deletes what it copied: the bucket is the customer's.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { type Context, Hono } from 'hono'

import type { AppEnv } from '../app.js'
import * as schema from '../db/schema.js'
import { validateSlug } from '../lib/slug.js'
import {
  checkEndpoint,
  checkLocation,
  encryptCredentials,
  type LocationRow,
} from '../locations/locations.js'
import { collectionMirrors, queueMirrors } from '../locations/mirror.js'
import { inspectSource, RestoreError } from '../locations/restore.js'
import { createCollectionRows } from '../versions/fork.js'
import { jsonError, requireCollection } from './access.js'
import { isAdmin, membership } from './manage.js'

const str = (v: unknown, max = 512) =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null

function locationView(l: LocationRow) {
  return {
    id: l.id,
    name: l.name,
    kind: l.kind,
    endpoint: l.endpoint,
    region: l.region,
    bucket: l.bucket,
    prefix: l.prefix,
    permissions: l.permissions,
    status: l.status,
    lastError: l.lastError,
    verifiedAt: l.verifiedAt,
  }
}

async function orgAdmin(c: Context<AppEnv>) {
  if (!c.var.principal) return jsonError(c, 401, 'Authentication required')
  const { org, role } = await membership(c, c.req.param('org') ?? '')
  if (!org) return jsonError(c, 404, 'Org not found')
  if (!isAdmin(role)) return jsonError(c, 403, 'Only org owners and admins manage storage')
  return org
}

/** An org's location, by id. */
async function orgLocation(c: Context<AppEnv>, orgId: string, id: string) {
  const [loc] = await c.var.ports.db
    .select()
    .from(schema.storageLocations)
    .where(
      and(eq(schema.storageLocations.id, id), eq(schema.storageLocations.organizationId, orgId)),
    )
  return loc ?? null
}

/** An org's default placements, which its collections inherit. */
function orgDefaults(c: Context<AppEnv>, orgId: string) {
  return c.var.ports.db
    .select()
    .from(schema.placements)
    .where(and(eq(schema.placements.organizationId, orgId), isNull(schema.placements.collectionId)))
}

/** Whether a location may hold private sets: checked now, refused if public. */
async function allowSets(c: Context<AppEnv>, loc: LocationRow, sets: string) {
  if (sets !== 'public' && sets !== 'public+private') {
    return jsonError(c, 400, '"sets" is "public" or "public+private"')
  }
  const check = await checkLocation(c.var.ports, loc)
  if (!check.ok) return jsonError(c, 422, `The location failed its check: ${check.error}`)
  if (sets === 'public+private' && check.publicRead) {
    return jsonError(
      c,
      422,
      'The location serves objects without credentials; it can hold public sets only',
    )
  }
  return null
}

export function locationRoutes() {
  const app = new Hono<AppEnv>()

  app.get('/api/orgs/:org/locations', async (c) => {
    const org = await orgAdmin(c)
    if (org instanceof Response) return org
    const rows = await c.var.ports.db
      .select()
      .from(schema.storageLocations)
      .where(eq(schema.storageLocations.organizationId, org.id))
    return c.json({ locations: rows.map(locationView) })
  })

  app.post('/api/orgs/:org/locations', async (c) => {
    const org = await orgAdmin(c)
    if (org instanceof Response) return org
    const ports = c.var.ports
    if (!ports.locationKey)
      return jsonError(c, 409, 'This deployment has no LOCATION_KEY; locations are unavailable')
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const endpointError = checkEndpoint(body.endpoint)
    if (endpointError) return jsonError(c, 400, endpointError)
    const name = str(body.name, 200)
    const bucket = str(body.bucket, 255)
    const accessKeyId = str(body.accessKeyId)
    const secretAccessKey = str(body.secretAccessKey)
    const permissions = body.permissions === 'read_write' ? 'read_write' : 'write'
    if (!name || !bucket || !accessKeyId || !secretAccessKey) {
      return jsonError(c, 400, 'name, bucket, accessKeyId and secretAccessKey are required')
    }
    const prefix = (str(body.prefix, 512) ?? '').replace(/^\/+|\/+$/g, '')
    const id = crypto.randomUUID()
    await ports.db.insert(schema.storageLocations).values({
      id,
      organizationId: org.id,
      kind: 's3',
      name,
      endpoint: (body.endpoint as string).replace(/\/+$/, ''),
      region: str(body.region, 64),
      bucket,
      prefix,
      credentials: await encryptCredentials(ports, id, { accessKeyId, secretAccessKey }),
      permissions,
    })
    const loc = (await orgLocation(c, org.id, id))!
    const check = await checkLocation(ports, loc)
    return c.json({ location: locationView((await orgLocation(c, org.id, id))!), check }, 201)
  })

  app.post('/api/orgs/:org/locations/:id/check', async (c) => {
    const org = await orgAdmin(c)
    if (org instanceof Response) return org
    const loc = await orgLocation(c, org.id, c.req.param('id'))
    if (!loc) return jsonError(c, 404, 'Location not found')
    const check = await checkLocation(c.var.ports, loc)
    return c.json({ location: locationView((await orgLocation(c, org.id, loc.id))!), check })
  })

  app.delete('/api/orgs/:org/locations/:id', async (c) => {
    const org = await orgAdmin(c)
    if (org instanceof Response) return org
    const loc = await orgLocation(c, org.id, c.req.param('id'))
    if (!loc) return jsonError(c, 404, 'Location not found')
    await c.var.ports.db
      .delete(schema.storageLocations)
      .where(eq(schema.storageLocations.id, loc.id))
    return c.body(null, 204)
  })

  app.get('/api/orgs/:org/placements', async (c) => {
    const org = await orgAdmin(c)
    if (org instanceof Response) return org
    const rows = await orgDefaults(c, org.id)
    return c.json({
      placements: rows.map((p) => ({ id: p.id, locationId: p.locationId, sets: p.sets })),
    })
  })

  app.post('/api/orgs/:org/placements', async (c) => {
    const org = await orgAdmin(c)
    if (org instanceof Response) return org
    const body = (await c.req.json().catch(() => ({}))) as { locationId?: unknown; sets?: unknown }
    const loc = await orgLocation(c, org.id, String(body.locationId ?? ''))
    if (!loc) return jsonError(c, 404, 'Location not found')
    const sets = String(body.sets ?? 'public')
    const refused = await allowSets(c, loc, sets)
    if (refused) return refused
    const { db } = c.var.ports
    const [row] = await db
      .insert(schema.placements)
      .values({
        organizationId: org.id,
        locationId: loc.id,
        role: 'mirror',
        sets: sets as 'public' | 'public+private',
      })
      .onConflictDoNothing()
      .returning()
    if (!row) return jsonError(c, 409, 'The org already mirrors to this location')
    // Every existing collection inherits it now; new ones on their first publish.
    const cols = await db
      .select({ id: schema.collections.id })
      .from(schema.collections)
      .where(eq(schema.collections.organizationId, org.id))
    for (const col of cols) await queueMirrors(c.var.ports, col.id)
    return c.json({ placement: { id: row.id, locationId: row.locationId, sets: row.sets } }, 201)
  })

  app.delete('/api/orgs/:org/placements/:id', async (c) => {
    const org = await orgAdmin(c)
    if (org instanceof Response) return org
    const { db } = c.var.ports
    const [row] = await db
      .select()
      .from(schema.placements)
      .where(
        and(
          eq(schema.placements.id, c.req.param('id')),
          eq(schema.placements.organizationId, org.id),
        ),
      )
    if (!row) return jsonError(c, 404, 'Placement not found')
    await db.batch([
      db.delete(schema.placements).where(eq(schema.placements.id, row.id)),
      db
        .delete(schema.placements)
        .where(
          and(
            eq(schema.placements.locationId, row.locationId),
            eq(schema.placements.role, 'mirror'),
            inArray(
              schema.placements.collectionId,
              db
                .select({ id: schema.collections.id })
                .from(schema.collections)
                .where(eq(schema.collections.organizationId, org.id)),
            ),
          ),
        ),
    ])
    return c.body(null, 204)
  })

  app.get('/api/collections/:owner/:slug/placements', async (c) => {
    const access = await requireCollection(c, 'read')
    if (access instanceof Response) return access
    if (!access.isMember) return jsonError(c, 404, 'Collection not found')
    const { db } = c.var.ports
    await collectionMirrors(c.var.ports, access.collection.id)
    const rows = await db
      .select({ p: schema.placements, l: schema.storageLocations })
      .from(schema.placements)
      .innerJoin(
        schema.storageLocations,
        eq(schema.storageLocations.id, schema.placements.locationId),
      )
      .where(eq(schema.placements.collectionId, access.collection.id))
    const [head] = access.collection.headVersionId
      ? await db
          .select({ seq: schema.versions.seq })
          .from(schema.versions)
          .where(eq(schema.versions.id, access.collection.headVersionId))
      : []
    const headSeq = head?.seq ?? 0
    const inherited = new Set(
      (await orgDefaults(c, access.collection.organizationId)).map((d) => d.locationId),
    )
    return c.json({
      headSeq,
      placements: rows.map(({ p, l }) => ({
        id: p.id,
        role: p.role,
        sets: p.sets,
        // From an org default: removed with the default, not per collection.
        inherited: p.role === 'mirror' && inherited.has(p.locationId),
        state: p.state,
        syncedSeq: p.role === 'primary' ? headSeq : p.syncedSeq,
        lag: p.role === 'primary' ? 0 : Math.max(0, headSeq - p.syncedSeq),
        lastError: p.lastError,
        updatedAt: p.updatedAt,
        location: {
          id: l.id,
          name: l.name,
          kind: l.kind,
          bucket: l.bucket,
          prefix: l.prefix,
          status: l.status,
        },
      })),
    })
  })

  app.post('/api/collections/:owner/:slug/placements', async (c) => {
    const access = await requireCollection(c, 'write')
    if (access instanceof Response) return access
    if (!isAdmin(access.role)) return jsonError(c, 403, 'Only org owners and admins manage mirrors')
    const body = (await c.req.json().catch(() => ({}))) as { locationId?: unknown; sets?: unknown }
    const loc = await orgLocation(c, access.owner.id, String(body.locationId ?? ''))
    if (!loc) return jsonError(c, 404, 'Location not found')
    const sets = String(body.sets ?? 'public')
    const refused = await allowSets(c, loc, sets)
    if (refused) return refused
    const [row] = await c.var.ports.db
      .insert(schema.placements)
      .values({
        collectionId: access.collection.id,
        locationId: loc.id,
        role: 'mirror',
        sets: sets as 'public' | 'public+private',
        state: 'backfilling',
      })
      .onConflictDoNothing()
      .returning()
    if (!row) return jsonError(c, 409, 'The collection already mirrors to this location')
    await c.var.ports.jobs.enqueue({ type: 'mirror.version', placementId: row.id })
    return c.json(
      { placement: { id: row.id, locationId: loc.id, sets: row.sets, state: row.state } },
      201,
    )
  })

  app.post('/api/collections/:owner/:slug/placements/:id/sync', async (c) => {
    const access = await requireCollection(c, 'write')
    if (access instanceof Response) return access
    if (!isAdmin(access.role)) return jsonError(c, 403, 'Only org owners and admins manage mirrors')
    const { db } = c.var.ports
    const [p] = await db
      .update(schema.placements)
      .set({ state: 'backfilling', lastError: null, updatedAt: new Date() })
      .where(
        and(
          eq(schema.placements.id, c.req.param('id')),
          eq(schema.placements.collectionId, access.collection.id),
          eq(schema.placements.role, 'mirror'),
        ),
      )
      .returning()
    if (!p) return jsonError(c, 404, 'Placement not found')
    await c.var.ports.jobs.enqueue({ type: 'mirror.version', placementId: p.id })
    return c.json({ placement: { id: p.id, state: p.state } }, 202)
  })

  app.delete('/api/collections/:owner/:slug/placements/:id', async (c) => {
    const access = await requireCollection(c, 'write')
    if (access instanceof Response) return access
    if (!isAdmin(access.role)) return jsonError(c, 403, 'Only org owners and admins manage mirrors')
    const { db } = c.var.ports
    const [p] = await db
      .select({ locationId: schema.placements.locationId })
      .from(schema.placements)
      .where(
        and(
          eq(schema.placements.id, c.req.param('id')),
          eq(schema.placements.collectionId, access.collection.id),
          eq(schema.placements.role, 'mirror'),
        ),
      )
    if (!p) return jsonError(c, 404, 'Placement not found')
    // The next publish would make it again from the default.
    const defaults = await orgDefaults(c, access.collection.organizationId)
    if (defaults.some((d) => d.locationId === p.locationId)) {
      return jsonError(
        c,
        409,
        "This mirror comes from the org's default placements; remove it in the org's storage settings",
      )
    }
    const rows = await db
      .delete(schema.placements)
      .where(
        and(
          eq(schema.placements.id, c.req.param('id')),
          eq(schema.placements.collectionId, access.collection.id),
          eq(schema.placements.role, 'mirror'),
        ),
      )
      .returning({ id: schema.placements.id })
    if (rows.length === 0) return jsonError(c, 404, 'Placement not found')
    return c.body(null, 204)
  })

  app.post('/api/orgs/:org/restores', async (c) => {
    const org = await orgAdmin(c)
    if (org instanceof Response) return org
    const ports = c.var.ports
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const loc = await orgLocation(c, org.id, String(body.locationId ?? ''))
    if (!loc) return jsonError(c, 404, 'Location not found')
    const sourceId = str(body.collectionId, 64)
    if (!sourceId) return jsonError(c, 400, '"collectionId" names the collection in the location')
    const slugError = validateSlug(body.slug)
    if (slugError) return jsonError(c, 422, slugError)
    const slug = body.slug as string
    const [taken] = await ports.db
      .select({ id: schema.collections.id })
      .from(schema.collections)
      .where(and(eq(schema.collections.organizationId, org.id), eq(schema.collections.slug, slug)))
    if (taken) return jsonError(c, 409, 'Collection already exists')
    // The restored collection keeps its id, which every entry of its signed log names.
    const [present] = await ports.db
      .select({ id: schema.collections.id })
      .from(schema.collections)
      .where(eq(schema.collections.id, sourceId))
    if (present) {
      return jsonError(
        c,
        409,
        'This instance already has that collection; restore brings back a collection that is gone',
      )
    }
    let source
    try {
      source = await inspectSource(ports, loc, sourceId)
    } catch (err) {
      if (err instanceof RestoreError) return jsonError(c, 422, err.message)
      throw err
    }
    const trustKeyIds = Array.isArray(body.trustKeyIds)
      ? body.trustKeyIds.filter((k): k is string => typeof k === 'string')
      : []
    const col = await createCollectionRows(ports, {
      id: sourceId,
      organizationId: org.id,
      slug,
      name: str(body.name, 200) ?? source.info.name ?? slug,
      public: false,
    })
    const [restore] = await ports.db
      .insert(schema.restores)
      .values({
        organizationId: org.id,
        locationId: loc.id,
        sourceCollectionId: sourceId,
        collectionId: col.id,
        sets: source.sets,
        trustKeyIds,
      })
      .returning()
    await ports.jobs.enqueue({ type: 'restore.version', restoreId: restore!.id })
    return c.json(
      {
        restore: restoreView(restore!),
        collection: { id: col.id, owner: org.slug, slug },
        versions: source.head.seq,
      },
      202,
    )
  })

  app.get('/api/orgs/:org/restores/:id', async (c) => {
    const org = await orgAdmin(c)
    if (org instanceof Response) return org
    const [r] = await c.var.ports.db
      .select()
      .from(schema.restores)
      .where(
        and(eq(schema.restores.id, c.req.param('id')), eq(schema.restores.organizationId, org.id)),
      )
    if (!r) return jsonError(c, 404, 'Restore not found')
    return c.json({ restore: restoreView(r) })
  })

  return app
}

function restoreView(r: typeof schema.restores.$inferSelect) {
  return {
    id: r.id,
    status: r.status,
    collectionId: r.collectionId,
    sets: r.sets,
    restoredSeq: r.restoredSeq,
    error: r.error,
    updatedAt: r.updatedAt,
  }
}
