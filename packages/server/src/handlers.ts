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
 */
import { readHead } from '@underlay/protocol'
import { and, asc, eq, gt } from 'drizzle-orm'

import * as schema from './db/schema.js'
import './files/files.js'
import { registerJob } from './jobs.js'
import './push/compact.js'
import './push/parallel.js'
import './refs/log.js'
import { laggingPlacements, queueMirrors } from './locations/mirror.js'
import { expireSessions } from './push/finalize.js'
import { appendVersionLog } from './versions/commit.js'
import type { BumpType } from './versions/semver.js'
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
  // Mirrors that fell behind (a failed copy, a missed job) catch up.
  const lagging = await laggingPlacements(ports)
  await ports.jobs.enqueueBatch(
    lagging.map((placementId) => ({ type: 'mirror.version', placementId })),
  )
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
