/**
 * collection.json (spec 11.1): what a repository says about its collection
 * without a server: the owner, names, description, visibility, ARK and signing
 * keys. A commit writes it before each log entry; anything that changes a member
 * without a version (a rename, visibility, a transfer, ARK settings, the owner's
 * name or slug) queues `collection.info`, which rewrites it and the copy on every
 * mirror that already holds a version.
 *
 *   collection.info            rewrite one collection's collection.json, then its mirrors'
 *   collection.info.org        queue collection.info for each of an organization's collections
 *   collection.info.backfill   queue collection.info for every collection, once: files
 *                              written before 2026-10-05 lack owner ids and visibility
 */
import {
  type CollectionInfo,
  jcs,
  type Repo,
  readCollectionInfo,
  type Signer,
  writeCollectionInfo,
} from '@underlay/protocol'
import { and, asc, eq, gt, isNull } from 'drizzle-orm'

import { collectionArk } from '../api/ark.js'
import * as schema from '../db/schema.js'
import { registerJob } from '../jobs.js'
import { mirrorCollectionInfo } from '../locations/mirror.js'
import type { Ports } from '../ports.js'

/**
 * Keep `collection.json` current. With a signer (a commit about to sign an
 * entry) its key is listed; otherwise the keys stay as they are, since a key
 * stays listed once it has signed (old entries still verify). Without a signer
 * and without an existing file, nothing is written: the collection has no log
 * yet, and its first commit writes the file. Returns the file and whether it
 * changed, or null when nothing was written.
 */
export async function publishCollectionInfo(
  ports: Ports,
  repo: Repo,
  collectionId: string,
  signer?: Signer,
): Promise<{ info: CollectionInfo; changed: boolean } | null> {
  const [row] = await ports.db
    .select({ c: schema.collections, owner: schema.organization })
    .from(schema.collections)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.collections.organizationId))
    .where(eq(schema.collections.id, collectionId))
    .limit(1)
  if (!row) {
    if (signer) throw new Error(`Collection ${collectionId} not found`)
    return null
  }
  const existing = await readCollectionInfo(repo, collectionId)
  if (!existing && !signer) return null
  const keys = signer
    ? [...(existing?.keys ?? []).filter((k) => k.id !== signer.keyId), signer.publicKey]
    : existing!.keys
  // The ARK itself, `ark:NAAN/name`, not the resolver URL the API serves.
  const arkUrl = (await collectionArk(ports.db, collectionId, row.owner))?.()
  const info: CollectionInfo = {
    id: collectionId,
    owner: { id: row.owner.id, did: null, handle: row.owner.slug, name: row.owner.name },
    slug: row.c.slug,
    name: row.c.name,
    description: row.c.summary?.description ?? null,
    visibility: row.c.public ? 'public' : 'private',
    ark: arkUrl ? arkUrl.slice(arkUrl.indexOf('ark:')) : null,
    keys,
  }
  if (existing && jcs(existing) === jcs(info)) return { info, changed: false }
  await writeCollectionInfo(repo, info)
  return { info, changed: true }
}

/** Queue a rewrite of these collections' collection.json (after a change outside a version). */
export async function queueCollectionInfo(ports: Ports, collectionIds: string[]): Promise<void> {
  if (collectionIds.length === 0) return
  await ports.jobs.enqueueBatch(
    collectionIds.map((collectionId) => ({ type: 'collection.info', collectionId })),
  )
}

// Every collection an organization owns, after its name or slug changed. Callers
// enqueue the job rather than import this module: it imports the ARK routes.
registerJob('collection.info.org', async (job, ports) => {
  const rows = await ports.db
    .select({ id: schema.collections.id })
    .from(schema.collections)
    .where(eq(schema.collections.organizationId, String(job.organizationId)))
  await queueCollectionInfo(
    ports,
    rows.map((r) => r.id),
  )
})

registerJob('collection.info', async (job, ports) => {
  const collectionId = String(job.collectionId)
  const repo = await ports.stores.forCollection(collectionId)
  const out = await publishCollectionInfo(ports, repo, collectionId)
  if (out?.changed) await mirrorCollectionInfo(ports, collectionId, out.info)
})

/** Collections per backfill job, before it queues the next page. */
const BACKFILL_PAGE = 500

/** The internal-area marker that says the backfill has been queued. */
export const INFO_BACKFILL_MARKER = 'collection-info/backfill-2026-10-05'

/** Queue the backfill once (the maintenance sweep calls this). */
export async function queueInfoBackfill(ports: Ports): Promise<void> {
  if (await ports.stores.internal.head(INFO_BACKFILL_MARKER)) return
  await ports.stores.internal.put(INFO_BACKFILL_MARKER, new Date().toISOString())
  await ports.jobs.enqueue({ type: 'collection.info.backfill', after: '' })
}

registerJob('collection.info.backfill', async (job, ports) => {
  const after = String(job.after ?? '')
  const rows = await ports.db
    .select({ id: schema.collections.id })
    .from(schema.collections)
    .where(and(gt(schema.collections.id, after), isNull(schema.collections.deletedAt)))
    .orderBy(asc(schema.collections.id))
    .limit(BACKFILL_PAGE)
  await queueCollectionInfo(
    ports,
    rows.map((r) => r.id),
  )
  if (rows.length === BACKFILL_PAGE) {
    await ports.jobs.enqueue({ type: 'collection.info.backfill', after: rows.at(-1)!.id })
  }
})
