/**
 * Job handlers. Imported by every entry so the registry is populated.
 *
 *   version.published   after a CAS publish: webhooks, mirror sync and the
 *                       reference log hang off this (phases 4, 7, 11)
 *   repo.repairLog      rewrite a collection's version log entries that a
 *                       commit failed to write after publishing
 *   push.compact        merge a full tier of a session's runs (push/compact.ts)
 *   commit.unit,        a parallel commit's key-range units and its assembly
 *   commit.assemble     (push/parallel.ts)
 *   mirror.version      copy the next version to a bucket mirror (locations/mirror.ts);
 *                       queued after each publish, and by the sweep for laggards
 *   restore.version     rebuild a collection from a location, a version at a time
 *   maintenance.sweep   the cron's housekeeping (every 10 minutes), storage cleanup included
 *   cleanup.*           storage cleanup runs (cleanup/runs.ts)
 */
import { type BumpType, fsck, readCollectionInfo, readHead } from '@underlay/protocol'
import { and, asc, eq, gt } from 'drizzle-orm'

import './files/files.js'
import { reconcileDue } from './billing/reconcile.js'
import { cleanupTick } from './cleanup/runs.js'
import * as schema from './db/schema.js'
import './push/compact.js'
import './push/parallel.js'
import './refs/log.js'
import { registerJob } from './jobs.js'
import { recheckLocations } from './locations/locations.js'
import './locations/restore.js'
import { laggingPlacements, queueMirrors } from './locations/mirror.js'
import { expireSessions } from './push/finalize.js'
import { appendVersionLog } from './versions/commit.js'
import { enqueueDeliveries, purgeOldDeliveries } from './webhooks/webhooks.js'

registerJob('version.published', async (job, ports) => {
  await enqueueDeliveries(ports, String(job.versionId), job.bump as BumpType)
  await ports.jobs.enqueue({ type: 'refs.index', versionId: String(job.versionId) })
  const [v] = await ports.db
    .select({ collectionId: schema.versions.collectionId })
    .from(schema.versions)
    .where(eq(schema.versions.id, String(job.versionId)))
  if (v) await queueMirrors(ports, v.collectionId)
})

registerJob('maintenance.sweep', async (_job, ports) => {
  await expireSessions(ports)
  await purgeOldDeliveries(ports)
  // Weekly counter reconciliation, a few collections at a time.
  await reconcileDue(ports)
  // Customer storage locations, re-checked daily.
  await recheckLocations(ports)
  // Mirrors that fell behind (a failed copy, a missed job) catch up.
  const lagging = await laggingPlacements(ports)
  await ports.jobs.enqueueBatch(
    lagging.map((placementId) => ({ type: 'mirror.version', placementId })),
  )
  // Storage cleanup: finished sessions and abandoned uploads, stalled runs, the weekly run.
  await cleanupTick(ports)
})

/**
 * fsck a collection's primary repository (protocol fsck): the log under this
 * deployment's key and the keys collection.json declares, every version, tree,
 * body and file. The report goes to the internal area, fsck/<collectionId>.json.
 */
registerJob('repo.fsck', async (job, ports) => {
  const collectionId = String(job.collectionId)
  const repo = await ports.stores.forCollection(collectionId)
  const own = (await ports.signer()).publicKey
  const info = await readCollectionInfo(repo, collectionId)
  const report = await fsck(repo, {
    collectionId,
    trustedKeys: [own, ...(info?.keys ?? []).filter((k) => k.id !== own.id)],
    fileBytes: job.fileBytes === true,
  })
  await ports.stores.internal.put(
    `fsck/${collectionId}.json`,
    JSON.stringify({ ...report, checkedAt: new Date().toISOString() }),
    { contentType: 'application/json' },
  )
  if (!report.ok) console.error(`[fsck] ${collectionId}:`, report.errors.slice(0, 10))
})

registerJob('repo.repairLog', async (job, ports) => {
  const collectionId = String(job.collectionId)
  const repo = await ports.stores.forCollection(collectionId)
  const head = await readHead(repo, collectionId)
  const missing = await ports.db
    .select()
    .from(schema.versions)
    .where(
      and(eq(schema.versions.collectionId, collectionId), gt(schema.versions.seq, head?.seq ?? 0)),
    )
    .orderBy(asc(schema.versions.seq))
  for (const v of missing) await appendVersionLog(ports, repo, collectionId, v)
})
