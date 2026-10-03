/**
 * Job handlers. Imported by every entry so the registry is populated.
 *
 *   version.published   after a CAS publish: webhooks, mirror sync and the
 *                       reference log hang off this (phases 4, 7, 11)
 *   repo.repairLog      rewrite a collection's version log entries that a
 *                       commit failed to write after publishing
 */
import { readHead } from '@underlay/repo'
import { and, asc, eq, gt } from 'drizzle-orm'

import * as schema from './db/schema.js'
import './files/files.js'
import { registerJob } from './jobs.js'
import { appendVersionLog } from './versions/commit.js'

registerJob('version.published', async () => {
  // Webhook deliveries, mirror sync and reference-log segments are added here
  // as their phases land.
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
