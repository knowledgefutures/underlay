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
 *                   commit's changes when they are few; otherwise by walking the type, a
 *                   job for each `offsetConfig.walkChunk` records, resuming from a partial index.
 *
 * Positions count live records (`r` entries) without the denylist: a page walks with
 * it, so one blocked record before the point moves a page by one. Only the newest two
 * versions' indexes are kept; an older version's page walks, as before.
 */
import { type Store, v3 } from '@underlay/protocol'
import { and, eq } from 'drizzle-orm'

import * as schema from '../db/schema.js'
import { registerJob } from '../jobs.js'
import type { Ports } from '../ports.js'

export const offsetConfig = {
  /** Records between points, about: a page walks at most this many past its point. */
  step: 4096,
  /** Records one job walks before handing on to the next. */
  walkChunk: 3_000_000,
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

interface Partial {
  hash: string
  /** Records walked so far, and the last id walked. */
  walked: number
  last: string | null
  points: [number, string][]
}

const indexKey = (collectionId: string, seq: number, type: string) =>
  `v3-offsets/${collectionId}/${seq}/${encodeURIComponent(type)}.json`
const partialKey = (collectionId: string, seq: number, type: string) =>
  `v3-offsets/${collectionId}/${seq}/${encodeURIComponent(type)}.partial.json`

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

/** Live record ids of one type in a version, after `after`, without the denylist. */
async function* liveIds(store: Store, view: v3.View, type: string, after: string | null) {
  for await (const group of v3.mergeGroups(
    store,
    view,
    { type, ...(after !== null ? { after: { type, id: after } } : {}) },
    { readAhead: WALK_READ_AHEAD },
  )) {
    const w = group[group.length - 1]!
    if (w.entry.kind === 'r') yield w.entry.id
  }
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
  // Walk the type, resuming from what an earlier job left.
  const pk = partialKey(collectionId, seq, type)
  let part = await readJson<Partial>(ports, pk)
  if (!part || part.hash !== hash) part = { hash, walked: 0, last: null, points: [] }
  let n = 0
  for await (const id of liveIds(ports.stores.v3, view, type, part.last)) {
    if (part.walked % offsetConfig.step === 0) part.points.push([part.walked, id])
    part.walked++
    part.last = id
    if (++n === offsetConfig.walkChunk) {
      await internal.put(pk, JSON.stringify(part))
      return false
    }
  }
  const index: OffsetIndex = { version: seq, hash, type, count: part.walked, points: part.points }
  await internal.put(key, JSON.stringify(index))
  await internal.delete(pk)
  return true
}

/** Index every type of a version with more than a few pages, and drop older indexes. */
export async function indexVersion(
  ports: Ports,
  collectionId: string,
  seq: number,
  only?: string,
): Promise<'done' | 'more'> {
  const [row] = await ports.db
    .select({ hash: schema.versions.hash, typeCounts: schema.versions.typeCounts })
    .from(schema.versions)
    .where(and(eq(schema.versions.collectionId, collectionId), eq(schema.versions.seq, seq)))
    .limit(1)
  if (!row) return 'done'
  const types = Object.entries(row.typeCounts)
    .filter(([t, n]) => !t.startsWith('$') && n > offsetConfig.step && (!only || t === only))
    .map(([t]) => t)
  if (types.length === 0) return 'done'
  const view = await v3.openView(ports.stores.v3, collectionId, { version: seq })
  for (const t of types) {
    if (!(await indexType(ports, collectionId, seq, row.hash, t, view))) return 'more'
  }
  // The version before stays for a reader that opened it a moment ago; older ones go.
  if (!only && seq > 2) {
    for (const t of types) await ports.stores.internal.delete(indexKey(collectionId, seq - 2, t))
  }
  return 'done'
}

registerJob('v3.offsets', async (job, ports) => {
  const collectionId = String(job.collectionId)
  const seq = Number(job.seq)
  const only = job.only === undefined ? undefined : String(job.only)
  if ((await indexVersion(ports, collectionId, seq, only)) === 'more') {
    await ports.jobs.enqueue({
      type: 'v3.offsets',
      collectionId,
      seq,
      ...(only !== undefined ? { only } : {}),
    })
  }
})
