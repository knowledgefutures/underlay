import { and, desc, eq, } from 'drizzle-orm'
import type { Context, } from 'hono'
import { db, schema, } from '../db/client.server.js'
import {
  buildArkUrl,
  buildErc,
  collectionToArkId,
  DEFAULT_NAAN,
  formatErcDate,
  getOrMintShoulder,
  parseArkPath,
} from '../lib/ark.js'
import { type AuthEnv, } from './auth.server.js'

// --- Resolution ---

export async function resolve(c: Context<AuthEnv>,) {
  const path = c.req.query('path',)
  if (!path) return c.json({ error: 'Missing path', }, 400,)

  // path = "ark:NAAN/shoulder+collection..."
  const arkLabelIdx = path.indexOf('ark:',)
  if (arkLabelIdx === -1) return c.json({ error: 'Invalid ARK path', }, 400,)

  const afterLabel = path.slice(arkLabelIdx + 4,) // strip "ark:"
  const slashIdx = afterLabel.indexOf('/',)
  if (slashIdx === -1) return c.json({ type: 'not_found', }, 404,)

  const naan = afterLabel.slice(0, slashIdx,)
  const pathAfterNaan = afterLabel.slice(slashIdx + 1,)

  // Root NAAN path (no name part) — handled in middleware; shouldn't reach here
  if (!pathAfterNaan) return c.json({ type: 'not_found', }, 404,)

  const components = parseArkPath(pathAfterNaan,)
  if (!components) return c.json({ type: 'not_found', }, 404,)

  const { shoulder, collectionArkId, version, recordType, recordId, } = components

  // Lookup shoulder → account
  const [shoulderRow,] = await db
    .select({ accountId: schema.arkShoulders.accountId, },)
    .from(schema.arkShoulders,)
    .where(eq(schema.arkShoulders.shoulder, shoulder,),)
    .limit(1,)
  if (!shoulderRow) return c.json({ type: 'not_found', }, 404,)

  // Lookup collectionArkId → collection + owner
  const [collRow,] = await db
    .select({
      collectionId: schema.arkCollections.collectionId,
      enabled: schema.arkCollections.enabled,
      customUrl: schema.arkCollections.customUrl,
      collectionSlug: schema.collections.slug,
      collectionName: schema.collections.name,
      ownerSlug: schema.accounts.slug,
      ownerName: schema.accounts.displayName,
      ownerNaan: schema.accounts.arkNaan,
      collectionAccountId: schema.collections.accountId,
    },)
    .from(schema.arkCollections,)
    .innerJoin(schema.collections, eq(schema.arkCollections.collectionId, schema.collections.id,),)
    .innerJoin(schema.accounts, eq(schema.collections.accountId, schema.accounts.id,),)
    .where(eq(schema.arkCollections.arkId, collectionArkId,),)
    .limit(1,)

  if (!collRow || !collRow.enabled) return c.json({ type: 'not_found', }, 404,)

  // Verify the shoulder belongs to the collection's owner
  if (shoulderRow.accountId !== collRow.collectionAccountId) {
    return c.json({ type: 'not_found', }, 404,)
  }

  const resolvedNaan = collRow.ownerNaan ?? naan
  const { collectionId, collectionSlug, collectionName, ownerSlug, ownerName, } = collRow

  // --- Resolve version ---
  let versionRow: {
    id: number
    number: number
    semver: string
    message: string | null
    readme: string | null
    pushedBy: string | null
    appId: string | null
    actorId: string | null
    createdAt: Date
  } | null = null

  if (version !== undefined) {
    const [row,] = await db
      .select({
        id: schema.versions.id,
        number: schema.versions.number,
        semver: schema.versions.semver,
        message: schema.versions.message,
        readme: schema.versions.readme,
        pushedBy: schema.versions.pushedBy,
        appId: schema.versions.appId,
        actorId: schema.versions.actorId,
        createdAt: schema.versions.createdAt,
      },)
      .from(schema.versions,)
      .where(and(eq(schema.versions.collectionId, collectionId,), eq(schema.versions.number, version,),),)
      .limit(1,)
    if (!row) return c.json({ type: 'not_found', }, 404,)
    versionRow = row
  } else {
    const [row,] = await db
      .select({
        id: schema.versions.id,
        number: schema.versions.number,
        semver: schema.versions.semver,
        message: schema.versions.message,
        readme: schema.versions.readme,
        pushedBy: schema.versions.pushedBy,
        appId: schema.versions.appId,
        actorId: schema.versions.actorId,
        createdAt: schema.versions.createdAt,
      },)
      .from(schema.versions,)
      .where(eq(schema.versions.collectionId, collectionId,),)
      .orderBy(desc(schema.versions.number,),)
      .limit(1,)
    versionRow = row ?? null
  }

  const arkUrl = buildArkUrl(resolvedNaan, shoulder, collectionArkId, version, recordType, recordId,)

  // --- Record resolution ---
  if (recordType && recordId) {
    const [artRow,] = await db
      .select({ redirectUrlField: schema.arkRecordTypes.redirectUrlField, },)
      .from(schema.arkRecordTypes,)
      .where(
        and(
          eq(schema.arkRecordTypes.collectionId, collectionId,),
          eq(schema.arkRecordTypes.recordType, recordType,),
        ),
      )
      .limit(1,)

    if (!artRow) return c.json({ type: 'not_found', }, 404,)

    if (!versionRow) return c.json({ type: 'not_found', }, 404,)

    const [recordRow,] = await db
      .select({ data: schema.records.data, },)
      .from(schema.records,)
      .where(
        and(
          eq(schema.records.versionId, versionRow.id,),
          eq(schema.records.recordId, recordId,),
          eq(schema.records.type, recordType,),
        ),
      )
      .limit(1,)

    if (!recordRow) return c.json({ type: 'not_found', }, 404,)

    const data = recordRow.data as Record<string, unknown>
    const redirectUrl = data[artRow.redirectUrlField]
    if (typeof redirectUrl !== 'string') {
      return c.json({ type: 'not_found', error: 'No URL found for this record', }, 404,)
    }

    // Fetch the type schema for metadata
    const [vs,] = await db
      .select({ schema: schema.schemas.schema, },)
      .from(schema.versionSchemas,)
      .innerJoin(schema.schemas, eq(schema.versionSchemas.schemaId, schema.schemas.id,),)
      .where(
        and(
          eq(schema.versionSchemas.versionId, versionRow.id,),
          eq(schema.versionSchemas.slug, recordType,),
        ),
      )
      .limit(1,)

    return c.json({
      type: 'redirect' as const,
      url: redirectUrl,
      metadata: {
        type: 'record',
        who: ownerName,
        what: `${recordType} ${recordId} in ${collectionName}`,
        when: formatErcDate(versionRow.createdAt,),
        where: arkUrl,
        naan: resolvedNaan,
        collectionName,
        ownerName,
        versionNumber: versionRow.number,
        semver: versionRow.semver,
        recordType,
        recordId,
        schema: vs?.schema ?? null,
        data,
        createdAt: versionRow.createdAt,
        arkUrl,
      },
    },)
  }

  // --- Collection / version resolution ---
  if (collRow.customUrl) {
    const what = versionRow
      ? `${collectionName} ${versionRow.semver}`
      : collectionName
    const when = versionRow
      ? formatErcDate(versionRow.createdAt,)
      : '(:unkn)'
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
        versionNumber: versionRow?.number,
        semver: versionRow?.semver,
        message: versionRow?.message,
        pushedBy: versionRow?.pushedBy,
        appId: versionRow?.appId,
        actorId: versionRow?.actorId,
        createdAt: versionRow?.createdAt,
        arkUrl,
      },
    },)
  }

  if (version !== undefined && versionRow) {
    const url = `/${ownerSlug}/${collectionSlug}/v/${versionRow.number}`
    return c.json({
      type: 'redirect' as const,
      url,
      metadata: {
        type: 'version',
        who: ownerName,
        what: `${collectionName} ${versionRow.semver}`,
        when: formatErcDate(versionRow.createdAt,),
        where: arkUrl,
        naan: resolvedNaan,
        collectionName,
        ownerName,
        versionNumber: versionRow.number,
        semver: versionRow.semver,
        message: versionRow.message,
        pushedBy: versionRow.pushedBy,
        appId: versionRow.appId,
        actorId: versionRow.actorId,
        createdAt: versionRow.createdAt,
        arkUrl,
      },
    },)
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
      when: versionRow ? formatErcDate(versionRow.createdAt,) : '(:unkn)',
      where: arkUrl,
      naan: resolvedNaan,
      collectionName,
      ownerName,
      versionNumber: versionRow?.number,
      semver: versionRow?.semver,
      createdAt: versionRow?.createdAt,
      arkUrl,
    },
  },)
}

// --- Collection ARK settings ---

export async function getArk(c: Context<AuthEnv>,) {
  const owner = c.req.param('owner',)!
  const slug = c.req.param('slug',)!

  const [coll,] = await db
    .select({
      id: schema.collections.id,
      accountId: schema.collections.accountId,
      ownerNaan: schema.accounts.arkNaan,
    },)
    .from(schema.collections,)
    .innerJoin(schema.accounts, eq(schema.collections.accountId, schema.accounts.id,),)
    .where(and(eq(schema.accounts.slug, owner,), eq(schema.collections.slug, slug,),),)
    .limit(1,)
  if (!coll) return c.json({ error: 'Collection not found', }, 404,)

  // Must be owner/member
  const hasAccess = await checkCollectionAccess(coll.accountId, c.get('accountId',)!,)
  if (!hasAccess) return c.json({ error: 'Forbidden', }, 403,)

  const naan = coll.ownerNaan ?? DEFAULT_NAAN

  const [arkRow,] = await db
    .select({
      arkId: schema.arkCollections.arkId,
      enabled: schema.arkCollections.enabled,
      customUrl: schema.arkCollections.customUrl,
      shoulder: schema.arkShoulders.shoulder,
    },)
    .from(schema.arkCollections,)
    .innerJoin(
      schema.arkShoulders,
      eq(schema.arkShoulders.accountId, coll.accountId,),
    )
    .where(eq(schema.arkCollections.collectionId, coll.id,),)
    .limit(1,)

  if (!arkRow) {
    return c.json({ enabled: false, customUrl: null, arkUrl: null, shoulder: null, arkId: null, },)
  }

  const arkUrl = buildArkUrl(naan, arkRow.shoulder, arkRow.arkId,)
  return c.json({
    enabled: arkRow.enabled,
    customUrl: arkRow.customUrl,
    arkUrl,
    shoulder: arkRow.shoulder,
    arkId: arkRow.arkId,
  },)
}

export async function updateArk(c: Context<AuthEnv>,) {
  const owner = c.req.param('owner',)!
  const slug = c.req.param('slug',)!
  const { enabled, customUrl, } = await c.req.json()

  const [coll,] = await db
    .select({ id: schema.collections.id, accountId: schema.collections.accountId, },)
    .from(schema.collections,)
    .innerJoin(schema.accounts, eq(schema.collections.accountId, schema.accounts.id,),)
    .where(and(eq(schema.accounts.slug, owner,), eq(schema.collections.slug, slug,),),)
    .limit(1,)
  if (!coll) return c.json({ error: 'Collection not found', }, 404,)

  const hasAccess = await checkCollectionAccess(coll.accountId, c.get('accountId',)!,)
  if (!hasAccess) return c.json({ error: 'Forbidden', }, 403,)

  const [existing,] = await db
    .select({ collectionId: schema.arkCollections.collectionId, },)
    .from(schema.arkCollections,)
    .where(eq(schema.arkCollections.collectionId, coll.id,),)
    .limit(1,)

  if (!existing) {
    // Collection predates ARK tables — mint now
    await getOrMintShoulder(coll.accountId,)
    const arkId = collectionToArkId(coll.id,)
    await db.insert(schema.arkCollections,).values({
      collectionId: coll.id,
      arkId,
      enabled: enabled ?? true,
      customUrl: customUrl ?? null,
    },)
  } else {
    const updates: Record<string, unknown> = {}
    if (enabled !== undefined) updates.enabled = enabled
    if (customUrl !== undefined) updates.customUrl = customUrl ?? null
    if (Object.keys(updates,).length > 0) {
      await db
        .update(schema.arkCollections,)
        .set(updates,)
        .where(eq(schema.arkCollections.collectionId, coll.id,),)
    }
  }

  return c.json({ ok: true, },)
}

// --- Record type ARK settings ---

export async function getArkRecordTypes(c: Context<AuthEnv>,) {
  const owner = c.req.param('owner',)!
  const slug = c.req.param('slug',)!

  const [coll,] = await db
    .select({ id: schema.collections.id, accountId: schema.collections.accountId, },)
    .from(schema.collections,)
    .innerJoin(schema.accounts, eq(schema.collections.accountId, schema.accounts.id,),)
    .where(and(eq(schema.accounts.slug, owner,), eq(schema.collections.slug, slug,),),)
    .limit(1,)
  if (!coll) return c.json({ error: 'Collection not found', }, 404,)

  const hasAccess = await checkCollectionAccess(coll.accountId, c.get('accountId',)!,)
  if (!hasAccess) return c.json({ error: 'Forbidden', }, 403,)

  const rows = await db
    .select({
      recordType: schema.arkRecordTypes.recordType,
      redirectUrlField: schema.arkRecordTypes.redirectUrlField,
    },)
    .from(schema.arkRecordTypes,)
    .where(eq(schema.arkRecordTypes.collectionId, coll.id,),)

  return c.json(rows,)
}

export async function updateArkRecordTypes(c: Context<AuthEnv>,) {
  const owner = c.req.param('owner',)!
  const slug = c.req.param('slug',)!
  const { recordType, redirectUrlField, } = await c.req.json()

  if (!recordType) return c.json({ error: 'recordType required', }, 400,)

  const [coll,] = await db
    .select({ id: schema.collections.id, accountId: schema.collections.accountId, },)
    .from(schema.collections,)
    .innerJoin(schema.accounts, eq(schema.collections.accountId, schema.accounts.id,),)
    .where(and(eq(schema.accounts.slug, owner,), eq(schema.collections.slug, slug,),),)
    .limit(1,)
  if (!coll) return c.json({ error: 'Collection not found', }, 404,)

  const hasAccess = await checkCollectionAccess(coll.accountId, c.get('accountId',)!,)
  if (!hasAccess) return c.json({ error: 'Forbidden', }, 403,)

  if (redirectUrlField === null) {
    await db
      .delete(schema.arkRecordTypes,)
      .where(
        and(
          eq(schema.arkRecordTypes.collectionId, coll.id,),
          eq(schema.arkRecordTypes.recordType, recordType,),
        ),
      )
  } else {
    await db
      .insert(schema.arkRecordTypes,)
      .values({ collectionId: coll.id, recordType, redirectUrlField, },)
      .onConflictDoUpdate({
        target: [schema.arkRecordTypes.collectionId, schema.arkRecordTypes.recordType,],
        set: { redirectUrlField, },
      },)
  }

  return c.json({ ok: true, },)
}

// --- Org ARK NAAN ---

export async function updateAccountArk(c: Context<AuthEnv>,) {
  const slug = c.req.param('slug',)!
  const { naan, } = await c.req.json()

  if (naan !== null && !/^\d{1,16}$/.test(naan,)) {
    return c.json({ error: 'NAAN must be numeric (up to 16 digits)', }, 400,)
  }

  const [account,] = await db
    .select({ id: schema.accounts.id, type: schema.accounts.type, },)
    .from(schema.accounts,)
    .where(eq(schema.accounts.slug, slug,),)
    .limit(1,)
  if (!account) return c.json({ error: 'Account not found', }, 404,)

  // Must be owner/admin of the org (or the user themselves)
  if (account.type === 'org') {
    const [membership,] = await db
      .select({ role: schema.orgMemberships.role, },)
      .from(schema.orgMemberships,)
      .where(
        and(
          eq(schema.orgMemberships.orgId, account.id,),
          eq(schema.orgMemberships.userId, c.get('accountId',)!,),
        ),
      )
      .limit(1,)
    if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
      return c.json({ error: 'Forbidden', }, 403,)
    }
  } else if (account.id !== c.get('accountId',)) {
    return c.json({ error: 'Forbidden', }, 403,)
  }

  await db.update(schema.accounts,).set({ arkNaan: naan, },).where(eq(schema.accounts.id, account.id,),)
  return c.json({ ok: true, },)
}

// --- Helpers ---

async function checkCollectionAccess(ownerAccountId: string, requestAccountId: string,): Promise<boolean> {
  const [account,] = await db
    .select({ id: schema.accounts.id, type: schema.accounts.type, },)
    .from(schema.accounts,)
    .where(eq(schema.accounts.id, ownerAccountId,),)
    .limit(1,)
  if (!account) return false
  if (account.id === requestAccountId) return true
  if (account.type === 'org') {
    const [membership,] = await db
      .select({ role: schema.orgMemberships.role, },)
      .from(schema.orgMemberships,)
      .where(
        and(
          eq(schema.orgMemberships.orgId, account.id,),
          eq(schema.orgMemberships.userId, requestAccountId,),
        ),
      )
      .limit(1,)
    return !!membership
  }
  return false
}
