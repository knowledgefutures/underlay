/**
 * Job handlers. Imported by every entry so the registry is populated.
 *
 *   version.published   after a CAS publish: webhooks, mirror sync and the
 *                       reference log hang off this (phases 4, 7, 11)
 *   repo.repairLog      rewrite a collection's version log entries that a
 *                       commit failed to write after publishing
 *   push.compact        merge a full tier of a session's runs (push/compact.ts)
 */
import { readHead } from '@underlay/repo'
import { and, asc, eq, gt } from 'drizzle-orm'

import * as schema from './db/schema.js'
import './files/files.js'
import './push/compact.js'
import './refs/log.js'
import { registerJob } from './jobs.js'
import { expireSessions } from './push/finalize.js'
import { appendVersionLog } from './versions/commit.js'
import type { BumpType } from './versions/semver.js'
import { enqueueDeliveries, purgeOldDeliveries } from './webhooks/webhooks.js'

registerJob('version.published', async (job, ports) => {
  await enqueueDeliveries(ports, String(job.versionId), job.bump as BumpType)
  await ports.jobs.enqueue({ type: 'refs.index', versionId: String(job.versionId) })
  // Mirror sync (phase 11) and reference-log segments (phase 7) hang off here too.
})

registerJob('maintenance.sweep', async (_job, ports) => {
  await expireSessions(ports)
  await purgeOldDeliveries(ports)
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
