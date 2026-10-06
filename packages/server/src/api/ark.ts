/**
 * ARKs (v1 shapes).
 *
 *   GET    /api/ark/resolve?path=ark:NAAN/…                        {type:'redirect', url, metadata} | 404 {type:'not_found'}
 *   GET    /api/collections/:owner/:slug/ark                       {enabled, customUrl, arkUrl, shoulder, arkId}
 *   PATCH  /api/collections/:owner/:slug/ark                       {enabled?, customUrl?}
 *   GET    /api/collections/:owner/:slug/ark/record-types          [{recordType, redirectUrlField}]
 *   PATCH  /api/collections/:owner/:slug/ark/record-types          {recordType, redirectUrlField | null}
 *   PUT    /api/collections/:owner/:slug/ark/record-types          {recordType, redirectUrlField}
 *   DELETE /api/collections/:owner/:slug/ark/record-types/:type
 *   PATCH  /api/accounts/:slug/ark                                 {naan | null}
 *   GET    /ark:NAAN/…                                             302, ?info / ?? ERC text, ?json metadata
 *
 * Resolution sees what the caller may read: a non-member resolves only public
 * collections and their public set, as everywhere else in v2.
 */
import { and, asc, eq, ne, sql } from 'drizzle-orm'
import { type Context, Hono } from 'hono'

import type { AppEnv } from '../app.js'
import * as schema from '../db/schema.js'
import {
  buildArkUrl,
  buildErc,
  collectionToArkId,
  DEFAULT_NAAN,
  formatErcDate,
  nextShoulderCounter,
  parseArkPath,
} from '../lib/ark.js'
import { deniedHashes } from '../lib/limits.js'
import type { Db, Ports } from '../ports.js'
import { findVersion, getRecord, loadView, type VersionRow } from '../versions/view.js'
import {
  capRole,
  type CollectionAccess,
  collectionAccess,
  jsonError,
  type Principal,
} from './access.js'

// --- Shoulders and collection ARKs (also for wiring ARK fields into other routes) ---

/** The org's shoulder, if it has one. */
export async function orgShoulder(db: Db, organizationId: string): Promise<string | null> {
  const [row] = await db
    .select({ shoulder: schema.arkShoulders.shoulder })
    .from(schema.arkShoulders)
    .where(eq(schema.arkShoulders.organizationId, organizationId))
    .orderBy(asc(schema.arkShoulders.createdAt))
    .limit(1)
  return row?.shoulder ?? null
}

export async function getOrMintShoulder(db: Db, organizationId: string): Promise<string> {
  const existing = await orgShoulder(db, organizationId)
  if (existing) return existing

  for (let attempt = 0; attempt < 10; attempt++) {
    const [countRow] = await db.select({ count: sql<number>`count(*)` }).from(schema.arkShoulders)
    const counter = nextShoulderCounter(countRow?.count ?? 0)
    const digit = Math.floor(Math.random() * 10).toString()
    const shoulder = `ul${counter}${digit}`
    // A concurrent mint can take the same shoulder; nothing inserted means retry.
    const inserted = await db
      .insert(schema.arkShoulders)
      .values({ organizationId, shoulder })
      .onConflictDoNothing()
      .returning({ shoulder: schema.arkShoulders.shoulder })
    if (inserted[0]) return inserted[0].shoulder
  }
  throw new Error('Failed to mint ARK shoulder after 10 attempts')
}

/** Mint a collection's ARK (and its org's shoulder) if it has none. For collection creation. */
export async function ensureCollectionArk(
  db: Db,
  collection: { id: string; organizationId: string },
): Promise<void> {
  await getOrMintShoulder(db, collection.organizationId)
  await db
    .insert(schema.arkCollections)
    .values({ collectionId: collection.id, arkId: collectionToArkId(collection.id) })
    .onConflictDoNothing()
}

/**
 * The collection's ARK URL builder (a version's with a semver), or null when the
 * collection has no enabled ARK.
 */
export async function collectionArk(
  db: Db,
  collectionId: string,
  owner: { id: string; arkNaan: string | null },
): Promise<((semver?: string) => string) | null> {
  const [row] = await db
    .select()
    .from(schema.arkCollections)
    .where(eq(schema.arkCollections.collectionId, collectionId))
    .limit(1)
  if (!row?.enabled) return null
  const shoulder = await orgShoulder(db, owner.id)
  if (!shoulder) return null
  return (semver) => buildArkUrl(owner.arkNaan ?? DEFAULT_NAAN, shoulder, row.arkId, semver)
}

// --- Resolution ---

export type ArkResolution =
  | { type: 'redirect'; url: string; metadata: Record<string, unknown> }
  | { type: 'not_found'; error?: string }

const notFound: ArkResolution = { type: 'not_found' }

/**
 * Resolve `ark:NAAN/name` (anything before "ark:" is ignored) for a caller.
 * Returns null when the string isn't an ARK at all.
 */
export async function resolveArk(
  ports: Ports,
  principal: Principal | null,
  path: string,
): Promise<ArkResolution | null> {
  const { db } = ports
  const arkLabelIdx = path.indexOf('ark:')
  if (arkLabelIdx === -1) return null

  let afterLabel = path.slice(arkLabelIdx + 4)
  // "ark:/NAAN/…" is the older spelling of "ark:NAAN/…"; the ARK spec treats them as one.
  if (afterLabel.startsWith('/')) afterLabel = afterLabel.slice(1)
  const slashIdx = afterLabel.indexOf('/')
  if (slashIdx === -1) return notFound
  const naan = afterLabel.slice(0, slashIdx)
  const pathAfterNaan = afterLabel.slice(slashIdx + 1)
  if (!pathAfterNaan) return notFound

  let components
  try {
    components = parseArkPath(pathAfterNaan)
  } catch {
    // decodeURIComponent throws on malformed escapes
    return notFound
  }
  if (!components) return notFound
  const { shoulder, collectionArkId, version, recordType, recordId } = components

  const [shoulderRow] = await db
    .select({ organizationId: schema.arkShoulders.organizationId })
    .from(schema.arkShoulders)
    .where(eq(schema.arkShoulders.shoulder, shoulder))
    .limit(1)
  if (!shoulderRow) return notFound

  const [row] = await db
    .select({
      ark: schema.arkCollections,
      collection: schema.collections,
      owner: schema.organization,
    })
    .from(schema.arkCollections)
    .innerJoin(schema.collections, eq(schema.arkCollections.collectionId, schema.collections.id))
    .innerJoin(schema.organization, eq(schema.collections.organizationId, schema.organization.id))
    .where(eq(schema.arkCollections.arkId, collectionArkId))
    .limit(1)
  if (!row || !row.ark.enabled) return notFound
  // The shoulder must be the collection owner's: another org's shoulder in
  // front of this collection's id is not its ARK.
  if (shoulderRow.organizationId !== row.collection.organizationId) return notFound

  // Same visibility as the collection page: a private collection doesn't
  // resolve (or reveal its name, owner and versions) to non-members.
  const access = await collectionAccess(db, principal, row.owner.slug, row.collection.slug)
  if (!access?.canRead) return notFound
  const member = access.isMember

  const { collection, owner } = row
  const resolvedNaan = owner.arkNaan ?? naan

  let v: VersionRow | null = null
  if (version !== undefined) {
    v = await findVersion(db, collection.id, version, collection.headVersionId)
    if (!v) return notFound
  } else if (collection.headVersionId) {
    v = await findVersion(db, collection.id, 'latest', collection.headVersionId)
  }

  const arkUrl = buildArkUrl(
    resolvedNaan,
    shoulder,
    collectionArkId,
    version !== undefined ? v!.semver : undefined,
    recordType,
    recordId,
  )
  const base = {
    who: owner.name,
    where: arkUrl,
    naan: resolvedNaan,
    collectionName: collection.name,
    ownerName: owner.name,
  }
  // Who pushed is for members only, as on the versions routes (v1 leaked it here).
  const versionFields = (x: VersionRow) => ({
    semver: x.semver,
    message: x.message,
    ...(member ? { pushedBy: x.pushedBy, actorId: x.actorId } : {}),
    appId: x.appId,
    createdAt: x.createdAt,
  })

  if (recordType && recordId) {
    const [rt] = await db
      .select({ redirectUrlField: schema.arkRecordTypes.redirectUrlField })
      .from(schema.arkRecordTypes)
      .where(
        and(
          eq(schema.arkRecordTypes.collectionId, collection.id),
          eq(schema.arkRecordTypes.recordType, recordType),
        ),
      )
      .limit(1)
    if (!rt || !v) return notFound

    // Non-members get the public set only: a private-set record is not found.
    const repo = await ports.stores.forCollection(collection.id)
    const view = await loadView(repo, v, member, await deniedHashes(db))
    const type = view.types.find((t) => t.slug === recordType)
    const rec = type ? await getRecord(view, type, recordId) : null
    if (!type || !rec) return notFound
    const { data } = JSON.parse(rec.body!) as { data: Record<string, unknown> }
    const typeSchema = await repo.schema(type.schemaHash)

    // Only http(s) targets: anything else (javascript:, data:) is an open redirect.
    const redirectUrl = data?.[rt.redirectUrlField]
    if (!isHttpUrl(redirectUrl)) return { type: 'not_found', error: 'No URL found for this record' }

    return {
      type: 'redirect',
      url: redirectUrl,
      metadata: {
        type: 'record',
        ...base,
        what: `${recordType} ${recordId} in ${collection.name}`,
        when: formatErcDate(v.createdAt),
        semver: v.semver,
        recordType,
        recordId,
        schema: typeSchema,
        data,
        createdAt: v.createdAt,
        arkUrl,
      },
    }
  }

  const kind = version !== undefined ? 'version' : 'collection'
  if (row.ark.customUrl) {
    return {
      type: 'redirect',
      url: row.ark.customUrl,
      metadata: {
        type: kind,
        ...base,
        what: v ? `${collection.name} ${v.semver}` : collection.name,
        when: v ? formatErcDate(v.createdAt) : '(:unkn)',
        ...(v ? versionFields(v) : {}),
        arkUrl,
      },
    }
  }

  if (version !== undefined && v) {
    // Page URLs use the bare semver (/v/1.0.0); stored semver is "v1.0.0".
    return {
      type: 'redirect',
      url: `/${owner.slug}/${collection.slug}/v/${v.semver.replace(/^v/, '')}`,
      metadata: {
        type: 'version',
        ...base,
        what: `${collection.name} ${v.semver}`,
        when: formatErcDate(v.createdAt),
        ...versionFields(v),
        arkUrl,
      },
    }
  }

  return {
    type: 'redirect',
    url: `/${owner.slug}/${collection.slug}`,
    metadata: {
      type: 'collection',
      ...base,
      what: collection.name,
      when: v ? formatErcDate(v.createdAt) : '(:unkn)',
      ...(v ? { semver: v.semver, createdAt: v.createdAt } : {}),
      arkUrl,
    },
  }
}

// --- /ark: URLs ---

const policy = (naan: string) =>
  [
    `The Underlay assigns identifiers within the ARK domain ${naan} with the following principles:`,
    '',
    '1. Persistence: ARKs are never reassigned. Once minted, an ARK will always resolve to the same collection or record, or return a tombstone response if the object has been deleted.',
    '',
    '2. Transparency: Appending ?info or ?? to any ARK returns an Electronic Resource Citation (ERC) describing the identified object.',
    '',
    '3. Openness: ARKs are free, open identifiers requiring no licensing fees. The Underlay uses the ARK scheme as specified by the ARK Alliance.',
    '',
    '4. Scope: Underlay ARKs primarily identify versioned data collections and the records within them. Collection ARKs redirect to the collection overview; version-qualified ARKs redirect to specific version pages; record ARKs redirect to the canonical URL of the identified record.',
    '',
    `For more information, see: https://underlay.org/ark:${naan}/`,
  ].join('\n')

const text = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } })

/** GET /ark:NAAN/…: the NAAN's policy, an ERC (?info, ??), the metadata (?json), or a 302. */
async function arkPage(c: Context<AppEnv>): Promise<Response> {
  const url = new URL(c.req.url)
  const fullPath = url.pathname.slice(1)
  let afterLabel = fullPath.slice(4)
  if (afterLabel.startsWith('/')) afterLabel = afterLabel.slice(1)
  const slashIdx = afterLabel.indexOf('/')
  const naan = slashIdx === -1 ? afterLabel : afterLabel.slice(0, slashIdx)
  const afterNaan = slashIdx === -1 ? '' : afterLabel.slice(slashIdx + 1)
  if (!afterNaan.trim()) return text(policy(naan))

  // In process, as the caller: a Worker can't fetch its own zone, and members
  // should resolve what they can read.
  const res = await resolveArk(c.var.ports, c.var.principal, fullPath)
  if (!res || res.type === 'not_found') return text('ARK not found', 404)

  const { metadata } = res
  const search = url.search
  if (search === '?info' || search === '??' || search === '%3F%3F') {
    const m = metadata as Record<string, string | undefined>
    return text(
      buildErc({
        type: metadata.type as 'collection' | 'version' | 'record',
        who: m.who ?? m.ownerName ?? '(:unkn)',
        what: m.what ?? m.collectionName ?? '(:unkn)',
        when: m.when ?? '(:unkn)',
        where: m.where ?? m.arkUrl ?? '(:unkn)',
        naan: m.naan ?? DEFAULT_NAAN,
      }),
    )
  }
  if (search === '?json') {
    return new Response(JSON.stringify(metadata, null, 2), {
      headers: { 'content-type': 'application/json' },
    })
  }
  // The deployment's public origin, not the request's: behind a proxy the
  // request URL can be the internal one.
  const target = res.url.startsWith('/') ? `${c.var.config.appUrl}${res.url}` : res.url
  return c.redirect(target, 302)
}

// --- Settings access ---

/**
 * ARK settings are for members of the owning org (v1: any role). A private
 * collection stays a 404 to everyone else; a public one is 401/403.
 */
async function requireArkMember(
  c: Context<AppEnv>,
  write: boolean,
): Promise<CollectionAccess | Response> {
  const access = await collectionAccess(
    c.var.ports.db,
    c.var.principal,
    c.req.param('owner') ?? '',
    c.req.param('slug') ?? '',
  )
  if (!access?.canRead) return jsonError(c, 404, 'Collection not found')
  if (!access.isMember || (write && !access.canWrite)) {
    return c.var.principal
      ? jsonError(c, 403, 'Forbidden')
      : jsonError(c, 401, 'Authentication required')
  }
  return access
}

async function setRecordType(
  c: Context<AppEnv>,
  collectionId: string,
  recordType: string,
  redirectUrlField: string | null,
) {
  const { db } = c.var.ports
  if (redirectUrlField === null) {
    await db
      .delete(schema.arkRecordTypes)
      .where(
        and(
          eq(schema.arkRecordTypes.collectionId, collectionId),
          eq(schema.arkRecordTypes.recordType, recordType),
        ),
      )
  } else {
    await db
      .insert(schema.arkRecordTypes)
      .values({ collectionId, recordType, redirectUrlField })
      .onConflictDoUpdate({
        target: [schema.arkRecordTypes.collectionId, schema.arkRecordTypes.recordType],
        set: { redirectUrlField },
      })
  }
  return c.json({ ok: true })
}

export function arkRoutes() {
  const app = new Hono<AppEnv>()

  app.get('/api/ark/resolve', async (c) => {
    const path = c.req.query('path')
    if (!path) return jsonError(c, 400, 'Missing path')
    const res = await resolveArk(c.var.ports, c.var.principal, path)
    if (!res) return jsonError(c, 400, 'Invalid ARK path')
    return res.type === 'not_found' ? c.json(res, 404) : c.json(res)
  })

  app.get('/api/collections/:owner/:slug/ark', async (c) => {
    const access = await requireArkMember(c, false)
    if (access instanceof Response) return access
    const { db } = c.var.ports
    const [row] = await db
      .select()
      .from(schema.arkCollections)
      .where(eq(schema.arkCollections.collectionId, access.collection.id))
      .limit(1)
    const shoulder = row ? await orgShoulder(db, access.owner.id) : null
    if (!row || !shoulder)
      return c.json({ enabled: false, customUrl: null, arkUrl: null, shoulder: null, arkId: null })
    return c.json({
      enabled: row.enabled,
      customUrl: row.customUrl,
      arkUrl: buildArkUrl(access.owner.arkNaan ?? DEFAULT_NAAN, shoulder, row.arkId),
      shoulder,
      arkId: row.arkId,
    })
  })

  app.patch('/api/collections/:owner/:slug/ark', async (c) => {
    const access = await requireArkMember(c, true)
    if (access instanceof Response) return access
    const body = (await c.req.json().catch(() => null)) as {
      enabled?: unknown
      customUrl?: unknown
    } | null
    if (!body) return jsonError(c, 400, 'Invalid JSON')
    const { enabled, customUrl } = body
    if (enabled !== undefined && typeof enabled !== 'boolean')
      return jsonError(c, 400, 'enabled must be a boolean')
    // The resolver redirects to customUrl, so only http(s) targets are allowed —
    // anything else (javascript:, data:, protocol-relative) is an open redirect.
    if (customUrl != null && customUrl !== '' && !isHttpUrl(customUrl))
      return jsonError(c, 422, 'customUrl must be an http(s) URL')
    const url = customUrl === undefined ? undefined : (customUrl as string | null) || null

    const { db } = c.var.ports
    const coll = access.collection
    const [existing] = await db
      .select({ collectionId: schema.arkCollections.collectionId })
      .from(schema.arkCollections)
      .where(eq(schema.arkCollections.collectionId, coll.id))
      .limit(1)
    if (!existing) {
      // v2 collections aren't minted an ARK at creation (yet): mint on first enable.
      await getOrMintShoulder(db, coll.organizationId)
      await db.insert(schema.arkCollections).values({
        collectionId: coll.id,
        arkId: collectionToArkId(coll.id),
        enabled: enabled ?? true,
        customUrl: url ?? null,
      })
    } else {
      const updates: { enabled?: boolean; customUrl?: string | null } = {}
      if (enabled !== undefined) updates.enabled = enabled
      if (url !== undefined) updates.customUrl = url
      if (Object.keys(updates).length > 0)
        await db
          .update(schema.arkCollections)
          .set(updates)
          .where(eq(schema.arkCollections.collectionId, coll.id))
    }
    // collection.json carries the collection's ARK (spec 11.1).
    await c.var.ports.jobs.enqueue({ type: 'collection.info', collectionId: coll.id })
    return c.json({ ok: true })
  })

  app.get('/api/collections/:owner/:slug/ark/record-types', async (c) => {
    const access = await requireArkMember(c, false)
    if (access instanceof Response) return access
    const rows = await c.var.ports.db
      .select({
        recordType: schema.arkRecordTypes.recordType,
        redirectUrlField: schema.arkRecordTypes.redirectUrlField,
      })
      .from(schema.arkRecordTypes)
      .where(eq(schema.arkRecordTypes.collectionId, access.collection.id))
      .orderBy(asc(schema.arkRecordTypes.recordType))
    return c.json(rows)
  })

  // PATCH is v1's (null removes); PUT sets and DELETE removes, for clients that prefer them.
  for (const method of ['patch', 'put'] as const) {
    app[method]('/api/collections/:owner/:slug/ark/record-types', async (c) => {
      const access = await requireArkMember(c, true)
      if (access instanceof Response) return access
      const body = (await c.req.json().catch(() => null)) as {
        recordType?: unknown
        redirectUrlField?: unknown
      } | null
      const { recordType, redirectUrlField } = body ?? {}
      if (typeof recordType !== 'string' || !recordType)
        return jsonError(c, 400, 'recordType required')
      const removes = method === 'patch' && redirectUrlField === null
      if (!removes && (typeof redirectUrlField !== 'string' || !redirectUrlField))
        return jsonError(c, 400, 'redirectUrlField required')
      return setRecordType(
        c,
        access.collection.id,
        recordType,
        removes ? null : (redirectUrlField as string),
      )
    })
  }

  app.delete('/api/collections/:owner/:slug/ark/record-types/:recordType', async (c) => {
    const access = await requireArkMember(c, true)
    if (access instanceof Response) return access
    return setRecordType(c, access.collection.id, c.req.param('recordType'), null)
  })

  app.patch('/api/accounts/:slug/ark', async (c) => {
    const { db } = c.var.ports
    const body = (await c.req.json().catch(() => null)) as { naan?: unknown } | null
    const naan = body?.naan
    if (naan !== null && (typeof naan !== 'string' || !/^\d{1,16}$/.test(naan)))
      return jsonError(c, 400, 'NAAN must be numeric (up to 16 digits)')

    const [org] = await db
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.slug, c.req.param('slug')))
      .limit(1)
    if (!org) return jsonError(c, 404, 'Org not found')

    // Owner or admin of the org, as in v1, acting with a session or an admin key
    // (capRole). Scoped, read-only and write keys can't.
    const p = c.var.principal
    if (!p) return jsonError(c, 401, 'Authentication required')
    let role: string | null = null
    if (!p.collectionIds && p.scope !== 'read') {
      if (p.orgId) role = p.orgId === org.id ? 'owner' : null
      else {
        const [m] = await db
          .select({ role: schema.member.role })
          .from(schema.member)
          .where(and(eq(schema.member.organizationId, org.id), eq(schema.member.userId, p.userId)))
          .limit(1)
        role = m?.role ?? null
      }
      role = capRole(p, role)
    }
    if (role !== 'owner' && role !== 'admin') return jsonError(c, 403, 'Forbidden')

    // Whether a NAAN is registered to the org can't be checked here, but it must
    // not collide with the instance's own NAAN or another org's claim — ARK
    // resolution keys on it.
    if (naan !== null) {
      const [taken] = await db
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .where(and(eq(schema.organization.arkNaan, naan), ne(schema.organization.id, org.id)))
        .limit(1)
      if (naan === DEFAULT_NAAN || taken) return jsonError(c, 409, 'That NAAN is already in use')
    }
    await db
      .update(schema.organization)
      .set({ arkNaan: naan })
      .where(eq(schema.organization.id, org.id))
    await c.var.ports.jobs.enqueue({ type: 'collection.info.org', organizationId: org.id })
    return c.json({ ok: true })
  })

  // `{ark:.+}` matches across slashes: /ark:NAAN/name/Type/id.
  app.get('/:ark{ark:.+}', arkPage)

  return app
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const { protocol } = new URL(value)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}
