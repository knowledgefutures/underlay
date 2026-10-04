/**
 * Reconcile: every billing counter is a cache of something durable, rebuilt here
 * from that source, compared, reported and overwritten (edge-redesign.md,
 * "Metering, and rebuilding the counters"; decision 18).
 *
 *   reconcile.collection   starts a run: one reconcile.version job per version
 *   reconcile.version      one version's totals from its root, and its reference-log
 *                          events and bytes from re-diffing it against the one before
 *   reconcile.finish       the collection: ref counters as the sum over its versions,
 *                          schema usage replayed from the roots, and the cumulative
 *                          public files tree rebuilt from every version's public files
 *
 * Each job is bulk work (jobs.ts). A run is due weekly (the cron sweep starts a
 * few at a time) and stewards can start one (POST /api/admin/reconcile).
 * Differences are logged and kept as the version's or collection's
 * `reconcile_report`; normal operation never makes any, since the counters are
 * written in the publish batch.
 */
import {
  compareUtf8,
  type FileEntry,
  fileTree,
  iterate,
  mergeTree,
  RepoSink,
  RepoSource,
  setRecordTotals,
} from '@underlay/protocol'
import { and, asc, eq, gte, isNull, lt, or, sql } from 'drizzle-orm'

import { chunks } from '../db/chunks.js'
import * as schema from '../db/schema.js'
import { registerJob } from '../jobs.js'
import type { Ports } from '../ports.js'
import { versionEvents } from '../refs/log.js'
import { eventBytes } from '../refs/segments.js'

type Diff = schema.ReconcileDiff
type VersionRow = typeof schema.versions.$inferSelect

export const reconcileConfig = {
  /** How often each collection is reconciled. */
  everyMs: 7 * 24 * 60 * 60 * 1000,
  /** Runs the sweep starts at once. */
  perSweep: 2,
  /** A run not finished after this is started again. */
  staleMs: 24 * 60 * 60 * 1000,
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** What a version's row should say, from its root. */
async function versionTotals(ports: Ports, v: VersionRow) {
  const repo = await ports.stores.forCollection(v.collectionId)
  const root = await repo.root(v.hash)
  const priv = root.private ? await repo.privateSet(root.private) : null
  const pub = setRecordTotals(root.public)
  const pri = priv ? setRecordTotals(priv) : { count: 0, bytes: 0 }
  const typeCounts: Record<string, number> = {}
  const publicTypeCounts: Record<string, number> = {}
  for (const [slug, t] of Object.entries(root.public.types)) {
    typeCounts[slug] = (typeCounts[slug] ?? 0) + t.count
    publicTypeCounts[slug] = t.count
  }
  for (const [slug, t] of Object.entries(priv?.types ?? {}))
    typeCounts[slug] = (typeCounts[slug] ?? 0) + t.count
  const pubFiles = root.public.files
  const privFiles = priv?.files ?? { count: 0, bytes: 0 }
  return {
    recordCount: pub.count + pri.count,
    publicRecordCount: pub.count,
    fileCount: pubFiles.count + privFiles.count,
    totalBytes: pub.bytes + pri.bytes + pubFiles.bytes + privFiles.bytes,
    publicFileCount: pubFiles.count,
    publicTotalBytes: pub.bytes + pubFiles.bytes,
    typeCounts,
    publicTypeCounts,
    hasPrivate: root.private !== null,
  }
}

/** Whether a collection's first version is a fork's copy (it writes no events). */
async function isForkStart(ports: Ports, v: VersionRow) {
  if (v.seq !== 1) return false
  const [f] = await ports.db
    .select({ id: schema.forks.childCollectionId })
    .from(schema.forks)
    .where(eq(schema.forks.childCollectionId, v.collectionId))
  return !!f
}

/** Reconcile one version's row. Returns what it corrected. */
export async function reconcileVersion(ports: Ports, versionId: string): Promise<Diff[]> {
  const { db } = ports
  const [v] = await db.select().from(schema.versions).where(eq(schema.versions.id, versionId))
  if (!v) return []
  const diffs: Diff[] = []
  const want: Partial<typeof schema.versions.$inferInsert> = {}
  for (const [field, value] of Object.entries(await versionTotals(ports, v))) {
    const was = v[field as keyof VersionRow]
    if (!same(was, value)) {
      diffs.push({ field, seq: v.seq, was, now: value })
      Object.assign(want, { [field]: value })
    }
  }
  // Events only count once indexed; an unindexed version adds its own when it is.
  if (v.refsIndexed) {
    let events = 0
    let bytes = 0
    if (!(await isForkStart(ports, v))) {
      for await (const e of versionEvents(ports, v)) {
        events++
        bytes += eventBytes(e)
      }
    }
    // Rows indexed before 0011 have no counts yet: filling them in isn't a correction.
    if (v.refEvents !== null && v.refEvents !== events)
      diffs.push({ field: 'refEvents', seq: v.seq, was: v.refEvents, now: events })
    if (v.refBytes !== null && v.refBytes !== bytes)
      diffs.push({ field: 'refBytes', seq: v.seq, was: v.refBytes, now: bytes })
    Object.assign(want, { refEvents: events, refBytes: bytes })
  }
  if (diffs.length) console.error(`[reconcile] version ${v.id} (seq ${v.seq}):`, diffs)
  await db
    .update(schema.versions)
    .set({ ...want, reconciledAt: new Date(), reconcileReport: diffs.length ? diffs : null })
    .where(eq(schema.versions.id, v.id))
  return diffs
}

/** Start a run for a collection: every version is checked, then the collection. */
export async function startReconcile(ports: Ports, collectionId: string): Promise<boolean> {
  const { db } = ports
  const started = new Date()
  const won = await db
    .update(schema.collections)
    .set({ reconcileStartedAt: started })
    .where(eq(schema.collections.id, collectionId))
    .returning({ id: schema.collections.id })
  if (!won.length) return false
  const versions = await db
    .select({ id: schema.versions.id })
    .from(schema.versions)
    .where(eq(schema.versions.collectionId, collectionId))
  if (versions.length === 0) {
    await ports.jobs.enqueue({ type: 'reconcile.finish', collectionId })
    return true
  }
  await ports.jobs.enqueueBatch(
    versions.map((v) => ({ type: 'reconcile.version', versionId: v.id, collectionId })),
  )
  return true
}

/** After a version: once every version of the run is done, check the collection. */
async function afterVersion(ports: Ports, collectionId: string) {
  const [c] = await ports.db
    .select({ started: schema.collections.reconcileStartedAt })
    .from(schema.collections)
    .where(eq(schema.collections.id, collectionId))
  if (!c?.started) return
  const [left] = await ports.db
    .select({ id: schema.versions.id })
    .from(schema.versions)
    .where(
      and(
        eq(schema.versions.collectionId, collectionId),
        or(isNull(schema.versions.reconciledAt), lt(schema.versions.reconciledAt, c.started)),
      ),
    )
    .limit(1)
  if (!left) await ports.jobs.enqueue({ type: 'reconcile.finish', collectionId })
}

/** The collection's counters, schema usage and public files tree. Returns what it corrected. */
export async function finishReconcile(ports: Ports, collectionId: string): Promise<Diff[]> {
  const { db } = ports
  const [c] = await db
    .select()
    .from(schema.collections)
    .where(eq(schema.collections.id, collectionId))
  if (!c?.reconcileStartedAt) return []
  if (c.reconciledAt && c.reconciledAt >= c.reconcileStartedAt) return [] // already finished
  const versions = await db
    .select()
    .from(schema.versions)
    .where(eq(schema.versions.collectionId, collectionId))
    .orderBy(asc(schema.versions.seq))
  const diffs: Diff[] = []
  const set: Partial<typeof schema.collections.$inferInsert> = {}

  // Reference-log counters: the sum over indexed versions.
  const refEvents = versions.reduce((n, v) => n + (v.refsIndexed ? (v.refEvents ?? 0) : 0), 0)
  const refBytes = versions.reduce((n, v) => n + (v.refsIndexed ? (v.refBytes ?? 0) : 0), 0)
  if (c.refEvents !== refEvents) {
    diffs.push({ field: 'refEvents', was: c.refEvents, now: refEvents })
    set.refEvents = refEvents
  }
  if (c.refBytes !== refBytes) {
    diffs.push({ field: 'refBytes', was: c.refBytes, now: refBytes })
    set.refBytes = refBytes
  }

  // Schema usage, replayed from the roots in order.
  const repo = await ports.stores.forCollection(collectionId)
  type Usage = typeof schema.schemaUsage.$inferInsert
  const rebuilt: Usage[] = []
  const open = new Map<string, Usage>()
  const publicFiles = new Map<string, FileEntry>()
  for (const v of versions) {
    const root = await repo.root(v.hash)
    const priv = root.private ? await repo.privateSet(root.private) : null
    const now = new Map<string, string>()
    for (const [slug, t] of Object.entries(root.public.types))
      now.set(`public\u0000${slug}`, t.schema)
    for (const [slug, t] of Object.entries(priv?.types ?? {}))
      now.set(`private\u0000${slug}`, t.schema)
    for (const [k, u] of open) {
      if (now.get(k) !== u.schemaHash) {
        u.toSeq = v.seq
        open.delete(k)
      }
    }
    for (const [k, hash] of now) {
      if (open.has(k)) continue
      const [usageSet, typeSlug] = k.split('\u0000') as ['public' | 'private', string]
      const u: Usage = {
        schemaHash: hash,
        collectionId,
        typeSlug,
        set: usageSet,
        fromSeq: v.seq,
        toSeq: null,
      }
      rebuilt.push(u)
      open.set(k, u)
    }
    for await (const f of iterate(new RepoSource(fileTree, repo), root.public.files.root))
      publicFiles.set(f.key, f)
  }
  const stored = await db
    .select()
    .from(schema.schemaUsage)
    .where(eq(schema.schemaUsage.collectionId, collectionId))
  const key = (u: Usage) => `${u.set}|${u.typeSlug}|${u.fromSeq}|${u.toSeq ?? ''}|${u.schemaHash}`
  const was = stored.map(key).sort()
  const now = rebuilt.map(key).sort()
  const usageDiffers = !same(was, now)
  if (usageDiffers) diffs.push({ field: 'schemaUsage', was, now })

  // The cumulative public files tree: every file any version's public set held.
  const sink = new RepoSink<FileEntry>(repo)
  const built = await mergeTree(
    new RepoSource(fileTree, repo),
    sink,
    null,
    [...publicFiles.values()]
      .sort((a, b) => compareUtf8(a.key, b.key))
      .map((e) => ({ key: e.key, entry: e })),
  )
  await sink.flush()
  const publicFilesRoot = built.root?.hash ?? null
  if (publicFilesRoot !== c.publicFilesRoot) {
    diffs.push({ field: 'publicFilesRoot', was: c.publicFilesRoot, now: publicFilesRoot })
    set.publicFilesRoot = publicFilesRoot
  }

  const versionDiffs = versions.flatMap((v) => v.reconcileReport ?? [])
  const report = [...versionDiffs, ...diffs]
  if (diffs.length) console.error(`[reconcile] collection ${collectionId}:`, diffs)
  await db.batch([
    ...(usageDiffers
      ? [
          db.delete(schema.schemaUsage).where(eq(schema.schemaUsage.collectionId, collectionId)),
          ...chunks(rebuilt, 14).map((part) => db.insert(schema.schemaUsage).values(part)),
        ]
      : []),
    db
      .update(schema.collections)
      .set({ ...set, reconciledAt: new Date(), reconcileReport: report.length ? report : null })
      .where(eq(schema.collections.id, collectionId)),
  ] as unknown as Parameters<typeof db.batch>[0])
  return report
}

/** Start the runs that are due (the cron sweep). */
export async function reconcileDue(ports: Ports): Promise<number> {
  const now = Date.now()
  const due = await ports.db
    .select({ id: schema.collections.id })
    .from(schema.collections)
    .where(
      and(
        or(
          isNull(schema.collections.reconciledAt),
          lt(schema.collections.reconciledAt, new Date(now - reconcileConfig.everyMs)),
        ),
        or(
          isNull(schema.collections.reconcileStartedAt),
          lt(schema.collections.reconcileStartedAt, new Date(now - reconcileConfig.staleMs)),
          // Finished since it last started: due again only by reconciledAt above.
          gte(schema.collections.reconciledAt, schema.collections.reconcileStartedAt),
        ),
      ),
    )
    .orderBy(
      sql`${schema.collections.reconciledAt} IS NOT NULL`,
      asc(schema.collections.reconciledAt),
    )
    .limit(reconcileConfig.perSweep)
  for (const c of due) await startReconcile(ports, c.id)
  return due.length
}

registerJob('reconcile.collection', async (job, ports) => {
  await startReconcile(ports, String(job.collectionId))
})
registerJob('reconcile.version', async (job, ports) => {
  await reconcileVersion(ports, String(job.versionId))
  await afterVersion(ports, String(job.collectionId))
})
registerJob('reconcile.finish', async (job, ports) => {
  await finishReconcile(ports, String(job.collectionId))
})
