/**
 * Offset indexes for v3 record pages: a cache above the protocol, in the internal area.
 *
 * A page by offset (`?offset=`, the web app's page numbers) had to walk every live record
 * before it: half of a 7.2M-record type took 32 s, and full Crossref would not finish
 * (v3-deploy-plan.md, "Read timing on staging"). The protocol cannot skip by counts,
 * because a version's files overlap. So for each version and type with more than a few
 * pages, this keeps the id of about every `offsetConfig.step`-th live record and its position,
 * at `v3-offsets/<collection>/<seq>/<type>.json`. A page then starts at the nearest
 * point at or before its offset and walks fewer than `offsetConfig.step` records more.
 *
 *   offsetStart     where a page at an offset starts, from the index; null without one
 *   v3.offsets      the job: after each commit (the `version.published` job queues it), and
 *                   when a page finds no index. From the previous version's index and the
 *                   commit's changes when they are few; otherwise it cuts each type into key
 *                   ranges of about `offsetConfig.rangeRecords` (at its files' first keys, or
 *                   their key blocks') and queues:
 *   v3.offsetsRange one range walked, in the pool; the last to finish puts the ranges
 *                   together, each range's positions moved by the counts before it.
 *
 * Positions count live records (`r` entries) without the denylist: a page walks with
 * it, so one blocked record before the point moves a page by one. Only the newest two
 * versions' indexes are kept; an older version's page walks, as before.
 */
import { createObject, type Store, v3 } from '@underlay/protocol'
import { and, eq } from 'drizzle-orm'

import * as schema from '../db/schema.js'
import { registerJob } from '../jobs.js'
import type { Ports } from '../ports.js'

export const offsetConfig = {
  /** Records between points, about: a page walks at most this many past its point. */
  step: 4096,
  /**
   * Records one range of a type's walk holds, about: a job each, in the pool (32 at once).
   * One chain of jobs took about 80 minutes for 120M journal articles (the full Crossref load).
   */
  rangeRecords: 2_000_000,
  /**
   * The farthest a page walks with no index (about 1.5 s): past it, the page answers that
   * its index is being made. A page in the middle of 120M records, walked, ran past the
   * Worker's CPU limit and the client's patience (the full Crossref load).
   */
  walkCap: 250_000,
}
/** Points further apart than this after an update: walk the type again instead. */
const maxGap = () => 4 * offsetConfig.step
/** Bytes of key blocks each file reads at a time while walking. */
const WALK_READ_AHEAD = 2 * 1024 * 1024

export interface OffsetIndex {
  version: number
  /** The version id the index was made for (D1's `versions.hash`). */
  hash: string
  type: string
  /** Live records of the type. */
  count: number
  /** [position, id], in key order; the first is [0, the first id]. */
  points: [number, string][]
}

/** A type's walk cut into key ranges: range i starts at `cuts[i - 1]` and stops before `cuts[i]`. */
interface Plan {
  hash: string
  cuts: string[]
}

/** One range walked: its live records, and [position within the range, id] every `step`. */
interface RangeResult {
  count: number
  points: [number, string][]
}

const typeKey = (collectionId: string, seq: number, type: string) =>
  `v3-offsets/${collectionId}/${seq}/${encodeURIComponent(type)}`
const indexKey = (collectionId: string, seq: number, type: string) =>
  `${typeKey(collectionId, seq, type)}.json`
const planKey = (collectionId: string, seq: number, type: string) =>
  `${typeKey(collectionId, seq, type)}.plan.json`
const rangeKey = (collectionId: string, seq: number, type: string, i: number) =>
  `${typeKey(collectionId, seq, type)}.range-${i}.json`
const combineKey = (collectionId: string, seq: number, type: string) =>
  `${typeKey(collectionId, seq, type)}.combine`

const loaded = new Map<string, OffsetIndex | null>()
const asked = new Set<string>()

async function readJson<T>(ports: Ports, key: string): Promise<T | null> {
  const obj = await ports.stores.internal.get(key)
  return obj ? (JSON.parse(await obj.text()) as T) : null
}

/**
 * Where a page at `offset` starts: the nearest indexed record at or before it, and how
 * many live records to walk from there. Null when the version has no index for the type
 * yet; one is then asked for, once an isolate.
 */
export async function offsetStart(
  ports: Ports,
  collectionId: string,
  version: { seq: number; hash: string },
  type: string,
  offset: number,
): Promise<{ from: v3.Key; skip: number } | null> {
  const key = indexKey(collectionId, version.seq, type)
  let index = loaded.get(key)
  if (index === undefined) {
    index = await readJson<OffsetIndex>(ports, key).catch(() => null)
    if (index && index.hash !== version.hash) index = null
    // A miss is not remembered: the job may write the index a moment later.
    if (index) {
      if (loaded.size > 200) loaded.clear()
      loaded.set(key, index)
    }
  }
  if (!index) {
    if (!asked.has(key)) {
      asked.add(key)
      await ports.jobs
        .enqueue({ type: 'v3.offsets', collectionId, seq: version.seq, only: type })
        .catch(() => {})
    }
    return null
  }
  if (offset >= index.count || index.points.length === 0) return null
  // The last point at or before the offset.
  let lo = 0
  let hi = index.points.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (index.points[mid]![0] <= offset) lo = mid
    else hi = mid - 1
  }
  const [pos, id] = index.points[lo]!
  return { from: { type, id }, skip: offset - pos }
}

/** Live record ids of one type in a version from `from` and before `to`, without the denylist. */
async function* liveIds(
  store: Store,
  view: v3.View,
  type: string,
  from: string | null,
  to: string | null,
) {
  for await (const group of v3.mergeGroups(
    store,
    view,
    {
      type,
      ...(from !== null ? { from: { type, id: from } } : {}),
      ...(to !== null ? { to: { type, id: to } } : {}),
    },
    { readAhead: WALK_READ_AHEAD },
  )) {
    const w = group[group.length - 1]!
    if (w.entry.kind === 'r') yield w.entry.id
  }
}

/**
 * Where to cut a type's walk: about one cut per `rangeRecords` of its `count`, chosen evenly
 * among the first ids of the view's files that begin in the type, or, with too few files
 * for that, the first ids of their key blocks (1,024 entries each).
 */
async function planCuts(store: Store, view: v3.View, type: string, count: number) {
  const want = Math.ceil(count / offsetConfig.rangeRecords)
  if (want <= 1) return []
  const ids = new Set<string>()
  for (const f of view.files) if (f.first?.[0] === type) ids.add(f.first[1])
  if (ids.size < want * 2) {
    const holding = view.files.filter(
      (f) =>
        f.first &&
        f.last &&
        v3.compareKeys(f.first[0], '', type, '') <= 0 &&
        v3.compareKeys(type, '', f.last[0], '\uffff') <= 0,
    )
    for (const f of holding.slice(0, 64)) {
      const file = await v3.SortedFile.open(store, v3.recordKey(f.id), { id: f.id })
      for (const kb of file.content.keyBlocks) if (kb[0] === type) ids.add(kb[1])
    }
  }
  const sorted = [...ids].sort((a, b) => v3.compareKeys(type, a, type, b))
  const cuts: string[] = []
  for (let i = 1; i < want; i++) {
    const c = sorted[Math.floor((i * sorted.length) / want)]
    // A cut at the type's very first id would make an empty first range.
    if (c !== undefined && c !== sorted[0] && c !== cuts[cuts.length - 1]) cuts.push(c)
  }
  return cuts
}

/** The previous version's index, moved forward by what this version changed; null if unfit. */
async function updated(
  ports: Ports,
  view: v3.View,
  prev: OffsetIndex,
  hash: string,
): Promise<OffsetIndex | null> {
  // Each change in key order: +1 for a record that was not live before, -1 for one gone.
  const deltas: [string, number][] = []
  for await (const ch of v3.changes(ports.stores.v3, view, prev.version, {
    type: prev.type,
    before: true,
  })) {
    const was = !!ch.before && !ch.before.withheld
    const is = !!ch.after && !ch.after.withheld
    if (was !== is) deltas.push([ch.id, is ? 1 : -1])
    if (deltas.length > prev.count / 4 + offsetConfig.step) return null
  }
  const points: [number, string][] = []
  let shift = 0
  let d = 0
  for (const [pos, id] of prev.points) {
    while (d < deltas.length && v3.compareKeys(prev.type, deltas[d]![0], prev.type, id) < 0)
      shift += deltas[d++]![1]
    // A point whose record is gone is dropped; one changed in place stays where it was.
    if (d < deltas.length && deltas[d]![0] === id && deltas[d]![1] < 0) continue
    points.push([pos + shift, id])
  }
  while (d < deltas.length) shift += deltas[d++]![1]
  const count = prev.count + shift
  // A record added before the first point is now first: walk again rather than guess.
  if (points[0]?.[0] !== 0) return null
  for (let i = 1; i <= points.length; i++) {
    const next = i < points.length ? points[i]![0] : count
    if (next - points[i - 1]![0] > maxGap()) return null
  }
  return { version: view.version, hash, type: prev.type, count, points }
}

/** Build or update one type's index for a version; true when it is written. */
async function indexType(
  ports: Ports,
  collectionId: string,
  seq: number,
  hash: string,
  type: string,
  view: v3.View,
): Promise<boolean> {
  const internal = ports.stores.internal
  const key = indexKey(collectionId, seq, type)
  if (await internal.head(key)) return true
  const prev =
    seq > 1 ? await readJson<OffsetIndex>(ports, indexKey(collectionId, seq - 1, type)) : null
  if (prev) {
    const next = await updated(ports, view, prev, hash)
    if (next) {
      await internal.put(key, JSON.stringify(next))
      return true
    }
  }
  // Walk the type in ranges, in the pool. The first job to plan names the cuts; the ranges
  // are queued once, by it, and the last range to finish writes the index.
  const pk = planKey(collectionId, seq, type)
  const existing = await readJson<Plan>(ports, pk)
  if (existing?.hash === hash) return false
  if (existing) await internal.delete(pk)
  const [row] = await ports.db
    .select({ typeCounts: schema.versions.typeCounts })
    .from(schema.versions)
    .where(and(eq(schema.versions.collectionId, collectionId), eq(schema.versions.seq, seq)))
    .limit(1)
  const cuts = await planCuts(ports.stores.v3, view, type, row?.typeCounts[type] ?? 0)
  if (!(await createObject(internal, pk, JSON.stringify({ hash, cuts } satisfies Plan))))
    return false
  await ports.jobs.enqueueBatch(
    Array.from({ length: cuts.length + 1 }, (_, i) => ({
      type: 'v3.offsetsRange',
      collectionId,
      seq,
      offsetType: type,
      range: i,
    })),
  )
  return false
}

/** Walk one range of a plan; the last range to finish puts the index together. */
async function walkRange(ports: Ports, collectionId: string, seq: number, type: string, i: number) {
  const internal = ports.stores.internal
  const plan = await readJson<Plan>(ports, planKey(collectionId, seq, type))
  if (!plan || i > plan.cuts.length) return
  const rk = rangeKey(collectionId, seq, type, i)
  if (!(await internal.head(rk))) {
    const view = await v3.openView(ports.stores.v3, collectionId, { version: seq })
    const from = i === 0 ? null : plan.cuts[i - 1]!
    const to = i < plan.cuts.length ? plan.cuts[i]! : null
    const result: RangeResult = { count: 0, points: [] }
    for await (const id of liveIds(ports.stores.v3, view, type, from, to)) {
      if (result.count % offsetConfig.step === 0) result.points.push([result.count, id])
      result.count++
    }
    await internal.put(rk, JSON.stringify(result))
  }
  // Every range walked: one job (the one that creates the claim) puts them together.
  const parts = await Promise.all(
    Array.from({ length: plan.cuts.length + 1 }, (_, j) =>
      readJson<RangeResult>(ports, rangeKey(collectionId, seq, type, j)),
    ),
  )
  if (parts.some((p) => p === null)) return
  if (!(await createObject(internal, combineKey(collectionId, seq, type), '1'))) return
  const points: [number, string][] = []
  let before = 0
  for (const p of parts as RangeResult[]) {
    for (const [pos, id] of p.points) points.push([before + pos, id])
    before += p.count
  }
  const index: OffsetIndex = { version: seq, hash: plan.hash, type, count: before, points }
  await internal.put(indexKey(collectionId, seq, type), JSON.stringify(index))
  for (let j = 0; j <= plan.cuts.length; j++)
    await internal.delete(rangeKey(collectionId, seq, type, j))
  await internal.delete(planKey(collectionId, seq, type))
  await internal.delete(combineKey(collectionId, seq, type))
}

/** Index every type of a version with more than a few pages, and drop older indexes. */
export async function indexVersion(
  ports: Ports,
  collectionId: string,
  seq: number,
  only?: string,
): Promise<void> {
  const [row] = await ports.db
    .select({ hash: schema.versions.hash, typeCounts: schema.versions.typeCounts })
    .from(schema.versions)
    .where(and(eq(schema.versions.collectionId, collectionId), eq(schema.versions.seq, seq)))
    .limit(1)
  if (!row) return
  const types = Object.entries(row.typeCounts)
    .filter(([t, n]) => !t.startsWith('$') && n > offsetConfig.step && (!only || t === only))
    .map(([t]) => t)
  if (types.length === 0) return
  const view = await v3.openView(ports.stores.v3, collectionId, { version: seq })
  // Every type at once: one moved forward here, or its ranges queued to the pool.
  for (const t of types) await indexType(ports, collectionId, seq, row.hash, t, view)
  // The version before stays for a reader that opened it a moment ago; older ones go.
  if (!only && seq > 2) {
    for (const t of types) await ports.stores.internal.delete(indexKey(collectionId, seq - 2, t))
  }
}

registerJob('v3.offsets', async (job, ports) => {
  const only = job.only === undefined ? undefined : String(job.only)
  await indexVersion(ports, String(job.collectionId), Number(job.seq), only)
})

registerJob('v3.offsetsRange', async (job, ports) => {
  await walkRange(
    ports,
    String(job.collectionId),
    Number(job.seq),
    String(job.offsetType),
    Number(job.range),
  )
})
