/**
 * Reconcile: every billing counter is a cache of something durable, rebuilt here
 * from that source, compared, reported and overwritten (edge-redesign.md,
 * "Metering, and rebuilding the counters"; decision 21).
 *
 * A run is one chain of `reconcile.step` jobs per collection, so it never floods
 * the bulk queue, and each job handles a bounded number of versions:
 *
 *   versions stage     each version's totals from its root, and its reference-log
 *                      events and bytes from re-diffing it against the one before.
 *                      Versions are immutable, so a scheduled run checks only those
 *                      never checked; a steward's run (`full`) checks them all.
 *   collection stage   schema usage replayed from every root (one or two reads a
 *                      version), and the cumulative public files tree rebuilt from
 *                      the last run's checkpoint by diffing consecutive versions'
 *                      public file trees: O(changes since then), not O(history).
 *                      Then the reference counters as a sum over the versions.
 *
 * The run's progress is `collections.reconcile_state`, advanced by a step number
 * so a duplicate delivery can't fork the chain. A run is due weekly (the cron
 * sweep starts a few at a time) and stewards can start one (POST
 * /api/admin/reconcile). Differences are logged and kept as the version's or
 * collection's `reconcile_report`; normal operation never makes any, since the
 * counters are written in the publish batch.
 */
import {
  compareUtf8,
  diffTrees,
  type FileEntry,
  fileTree,
  mergeTree,
  RepoSink,
  RepoSource,
  setRecordTotals,
} from '@underlay/protocol'
import { and, asc, eq, gt, gte, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'

import { fenceHolds, fenceMoved, writeFence } from '../cleanup/fence.js'
import { chunks } from '../db/chunks.js'
import * as schema from '../db/schema.js'
import { registerJob } from '../jobs.js'
import type { Ports } from '../ports.js'
import { estimatedEvents, versionEvents } from '../refs/log.js'
import { eventBytes } from '../refs/segments.js'

type Diff = schema.ReconcileDiff
type State = schema.ReconcileState
type Usage = schema.UsageSpan
type VersionRow = typeof schema.versions.$inferSelect
type CollectionRow = typeof schema.collections.$inferSelect

export const reconcileConfig = {
  /** How often each collection is reconciled. */
  everyMs: 7 * 24 * 60 * 60 * 1000,
  /** Runs the sweep starts at once. */
  perSweep: 20,
  /** A run not finished after this is started again. */
  staleMs: 24 * 60 * 60 * 1000,
  /** Versions one job checks, or folds into the collection's totals. */
  versionsPerJob: 100,
  /** Events one job re-derives, about (a version's diff against the one before). */
  eventsPerJob: 1_000_000,
  /**
   * A version with more events than this isn't re-diffed: one job couldn't. Its
   * totals are still checked, and its indexed counts stand.
   */
  maxRecountEvents: 5_000_000,
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

/**
 * Reconcile one version's row. Returns what it corrected. A version whose events
 * aren't indexed yet stays unchecked (reconciled_at null), so a later run checks
 * its events once they are.
 */
export async function reconcileVersion(ports: Ports, v: VersionRow): Promise<Diff[]> {
  const { db } = ports
  const diffs: Diff[] = []
  const want: Partial<typeof schema.versions.$inferInsert> = {}
  for (const [field, value] of Object.entries(await versionTotals(ports, v))) {
    const was = v[field as keyof VersionRow]
    if (!same(was, value)) {
      diffs.push({ field, seq: v.seq, was, now: value })
      Object.assign(want, { [field]: value })
    }
  }
  if (v.refsIndexed && estimatedEvents(v) <= reconcileConfig.maxRecountEvents) {
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
    .set({
      ...want,
      reconciledAt: v.refsIndexed ? new Date() : null,
      reconcileReport: diffs.length ? diffs : null,
    })
    .where(eq(schema.versions.id, v.id))
  return diffs
}

/** Start (or restart) a run for a collection. */
export async function startReconcile(
  ports: Ports,
  collectionId: string,
  opts: { full?: boolean } = {},
): Promise<boolean> {
  const state: State = { step: 1, full: opts.full === true, stage: 'versions', afterSeq: 0 }
  const won = await ports.db
    .update(schema.collections)
    .set({ reconcileStartedAt: new Date(), reconcileState: state })
    .where(eq(schema.collections.id, collectionId))
    .returning({ id: schema.collections.id })
  if (!won.length) return false
  await ports.jobs.enqueue({ type: 'reconcile.step', collectionId, step: 1 })
  return true
}

/** The collection stage from its start: a fresh fence, files from the checkpoint. */
async function collectionStart(ports: Ports, c: CollectionRow, s: State): Promise<State> {
  const fromCheckpoint = !s.full && c.reconciledSeq > 0
  return {
    step: s.step,
    full: s.full,
    stage: 'collection',
    afterSeq: 0,
    fence: await writeFence(ports.db),
    filesFrom: fromCheckpoint ? c.reconciledSeq : 0,
    filesRoot: fromCheckpoint ? c.reconciledFilesRoot : null,
    prevFiles: null,
    usage: [],
  }
}

/** Check the next versions; then on to the collection. */
async function versionsStage(ports: Ports, c: CollectionRow, s: State): Promise<State> {
  const rows = await ports.db
    .select()
    .from(schema.versions)
    .where(
      and(
        eq(schema.versions.collectionId, c.id),
        gt(schema.versions.seq, s.afterSeq),
        s.full ? undefined : isNull(schema.versions.reconciledAt),
      ),
    )
    .orderBy(asc(schema.versions.seq))
    .limit(reconcileConfig.versionsPerJob)
  let events = 0
  for (const [i, v] of rows.entries()) {
    await reconcileVersion(ports, v)
    events += estimatedEvents(v)
    if (events >= reconcileConfig.eventsPerJob && i < rows.length - 1)
      return { ...s, afterSeq: v.seq }
  }
  if (rows.length === reconcileConfig.versionsPerJob) return { ...s, afterSeq: rows.at(-1)!.seq }
  return collectionStart(ports, c, s)
}

/** Fold the next versions into the replayed usage and the rebuilt files tree. */
async function foldVersions(ports: Ports, c: CollectionRow, s: State, rows: VersionRow[]) {
  const repo = await ports.stores.forCollection(c.id)
  const source = new RepoSource(fileTree, repo)
  const usage = (s.usage ?? []).map((u) => ({ ...u }))
  const filesFrom = s.filesFrom ?? 0
  let prevFiles = s.prevFiles ?? null
  const added = new Map<string, FileEntry>()
  for (const v of rows) {
    const root = await repo.root(v.hash)
    const priv = root.private ? await repo.privateSet(root.private) : null
    const now = new Map<string, string>()
    for (const [slug, t] of Object.entries(root.public.types))
      now.set(`public\u0000${slug}`, t.schema)
    for (const [slug, t] of Object.entries(priv?.types ?? {}))
      now.set(`private\u0000${slug}`, t.schema)
    const open = new Map(
      usage.filter((u) => u.toSeq === null).map((u) => [`${u.set}\u0000${u.typeSlug}`, u]),
    )
    for (const [k, u] of open) if (now.get(k) !== u.schemaHash) u.toSeq = v.seq
    for (const [k, hash] of now) {
      const o = open.get(k)
      if (o && o.toSeq === null) continue
      const [set, typeSlug] = k.split('\u0000') as ['public' | 'private', string]
      usage.push({ schemaHash: hash, typeSlug, set, fromSeq: v.seq, toSeq: null })
    }
    // Files that entered the public set since the version before.
    const files = root.public.files.root
    if (v.seq > filesFrom) {
      for await (const d of diffTrees(source, prevFiles, files))
        if (d.after && !d.before) added.set(d.key, d.after)
    }
    prevFiles = files
  }
  let filesRoot = s.filesRoot ?? null
  if (added.size) {
    const sink = new RepoSink<FileEntry>(repo)
    const merged = await mergeTree(
      source,
      sink,
      filesRoot,
      [...added.values()]
        .sort((a, b) => compareUtf8(a.key, b.key))
        .map((e) => ({ key: e.key, entry: e })),
    )
    await sink.flush()
    filesRoot = merged.root?.hash ?? null
  }
  return { ...s, afterSeq: rows.at(-1)?.seq ?? s.afterSeq, prevFiles, filesRoot, usage }
}

const usageKey = (u: Usage) =>
  `${u.set}|${u.typeSlug}|${u.fromSeq}|${u.toSeq ?? ''}|${u.schemaHash}`

/**
 * The collection stage: fold versions in a job at a time; at the head, compare
 * and write. Returns null when the run is finished, else the next state.
 */
async function collectionStage(ports: Ports, c: CollectionRow, s: State): Promise<State | null> {
  const { db } = ports
  const rows = await db
    .select()
    .from(schema.versions)
    .where(and(eq(schema.versions.collectionId, c.id), gt(schema.versions.seq, s.afterSeq)))
    .orderBy(asc(schema.versions.seq))
    .limit(reconcileConfig.versionsPerJob)
  const folded = rows.length ? await foldVersions(ports, c, s, rows) : s
  if (rows.length === reconcileConfig.versionsPerJob) return folded

  // At the head, unless a publish moved it meanwhile (then fold that in next).
  const [head] = c.headVersionId
    ? await db
        .select({ seq: schema.versions.seq })
        .from(schema.versions)
        .where(eq(schema.versions.id, c.headVersionId))
    : []
  const headSeq = head?.seq ?? 0
  if (headSeq !== folded.afterSeq) return folded

  const diffs: Diff[] = []
  const set: Partial<typeof schema.collections.$inferInsert> = {}

  // Reference-log counters: the sum over indexed versions. History totals: over all.
  const [sums] = (await db.all(sql`
    SELECT coalesce(sum(CASE WHEN refs_indexed = 1 THEN ref_events END), 0) AS events,
      coalesce(sum(CASE WHEN refs_indexed = 1 THEN ref_bytes END), 0) AS bytes,
      count(*) AS versions, coalesce(sum(total_bytes), 0) AS historyBytes,
      max(created_at) AS lastPushAt
    FROM ${schema.versions} WHERE collection_id = ${c.id}
  `)) as {
    events: number
    bytes: number
    versions: number
    historyBytes: number
    lastPushAt: number | null
  }[]
  const refEvents = Number(sums?.events ?? 0)
  const refBytes = Number(sums?.bytes ?? 0)
  const history = {
    versionCount: Number(sums?.versions ?? 0),
    historyBytes: Number(sums?.historyBytes ?? 0),
    lastPushAt: sums?.lastPushAt == null ? null : Number(sums.lastPushAt),
  }
  for (const [field, now] of Object.entries(history)) {
    const was =
      field === 'lastPushAt' ? (c.lastPushAt?.getTime() ?? null) : c[field as 'versionCount']
    if (was !== now) {
      diffs.push({ field, was, now })
      Object.assign(set, { [field]: field === 'lastPushAt' && now !== null ? new Date(now) : now })
    }
  }
  if (c.refEvents !== refEvents) {
    diffs.push({ field: 'refEvents', was: c.refEvents, now: refEvents })
    set.refEvents = refEvents
  }
  if (c.refBytes !== refBytes) {
    diffs.push({ field: 'refBytes', was: c.refBytes, now: refBytes })
    set.refBytes = refBytes
  }

  // Schema usage.
  const rebuilt = folded.usage ?? []
  const stored = await db
    .select()
    .from(schema.schemaUsage)
    .where(eq(schema.schemaUsage.collectionId, c.id))
  const was = stored.map(usageKey).sort()
  const now = rebuilt.map(usageKey).sort()
  const usageDiffers = !same(was, now)
  if (usageDiffers) diffs.push({ field: 'schemaUsage', was, now })

  // The cumulative public files tree.
  const filesRoot = folded.filesRoot ?? null
  if (filesRoot !== c.publicFilesRoot) {
    diffs.push({ field: 'publicFilesRoot', was: c.publicFilesRoot, now: filesRoot })
    set.publicFilesRoot = filesRoot
  }

  const versionDiffs = (
    await db
      .select({ report: schema.versions.reconcileReport })
      .from(schema.versions)
      .where(
        and(eq(schema.versions.collectionId, c.id), isNotNull(schema.versions.reconcileReport)),
      )
      .limit(100)
  ).flatMap((r) => r.report ?? [])
  const report = [...versionDiffs, ...diffs]
  if (diffs.length) console.error(`[reconcile] collection ${c.id}:`, diffs)
  // The tree's nodes were written across this stage's jobs: the write holds only
  // under the fence read when it began, and only for the head it was built to.
  await db.batch([
    ...(usageDiffers
      ? [
          db.delete(schema.schemaUsage).where(eq(schema.schemaUsage.collectionId, c.id)),
          ...chunks(rebuilt, 14).map((part) =>
            db.insert(schema.schemaUsage).values(part.map((u) => ({ ...u, collectionId: c.id }))),
          ),
        ]
      : []),
    db
      .update(schema.collections)
      .set({
        ...set,
        reconciledAt: new Date(),
        reconcileReport: report.length ? report : null,
        reconcileState: null,
        reconciledSeq: headSeq,
        reconciledFilesRoot: filesRoot,
      })
      .where(
        and(
          eq(schema.collections.id, c.id),
          c.headVersionId
            ? eq(schema.collections.headVersionId, c.headVersionId)
            : isNull(schema.collections.headVersionId),
          sql`json_extract(${schema.collections.reconcileState}, '$.step') = ${s.step}`,
          fenceHolds(s.fence ?? -1),
        ),
      ),
  ] as unknown as Parameters<typeof db.batch>[0])
  const [after] = await db
    .select({ state: schema.collections.reconcileState })
    .from(schema.collections)
    .where(eq(schema.collections.id, c.id))
  if (!after || after.state === null) return null
  // A deletion window opened: the nodes built so far may be gone, so start the stage again.
  if (await fenceMoved(db, s.fence ?? -1)) return collectionStart(ports, c, s)
  return folded // the head moved: fold the new versions in
}

/** One job of a run. */
export async function reconcileStep(ports: Ports, collectionId: string, step: number) {
  const { db } = ports
  const [c] = await db
    .select()
    .from(schema.collections)
    .where(eq(schema.collections.id, collectionId))
  const s = c?.reconcileState
  if (!c || !s || s.step !== step) return // finished, restarted, or a duplicate delivery
  const next =
    s.stage === 'versions' ? await versionsStage(ports, c, s) : await collectionStage(ports, c, s)
  if (!next) return
  const won = await db
    .update(schema.collections)
    .set({ reconcileState: { ...next, step: step + 1 } })
    .where(
      and(
        eq(schema.collections.id, collectionId),
        sql`json_extract(${schema.collections.reconcileState}, '$.step') = ${step}`,
      ),
    )
    .returning({ id: schema.collections.id })
  if (won.length) await ports.jobs.enqueue({ type: 'reconcile.step', collectionId, step: step + 1 })
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
  await startReconcile(ports, String(job.collectionId), { full: job.full === true })
})
registerJob('reconcile.step', async (job, ports) => {
  await reconcileStep(ports, String(job.collectionId), Number(job.step))
})
// Jobs of runs started before migration 0020; the sweep restarts those runs when they go stale.
registerJob('reconcile.version', async () => {})
registerJob('reconcile.finish', async () => {})
