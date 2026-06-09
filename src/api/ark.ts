import { and, eq, sql } from 'drizzle-orm'
import type { Context } from 'hono'

import { db, schema } from '../db/client.server.js'
import {
  buildArkUrl,
  buildErc,
  collectionToArkId,
  DEFAULT_NAAN,
  formatErcDate,
  getOrMintShoulder,
  parseArkPath,
} from '../lib/ark.js'
import { parseSemver } from '../lib/version-helpers.server.js'
import { type AuthEnv } from './auth.server.js'

// --- Resolution ---

export async function resolve(c: Context<AuthEnv>) {
  const path = c.req.query('path')
  if (!path) return c.json({ error: 'Missing path' }, 400)

  // path = "ark:NAAN/shoulder+collection..."
  const arkLabelIdx = path.indexOf('ark:')
  if (arkLabelIdx === -1) return c.json({ error: 'Invalid ARK path' }, 400)

  const afterLabel = path.slice(arkLabelIdx + 4) // strip "ark:"
  const slashIdx = afterLabel.indexOf('/')
  if (slashIdx === -1) return c.json({ type: 'not_found' }, 404)

  const naan = afterLabel.slice(0, slashIdx)
  const pathAfterNaan = afterLabel.slice(slashIdx + 1)

  // Root NAAN path (no name part) — handled in middleware; shouldn't reach here
  if (!pathAfterNaan) return c.json({ type: 'not_found' }, 404)

  const components = parseArkPath(pathAfterNaan)
  if (!components) return c.json({ type: 'not_found' }, 404)

  const { shoulder, collectionArkId, version, recordType, recordId } = components

  // Lookup shoulder → org
  const [shoulderRow] = await db
    .select({ organizationId: schema.arkShoulders.organizationId })
    .from(schema.arkShoulders)
    .where(eq(schema.arkShoulders.shoulder, shoulder))
    .limit(1)
  if (!shoulderRow) return c.json({ type: 'not_found' }, 404)

  // Lookup collectionArkId → collection + owner
  const [collRow] = await db
    .select({
      collectionId: schema.arkCollections.collectionId,
      enabled: schema.arkCollections.enabled,
      customUrl: schema.arkCollections.customUrl,
      collectionSlug: schema.collections.slug,
      collectionName: schema.collections.name,
      ownerSlug: schema.organization.slug,
      ownerName: schema.organization.name,
      ownerNaan: schema.organization.arkNaan,
      collectionOrgId: schema.collections.organizationId,
    })
    .from(schema.arkCollections)
    .innerJoin(schema.collections, eq(schema.arkCollections.collectionId, schema.collections.id))
    .innerJoin(schema.organization, eq(schema.collections.organizationId, schema.organization.id))
    .where(eq(schema.arkCollections.arkId, collectionArkId))
    .limit(1)

  if (!collRow || !collRow.enabled) return c.json({ type: 'not_found' }, 404)

  // Verify the shoulder belongs to the collection's owner
  if (shoulderRow.organizationId !== collRow.collectionOrgId) {
    return c.json({ type: 'not_found' }, 404)
  }

  const resolvedNaan = collRow.ownerNaan ?? naan
  const { collectionId, collectionSlug, collectionName, ownerSlug, ownerName } = collRow

  // --- Resolve version ---
  let versionRow: {
    id: number
    semver: string
    message: string | null
    metadata: unknown
    pushedBy: string | null
    appId: string | null
    actorId: string | null
    createdAt: Date
  } | null = null

  if (version !== undefined) {
    const versionSemver = parseSemver(String(version)).semver
    const [row] = await db
      .select({
        id: schema.versions.id,
        semver: schema.versions.semver,
        message: schema.versions.message,
        metadata: schema.versions.metadata,
        pushedBy: schema.versions.pushedBy,
        appId: schema.versions.appId,
        actorId: schema.versions.actorId,
        createdAt: schema.versions.createdAt,
      })
      .from(schema.versions)
      .where(
        and(
          eq(schema.versions.collectionId, collectionId),
          eq(schema.versions.semver, versionSemver),
          eq(schema.versions.status, 'ready'),
        ),
      )
      .limit(1)
    if (!row) return c.json({ type: 'not_found' }, 404)
    versionRow = row
  } else {
    const [row] = await db
      .select({
        id: schema.versions.id,
        semver: schema.versions.semver,
        message: schema.versions.message,
        metadata: schema.versions.metadata,
        pushedBy: schema.versions.pushedBy,
        appId: schema.versions.appId,
        actorId: schema.versions.actorId,
        createdAt: schema.versions.createdAt,
      })
      .from(schema.versions)
      .where(
        and(eq(schema.versions.collectionId, collectionId), eq(schema.versions.status, 'ready')),
      )
      .orderBy(sql`major desc, minor desc, patch desc`)
      .limit(1)
    versionRow = row ?? null
  }

  const versionSemverForUrl =
    version !== undefined ? parseSemver(String(version)).semver : undefined
  const arkUrl = buildArkUrl(
    resolvedNaan,
    shoulder,
    collectionArkId,
    versionSemverForUrl,
    recordType,
    recordId,
  )

  // --- Record resolution ---
  if (recordType && recordId) {
    const [artRow] = await db
      .select({ redirectUrlField: schema.arkRecordTypes.redirectUrlField })
      .from(schema.arkRecordTypes)
      .where(
        and(
          eq(schema.arkRecordTypes.collectionId, collectionId),
          eq(schema.arkRecordTypes.recordType, recordType),
        ),
      )
      .limit(1)

    if (!artRow) return c.json({ type: 'not_found' }, 404)

    if (!versionRow) return c.json({ type: 'not_found' }, 404)

    const [recordRow] = await db
      .select({ data: schema.recordObjects.data })
      .from(schema.versionRecords)
      .innerJoin(
        schema.recordObjects,
        eq(schema.versionRecords.recordHash, schema.recordObjects.hash),
      )
      .where(
        and(
          eq(schema.versionRecords.versionId, versionRow.id),
          eq(schema.recordObjects.recordId, recordId),
          eq(schema.recordObjects.type, recordType),
        ),
      )
      .limit(1)

    if (!recordRow) return c.json({ type: 'not_found' }, 404)

    const data = recordRow.data as Record<string, unknown>
    const redirectUrl = data[artRow.redirectUrlField]
    if (typeof redirectUrl !== 'string') {
      return c.json({ type: 'not_found', error: 'No URL found for this record' }, 404)
    }

    // Fetch the type schema for metadata
    const [vs] = await db
      .select({ schema: schema.schemas.schema })
      .from(schema.versionSchemas)
      .innerJoin(schema.schemas, eq(schema.versionSchemas.schemaId, schema.schemas.id))
      .where(
        and(
          eq(schema.versionSchemas.versionId, versionRow.id),
          eq(schema.versionSchemas.slug, recordType),
        ),
      )
      .limit(1)

    return c.json({
      type: 'redirect' as const,
      url: redirectUrl,
      metadata: {
        type: 'record',
        who: ownerName,
        what: `${recordType} ${recordId} in ${collectionName}`,
        when: formatErcDate(versionRow.createdAt),
        where: arkUrl,
        naan: resolvedNaan,
        collectionName,
        ownerName,
        semver: versionRow.semver,
        recordType,
        recordId,
        schema: vs?.schema ?? null,
        data,
        createdAt: versionRow.createdAt,
        arkUrl,
      },
    })
  }

  // --- Collection / version resolution ---
  if (collRow.customUrl) {
    const what = versionRow ? `${collectionName} ${versionRow.semver}` : collectionName
    const when = versionRow ? formatErcDate(versionRow.createdAt) : '(:unkn)'
    return c.json({
      type: 'redirect' as const,
      url: collRow.customUrl,
      metadata: {
        type: version !== undefined ? 'version' : 'collection',
        who: ownerName,
        what,
        when,
        where: arkUrl,
        naan: resolvedNaan,
        collectionName,
        ownerName,
        semver: versionRow?.semver,
        message: versionRow?.message,
        pushedBy: versionRow?.pushedBy,
        appId: versionRow?.appId,
        actorId: versionRow?.actorId,
        createdAt: versionRow?.createdAt,
        arkUrl,
      },
    })
  }

  if (version !== undefined && versionRow) {
    const url = `/${ownerSlug}/${collectionSlug}/v/${versionRow.semver}`
    return c.json({
      type: 'redirect' as const,
      url,
      metadata: {
        type: 'version',
        who: ownerName,
        what: `${collectionName} ${versionRow.semver}`,
        when: formatErcDate(versionRow.createdAt),
        where: arkUrl,
        naan: resolvedNaan,
        collectionName,
        ownerName,
        semver: versionRow.semver,
        message: versionRow.message,
        pushedBy: versionRow.pushedBy,
        appId: versionRow.appId,
        actorId: versionRow.actorId,
        createdAt: versionRow.createdAt,
        arkUrl,
      },
    })
  }

  // Default: redirect to collection overview
  const url = `/${ownerSlug}/${collectionSlug}`
  return c.json({
    type: 'redirect' as const,
    url,
    metadata: {
      type: 'collection',
      who: ownerName,
      what: collectionName,
      when: versionRow ? formatErcDate(versionRow.createdAt) : '(:unkn)',
      where: arkUrl,
      naan: resolvedNaan,
      collectionName,
      ownerName,
      semver: versionRow?.semver,
      createdAt: versionRow?.createdAt,
      arkUrl,
    },
  })
}

// --- Collection ARK settings ---

export async function getArk(c: Context<AuthEnv>) {
  const owner = c.req.param('owner')!
  const slug = c.req.param('slug')!

  const [coll] = await db
    .select({
      id: schema.collections.id,
      organizationId: schema.collections.organizationId,
      ownerNaan: schema.organization.arkNaan,
    })
    .from(schema.collections)
    .innerJoin(schema.organization, eq(schema.collections.organizationId, schema.organization.id))
    .where(and(eq(schema.organization.slug, owner), eq(schema.collections.slug, slug)))
    .limit(1)
  if (!coll) return c.json({ error: 'Collection not found' }, 404)

  // Must be owner/member
  const hasAccess = await checkCollectionAccess(coll.organizationId, c.get('userId')!)
  if (!hasAccess) return c.json({ error: 'Forbidden' }, 403)

  const naan = coll.ownerNaan ?? DEFAULT_NAAN

  const [arkRow] = await db
    .select({
      arkId: schema.arkCollections.arkId,
      enabled: schema.arkCollections.enabled,
      customUrl: schema.arkCollections.customUrl,
      shoulder: schema.arkShoulders.shoulder,
    })
    .from(schema.arkCollections)
    .innerJoin(schema.arkShoulders, eq(schema.arkShoulders.organizationId, coll.organizationId))
    .where(eq(schema.arkCollections.collectionId, coll.id))
    .limit(1)

  if (!arkRow) {
    return c.json({ enabled: false, customUrl: null, arkUrl: null, shoulder: null, arkId: null })
  }

  const arkUrl = buildArkUrl(naan, arkRow.shoulder, arkRow.arkId)
  return c.json({
    enabled: arkRow.enabled,
    customUrl: arkRow.customUrl,
    arkUrl,
    shoulder: arkRow.shoulder,
    arkId: arkRow.arkId,
  })
}

export async function updateArk(c: Context<AuthEnv>) {
  const owner = c.req.param('owner')!
  const slug = c.req.param('slug')!
  const { enabled, customUrl } = await c.req.json()

  const [coll] = await db
    .select({ id: schema.collections.id, organizationId: schema.collections.organizationId })
    .from(schema.collections)
    .innerJoin(schema.organization, eq(schema.collections.organizationId, schema.organization.id))
    .where(and(eq(schema.organization.slug, owner), eq(schema.collections.slug, slug)))
    .limit(1)
  if (!coll) return c.json({ error: 'Collection not found' }, 404)

  const hasAccess = await checkCollectionAccess(coll.organizationId, c.get('userId')!)
  if (!hasAccess) return c.json({ error: 'Forbidden' }, 403)

  const [existing] = await db
    .select({ collectionId: schema.arkCollections.collectionId })
    .from(schema.arkCollections)
    .where(eq(schema.arkCollections.collectionId, coll.id))
    .limit(1)

  if (!existing) {
    // Collection predates ARK tables — mint now
    await getOrMintShoulder(coll.organizationId)
    const arkId = collectionToArkId(coll.id)
    await db.insert(schema.arkCollections).values({
      collectionId: coll.id,
      arkId,
      enabled: enabled ?? true,
      customUrl: customUrl ?? null,
    })
  } else {
    const updates: Record<string, unknown> = {}
    if (enabled !== undefined) updates.enabled = enabled
    if (customUrl !== undefined) updates.customUrl = customUrl ?? null
    if (Object.keys(updates).length > 0) {
      await db
        .update(schema.arkCollections)
        .set(updates)
        .where(eq(schema.arkCollections.collectionId, coll.id))
    }
  }

  return c.json({ ok: true })
}

// --- Record type ARK settings ---

export async function getArkRecordTypes(c: Context<AuthEnv>) {
  const owner = c.req.param('owner')!
  const slug = c.req.param('slug')!

  const [coll] = await db
    .select({ id: schema.collections.id, organizationId: schema.collections.organizationId })
    .from(schema.collections)
    .innerJoin(schema.organization, eq(schema.collections.organizationId, schema.organization.id))
    .where(and(eq(schema.organization.slug, owner), eq(schema.collections.slug, slug)))
    .limit(1)
  if (!coll) return c.json({ error: 'Collection not found' }, 404)

  const hasAccess = await checkCollectionAccess(coll.organizationId, c.get('userId')!)
  if (!hasAccess) return c.json({ error: 'Forbidden' }, 403)

  const rows = await db
    .select({
      recordType: schema.arkRecordTypes.recordType,
      redirectUrlField: schema.arkRecordTypes.redirectUrlField,
    })
    .from(schema.arkRecordTypes)
    .where(eq(schema.arkRecordTypes.collectionId, coll.id))

  return c.json(rows)
}

export async function updateArkRecordTypes(c: Context<AuthEnv>) {
  const owner = c.req.param('owner')!
  const slug = c.req.param('slug')!
  const { recordType, redirectUrlField } = await c.req.json()

  if (!recordType) return c.json({ error: 'recordType required' }, 400)

  const [coll] = await db
    .select({ id: schema.collections.id, organizationId: schema.collections.organizationId })
    .from(schema.collections)
    .innerJoin(schema.organization, eq(schema.collections.organizationId, schema.organization.id))
    .where(and(eq(schema.organization.slug, owner), eq(schema.collections.slug, slug)))
    .limit(1)
  if (!coll) return c.json({ error: 'Collection not found' }, 404)

  const hasAccess = await checkCollectionAccess(coll.organizationId, c.get('userId')!)
  if (!hasAccess) return c.json({ error: 'Forbidden' }, 403)

  if (redirectUrlField === null) {
    await db
      .delete(schema.arkRecordTypes)
      .where(
        and(
          eq(schema.arkRecordTypes.collectionId, coll.id),
          eq(schema.arkRecordTypes.recordType, recordType),
        ),
      )
  } else {
    await db
      .insert(schema.arkRecordTypes)
      .values({ collectionId: coll.id, recordType, redirectUrlField })
      .onConflictDoUpdate({
        target: [schema.arkRecordTypes.collectionId, schema.arkRecordTypes.recordType],
        set: { redirectUrlField },
      })
  }

  return c.json({ ok: true })
}

// --- Org ARK NAAN ---

export async function updateAccountArk(c: Context<AuthEnv>) {
  const slug = c.req.param('slug')!
  const { naan } = await c.req.json()

  if (naan !== null && !/^\d{1,16}$/.test(naan)) {
    return c.json({ error: 'NAAN must be numeric (up to 16 digits)' }, 400)
  }

  const [org] = await db
    .select({ id: schema.organization.id })
    .from(schema.organization)
    .where(eq(schema.organization.slug, slug))
    .limit(1)
  if (!org) return c.json({ error: 'Org not found' }, 404)

  // Must be owner/admin of the org
  const [membership] = await db
    .select({ role: schema.member.role })
    .from(schema.member)
    .where(
      and(eq(schema.member.organizationId, org.id), eq(schema.member.userId, c.get('userId')!)),
    )
    .limit(1)
  if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  await db
    .update(schema.organization)
    .set({ arkNaan: naan })
    .where(eq(schema.organization.id, org.id))
  return c.json({ ok: true })
}

// --- Helpers ---

async function checkCollectionAccess(orgId: string, userId: string): Promise<boolean> {
  const [membership] = await db
    .select({ role: schema.member.role })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, userId)))
    .limit(1)
  return !!membership
}
