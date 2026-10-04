/**
 * The reference log: which collections and versions contain a record or file
 * hash, in which set (edge-redesign.md, "Provenance: the reference log").
 *
 * Index changes, not snapshots. A version's events are the diff between it and
 * the previous version (+ added, - removed, both for an update or a set move),
 * so writing costs O(changes). They're produced by a job after publish — the
 * plan accepts seconds of lag — which is also exactly the rebuild procedure.
 * A fork's first version writes no events; queries extend a parent's intervals
 * into its forks.
 *
 * Storage is a size-tiered LSM of segments (segments.ts): each version adds a
 * tier-0 run; when a tier has FAN_IN runs they merge into one run of the next
 * tier, as hash-range parts run as jobs. Queries read every live run whose
 * segments cover the hash: O(log n) runs, each a cached index check and usually
 * no block read.
 */
import { compareUtf8, diffTrees, fileTree, recordTree, RepoSource } from '@underlay/protocol'
import { and, asc, eq, gte, inArray, lte, sql } from 'drizzle-orm'

import { chunks } from '../db/chunks.js'
import * as schema from '../db/schema.js'
import { registerJob } from '../jobs.js'
import type { Ports } from '../ports.js'
import { mergeRuns, type RunIndex, writeRun } from '../push/runs.js'
import { loadView } from '../versions/view.js'
import {
  compareEvents,
  deleteSegment,
  eventBytes,
  lookupSegment,
  readSegment,
  type RefEvent,
  SegmentWriter,
  type WrittenSegment,
} from './segments.js'

export const FAN_IN = 8
const SPILL_EVENTS = 100_000
/** Events per compaction part, roughly: sizes the hash-range split. */
const PART_EVENTS = 4_000_000

// --- Generating a version's events ---------------------------------------------------

/** A version's events: the diff against the version before it, both sets, records and files. */
export async function* versionEvents(
  ports: Ports,
  version: typeof schema.versions.$inferSelect,
): AsyncGenerator<RefEvent> {
  const repo = await ports.stores.forCollection(version.collectionId)
  const [prev] =
    version.seq > 1
      ? await ports.db
          .select()
          .from(schema.versions)
          .where(
            and(
              eq(schema.versions.collectionId, version.collectionId),
              eq(schema.versions.seq, version.seq - 1),
            ),
          )
      : []
  const now = await loadView(repo, version, true)
  const before = prev ? await loadView(repo, prev, true) : null
  const records = new RepoSource(recordTree, repo)
  const files = new RepoSource(fileTree, repo)
  const c = version.collectionId
  const seq = version.seq
  for (const set of ['public', 'private'] as const) {
    const slugs = new Set([
      ...now.types.map((t) => t.slug),
      ...(before?.types.map((t) => t.slug) ?? []),
    ])
    for (const slug of [...slugs].sort(compareUtf8)) {
      const a = before?.types.find((t) => t.slug === slug)?.[set]?.root ?? null
      const b = now.types.find((t) => t.slug === slug)?.[set]?.root ?? null
      for await (const d of diffTrees(records, a, b)) {
        if (d.before) yield [d.before.hash, 'r', c, set, seq, '-', slug, d.key]
        if (d.after) yield [d.after.hash, 'r', c, set, seq, '+', slug, d.key]
      }
    }
    const fa = (set === 'public' ? before?.public : before?.private)?.files.root ?? null
    const fb = (set === 'public' ? now.public : now.private)?.files.root ?? null
    for await (const d of diffTrees(files, fa, fb)) {
      if (d.before) yield [d.key, 'f', c, set, seq, '-', '', '']
      if (d.after) yield [d.key, 'f', c, set, seq, '+', '', '']
    }
  }
}

/** Sort events by hash, spilling to sorted runs past SPILL_EVENTS (bounded memory). */
async function* sortedEvents(
  ports: Ports,
  scratch: string,
  events: AsyncIterable<RefEvent>,
): AsyncGenerator<RefEvent> {
  let buf: RefEvent[] = []
  const runs: RunIndex[] = []
  const spill = async () => {
    const entries = buf.map((e) => ({
      t: e[0],
      k: JSON.stringify(e.slice(1)),
      b: JSON.stringify(e),
    }))
    runs.push(await writeRun(ports.stores.internal, scratch, runs.length + 1, entries))
    buf = []
  }
  for await (const e of events) {
    buf.push(e)
    if (buf.length >= SPILL_EVENTS) await spill()
  }
  if (runs.length === 0) {
    yield* buf.sort(compareEvents)
    return
  }
  if (buf.length) await spill()
  // Run keys are unique per event, so the merge keeps every event.
  for await (const r of mergeRuns(ports.stores.internal, scratch, runs))
    yield JSON.parse(r.b!) as RefEvent
}

const segmentRows = (
  segs: WrittenSegment[],
  runId: string,
  tier: number,
  state: 'live' | 'pending',
) =>
  segs.map((s) => ({
    id: s.id,
    runId,
    tier,
    firstHash: s.firstHash,
    lastHash: s.lastHash,
    count: s.count,
    bytes: s.bytes,
    state,
  }))

/**
 * Index one version: write its events as a tier-0 run, then record the run, the
 * flag and the collection's billing counters in one batch. Segment ids are
 * derived from the version, so a retried job rewrites the same objects, and the
 * batch only takes effect while the version is still unindexed.
 */
export async function indexVersion(ports: Ports, versionId: string): Promise<void> {
  const { db } = ports
  const [version] = await db.select().from(schema.versions).where(eq(schema.versions.id, versionId))
  if (!version || version.refsIndexed) return
  const [fork] =
    version.seq === 1
      ? await db
          .select()
          .from(schema.forks)
          .where(eq(schema.forks.childCollectionId, version.collectionId))
      : []
  const runId = `v-${versionId}`
  const writer = new SegmentWriter(ports.stores.internal, (n) => `${runId}-${n}`)
  let events = 0
  let bytes = 0
  if (!fork) {
    for await (const e of sortedEvents(ports, `refs-${versionId}`, versionEvents(ports, version))) {
      await writer.add(e)
      events++
      bytes += eventBytes(e)
    }
  }
  const segs = await writer.finish()
  const unindexed = sql`(SELECT ${schema.versions.refsIndexed} FROM ${schema.versions} WHERE ${schema.versions.id} = ${versionId}) = 0`
  const lit = <T>(v: unknown) => sql<T>`${v}`
  await db.batch([
    ...segmentRows(segs, runId, 0, 'live').map((r) =>
      db.insert(schema.refSegments).select(
        db
          .select({
            id: lit<string>(r.id).as('id'),
            runId: lit<string>(r.runId).as('run_id'),
            tier: lit<number>(0).as('tier'),
            firstHash: lit<string>(r.firstHash).as('first_hash'),
            lastHash: lit<string>(r.lastHash).as('last_hash'),
            count: lit<number>(r.count).as('count'),
            bytes: lit<number>(r.bytes).as('bytes'),
            state: lit<string>('live').as('state'),
            createdAt: lit<number>(Date.now()).as('created_at'),
          })
          .from(schema.versions)
          .where(and(eq(schema.versions.id, versionId), unindexed)) as never,
      ),
    ),
    db
      .update(schema.collections)
      .set({
        refEvents: sql`${schema.collections.refEvents} + ${events}`,
        refBytes: sql`${schema.collections.refBytes} + ${bytes}`,
      })
      .where(and(eq(schema.collections.id, version.collectionId), unindexed)),
    db
      .update(schema.versions)
      .set({ refsIndexed: true, refEvents: events, refBytes: bytes })
      .where(eq(schema.versions.id, versionId)),
  ] as unknown as Parameters<typeof db.batch>[0])
  await ports.jobs.enqueue({ type: 'refs.compact' })
}

// --- Compaction ---------------------------------------------------------------------

/** If some tier has FAN_IN live runs, start merging its oldest FAN_IN into one run of the next tier. */
export async function planCompaction(ports: Ports): Promise<void> {
  const { db } = ports
  const running = await db
    .select()
    .from(schema.refCompactions)
    .where(eq(schema.refCompactions.status, 'running'))
    .limit(1)
  if (running.length) return
  const runs = (await db.all(sql`
    SELECT run_id, tier, sum(count) AS events, min(created_at) AS created
    FROM ${schema.refSegments} WHERE state = 'live'
    GROUP BY run_id, tier ORDER BY tier, created
  `)) as { run_id: string; tier: number; events: number; created: number }[]
  const byTier = new Map<number, typeof runs>()
  for (const r of runs) byTier.set(r.tier, [...(byTier.get(r.tier) ?? []), r])
  for (const [tier, list] of [...byTier].sort((a, b) => a[0] - b[0])) {
    if (list.length < FAN_IN) continue
    const inputs = list.slice(0, FAN_IN)
    const total = inputs.reduce((n, r) => n + r.events, 0)
    // Hash-range parts by hex prefix: 16^L parts of roughly PART_EVENTS each.
    let prefixLength = 0
    while (16 ** prefixLength * PART_EVENTS < total && prefixLength < 4) prefixLength++
    const [comp] = await db
      .insert(schema.refCompactions)
      .values({
        tier,
        inputRuns: inputs.map((r) => r.run_id),
        outputRun: `c-${crypto.randomUUID()}`,
        parts: 16 ** prefixLength,
        prefixLength,
      })
      .returning()
    await ports.jobs.enqueueBatch(
      Array.from({ length: comp!.parts }, (_, part) => ({
        type: 'refs.compactPart',
        compactionId: comp!.id,
        part,
      })),
    )
    return
  }
}

const partRange = (part: number, prefixLength: number) => {
  if (prefixLength === 0) return { from: '', to: 'g' }
  const from = part.toString(16).padStart(prefixLength, '0')
  const to =
    part + 1 === 16 ** prefixLength ? 'g' : (part + 1).toString(16).padStart(prefixLength, '0')
  return { from, to }
}

/** Merge one hash range of a compaction's input runs into pending segments of its output run. */
export async function compactPart(ports: Ports, compactionId: string, part: number): Promise<void> {
  const { db } = ports
  const [comp] = await db
    .select()
    .from(schema.refCompactions)
    .where(eq(schema.refCompactions.id, compactionId))
  if (!comp || comp.status !== 'running') return
  const range = partRange(part, comp.prefixLength)
  const inputs = await db
    .select()
    .from(schema.refSegments)
    .where(
      and(
        inArray(schema.refSegments.runId, comp.inputRuns),
        lte(schema.refSegments.firstHash, range.to),
        gte(schema.refSegments.lastHash, range.from),
      ),
    )
    .orderBy(asc(schema.refSegments.firstHash))
  // Each input run, in hash order, as one stream; then a k-way merge by event order.
  const streams = comp.inputRuns.map((run) =>
    (async function* () {
      for (const seg of inputs.filter((s) => s.runId === run))
        yield* readSegment(ports.stores.internal, seg.id, range)
    })(),
  )
  const heads = await Promise.all(streams.map(async (s) => ({ s, h: await s.next() })))
  const writer = new SegmentWriter(ports.stores.internal, (n) => `${comp.outputRun}-${part}-${n}`)
  // Events of deleted collections (tombstoned, and not restored since) go.
  const gone = await deletedCollections(ports)
  for (;;) {
    let best: (typeof heads)[number] | null = null
    for (const x of heads)
      if (!x.h.done && (!best || compareEvents(x.h.value, best.h.value as RefEvent) < 0)) best = x
    if (!best) break
    const event = best.h.value as RefEvent
    if (!gone.has(event[2])) await writer.add(event)
    best.h = await best.s.next()
  }
  const segs = await writer.finish()
  await db.batch([
    ...segmentRows(segs, comp.outputRun, comp.tier + 1, 'pending').map((r) =>
      db.insert(schema.refSegments).values(r).onConflictDoNothing(),
    ),
    db.insert(schema.refCompactionParts).values({ compactionId, part }).onConflictDoNothing(),
  ] as unknown as Parameters<typeof db.batch>[0])
  const [{ done } = { done: 0 }] = (await db.all(
    sql`SELECT count(*) AS done FROM ${schema.refCompactionParts} WHERE compaction_id = ${compactionId}`,
  )) as { done: number }[]
  if (done === comp.parts) await ports.jobs.enqueue({ type: 'refs.finishCompaction', compactionId })
}

/** Ids of tombstoned collections that no collection row holds (a restore lifts the tombstone). */
async function deletedCollections(ports: Ports): Promise<Set<string>> {
  const rows = (await ports.db.all(sql`
    SELECT t.collection_id AS id FROM ${schema.collectionTombstones} t
    WHERE NOT EXISTS (SELECT 1 FROM ${schema.collections} c WHERE c.id = t.collection_id)
  `)) as { id: string }[]
  return new Set(rows.map((r) => r.id))
}

/** Swap a finished compaction in atomically, then delete the inputs' objects. */
export async function finishCompaction(ports: Ports, compactionId: string): Promise<void> {
  const { db } = ports
  const [comp] = await db
    .select()
    .from(schema.refCompactions)
    .where(eq(schema.refCompactions.id, compactionId))
  if (!comp || comp.status !== 'running') return
  const old = await db
    .select({ id: schema.refSegments.id })
    .from(schema.refSegments)
    .where(inArray(schema.refSegments.runId, comp.inputRuns))
  await db.batch([
    db
      .update(schema.refSegments)
      .set({ state: 'live' })
      .where(eq(schema.refSegments.runId, comp.outputRun)),
    db
      .update(schema.refSegments)
      .set({ state: 'retired' })
      .where(inArray(schema.refSegments.runId, comp.inputRuns)),
    db
      .update(schema.refCompactions)
      .set({ status: 'done' })
      .where(eq(schema.refCompactions.id, compactionId)),
  ])
  for (const s of old) await deleteSegment(ports.stores.internal, s.id)
  await db.delete(schema.refSegments).where(inArray(schema.refSegments.runId, comp.inputRuns))
  await ports.jobs.enqueue({ type: 'refs.compact' })
}

registerJob('refs.index', async (job, ports) => indexVersion(ports, String(job.versionId)))
registerJob('refs.compact', async (_job, ports) => planCompaction(ports))
registerJob('refs.compactPart', async (job, ports) =>
  compactPart(ports, String(job.compactionId), Number(job.part)),
)
registerJob('refs.finishCompaction', async (job, ports) =>
  finishCompaction(ports, String(job.compactionId)),
)

// --- Queries ------------------------------------------------------------------------

/** Every event for a hash across live segments. */
export async function eventsFor(ports: Ports, hash: string): Promise<RefEvent[]> {
  const segs = await ports.db
    .select({ id: schema.refSegments.id })
    .from(schema.refSegments)
    .where(
      and(
        eq(schema.refSegments.state, 'live'),
        lte(schema.refSegments.firstHash, hash),
        gte(schema.refSegments.lastHash, hash),
      ),
    )
  const found = await Promise.all(
    segs.map((s) => lookupSegment(ports.stores.internal, ports.cache, s.id, hash)),
  )
  return found.flat().sort(compareEvents)
}

export interface Presence {
  collectionId: string
  set: 'public' | 'private'
  kind: 'r' | 'f'
  type: string
  id: string
  /** First seq containing it, and the first seq that no longer does (null: still present). */
  from: number
  to: number | null
}

/**
 * Fold events into presence intervals per (collection, set, type, id), and
 * extend them into forks: a fork's first version contains whatever its parent's
 * version at the fork point did, until the fork removes it.
 */
export async function presenceOf(ports: Ports, hash: string): Promise<Presence[]> {
  const events = await eventsFor(ports, hash)
  const open = new Map<string, Presence>()
  const out: Presence[] = []
  // Removals with no addition in the same collection: a fork dropping something it inherited.
  const orphanRemovals = new Map<string, number>()
  for (const e of events) {
    const [, kind, collectionId, set, seq, op, type, id] = e
    const key = `${collectionId}\u0000${set}\u0000${type}\u0000${id}`
    if (op === '+') {
      if (!open.has(key)) open.set(key, { collectionId, set, kind, type, id, from: seq, to: null })
    } else {
      const p = open.get(key)
      if (p) {
        p.to = seq
        out.push(p)
        open.delete(key)
      } else if (!orphanRemovals.has(key)) {
        orphanRemovals.set(key, seq)
      }
    }
  }
  out.push(...open.values())
  // Forks: children whose parent contained it at the fork point, one level of
  // the fork graph per query (D1 runs at most 1,000 queries per invocation).
  let frontier = [...out]
  while (frontier.length) {
    const forks: (typeof schema.forks.$inferSelect)[] = []
    for (const part of chunks([...new Set(frontier.map((p) => p.collectionId))])) {
      forks.push(
        ...(await ports.db
          .select()
          .from(schema.forks)
          .where(inArray(schema.forks.parentCollectionId, part))),
      )
    }
    const next: Presence[] = []
    for (const p of frontier) {
      for (const f of forks) {
        if (f.parentCollectionId !== p.collectionId) continue
        if (f.parentSeq < p.from || (p.to !== null && f.parentSeq >= p.to)) continue
        // A fork carries only the sets it was made with.
        if (p.set === 'private' && f.sets !== 'public+private') continue
        // Already inherited. The fork's own presences start after its first version
        // (which writes no events), so a record it removed and added back keeps both.
        if (
          out.some(
            (q) =>
              q.collectionId === f.childCollectionId &&
              q.from === 1 &&
              q.type === p.type &&
              q.id === p.id &&
              q.set === p.set,
          )
        )
          continue
        const removed = orphanRemovals.get(
          `${f.childCollectionId}\u0000${p.set}\u0000${p.type}\u0000${p.id}`,
        )
        const child: Presence = {
          ...p,
          collectionId: f.childCollectionId,
          from: 1,
          to: removed ?? null,
        }
        out.push(child)
        next.push(child)
      }
    }
    frontier = next
  }
  return out
}
