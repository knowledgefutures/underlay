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
 *   maintenance.sweep   the cron's housekeeping (every 10 minutes), storage cleanup included
 *   cleanup.*           storage cleanup runs (cleanup/runs.ts)
 */
import {
  type BumpType,
  type FsckCursor,
  type FsckReport,
  fsckStep,
  readCollectionInfo,
  readHead,
} from '@underlay/protocol'
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
import { laggingPlacements, queueMirrors } from './locations/mirror.js'
import type { Ports } from './ports.js'
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
  // Last, and on its own: a failure here shouldn't rerun the rest.
  await cleanupTick(ports).catch((err) => console.error('[cleanup] tick failed:', err))
})

/**
 * fsck a collection's primary repository (protocol fsckStep): the log under this
 * deployment's key and the keys collection.json declares, then every version
 * against the one before, so each job checks a bounded number of changes. The
 * report goes to the internal area, fsck/<collectionId>.json, and grows as the
 * job chain runs (`running` until the last step).
 */
export const fsckConfig = { changesPerJob: 1_000_000 }

interface FsckState extends FsckReport {
  running: boolean
  step: number
  cursor: FsckCursor | null
  fileBytes: boolean
  startedAt: string
  checkedAt: string | null
}

const fsckKey = (collectionId: string) => `fsck/${collectionId}.json`

async function saveFsck(ports: Ports, collectionId: string, state: FsckState) {
  await ports.stores.internal.put(fsckKey(collectionId), JSON.stringify(state), {
    contentType: 'application/json',
  })
}

registerJob('repo.fsck', async (job, ports) => {
  const collectionId = String(job.collectionId)
  await saveFsck(ports, collectionId, {
    ok: true,
    errors: [],
    moreErrors: 0,
    versions: 0,
    trees: 0,
    nodes: 0,
    leaves: 0,
    records: 0,
    files: 0,
    log: 'trusted keys',
    running: true,
    step: 0,
    cursor: null,
    fileBytes: job.fileBytes === true,
    startedAt: new Date().toISOString(),
    checkedAt: null,
  })
  await ports.jobs.enqueue({ type: 'repo.fsckStep', collectionId, step: 0 })
})

registerJob('repo.fsckStep', async (job, ports) => {
  const collectionId = String(job.collectionId)
  const obj = await ports.stores.internal.get(fsckKey(collectionId))
  const state = obj ? (JSON.parse(await obj.text()) as FsckState) : null
  if (!state?.running || state.step !== Number(job.step)) return // finished, or a duplicate
  const repo = await ports.stores.forCollection(collectionId)
  const own = (await ports.signer()).publicKey
  const info = await readCollectionInfo(repo, collectionId)
  const { report, cursor } = await fsckStep(repo, {
    collectionId,
    trustedKeys: [own, ...(info?.keys ?? []).filter((k) => k.id !== own.id)],
    fileBytes: state.fileBytes,
    cursor: state.cursor,
    changeBudget: fsckConfig.changesPerJob,
  })
  const room = Math.max(0, 100 - state.errors.length)
  const next: FsckState = {
    ...state,
    ok: state.ok && report.ok,
    errors: [...state.errors, ...report.errors.slice(0, room)],
    moreErrors: state.moreErrors + report.moreErrors + Math.max(0, report.errors.length - room),
    versions: state.versions + report.versions,
    trees: state.trees + report.trees,
    nodes: state.nodes + report.nodes,
    leaves: state.leaves + report.leaves,
    records: state.records + report.records,
    files: state.files + report.files,
    step: state.step + 1,
    cursor,
    running: cursor !== null,
    checkedAt: cursor ? null : new Date().toISOString(),
  }
  await saveFsck(ports, collectionId, next)
  if (cursor) await ports.jobs.enqueue({ type: 'repo.fsckStep', collectionId, step: next.step })
  else if (!next.ok) console.error(`[fsck] ${collectionId}:`, next.errors.slice(0, 10))
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
