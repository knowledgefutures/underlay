/**
 * v3's background work (v3-deploy-plan.md, Phase 1), on the bulk queue:
 *
 *   v3.rebuild         after each commit: plan a round of the rebuild policy (Section 9).
 *                      A small round merges here and creates its layout; a large one is
 *                      cut into key ranges, a `v3.mergeUnit` job for each, so no job does
 *                      more than `unitBytes` of lines (v3-deploy-plan.md, Phase 2).
 *   v3.mergeUnit       one key range of a round's merge; the last to finish queues:
 *   v3.finishRebuild   create the round's layout from the units' outputs, prune old
 *                      layout files, and queue the next round (a merge can make another due)
 *   v3.sweep           on the cron: one pass of the deletion sweep over the v3 area, and
 *                      upload sessions and temporary files older than a day cleared
 *
 * A round in progress is a plan in the internal area, `v3-rebuilds/<collection>.json`,
 * created only if absent: one round at a time per collection. All of it works only inside
 * the v3 area (`Stores.v3`) and that internal prefix, never on v2's objects.
 */
import { createObject, v3 } from '@underlay/protocol'

import { registerJob } from '../jobs.js'
import type { Ports, Store } from '../ports.js'
import { fanOut } from './fanout.js'
import { dropDeletedV3 } from './fork.js'

export const v3JobConfig = {
  /** Size tiers a factor of this apart (decision 5 is open: 10 now, maybe 4 past a size). */
  ratio: 10,
  /** With nothing to merge, still write a layout once this many commits have landed. */
  adoptAfter: 8,
  /** Rounds of merging queued one after another: a merge can make the next one due. */
  rounds: 4,
  /** Bytes of lines one job merges at most: a larger merge is cut into key-range units. */
  unitBytes: 256 * 1024 * 1024,
  /** A round in progress older than this is taken to have failed, and planned again. */
  roundStaleMs: 60 * 60 * 1000,
  /** Layout files kept behind the newest (a reader with a stale hint finds one). */
  keepLayouts: 2,
  /** Upload sessions and temporary files older than this are cleared. */
  staleMs: 24 * 60 * 60 * 1000,
  /** Deletion sweep periods (the library's defaults). */
  graceMs: 24 * 60 * 60 * 1000,
  trashMs: 7 * 24 * 60 * 60 * 1000,
}

registerJob('v3.rebuild', async (job, ports) => {
  await rebuildCollection(ports, String(job.collectionId), Number(job.round ?? 0))
})

registerJob('v3.mergeUnit', async (job, ports) => {
  await mergeUnit(ports, String(job.collectionId), String(job.planId), Number(job.unit))
})

registerJob('v3.finishRebuild', async (job, ports) => {
  await finishRound(ports, String(job.collectionId), String(job.planId))
})

registerJob('v3.sweep', async (_job, ports) => {
  const store = ports.stores.v3
  // Deleted collections' own objects first, so this pass already frees their files.
  const dropped = await dropDeletedV3(ports)
  const result = await v3.sweep(store, {
    graceMs: v3JobConfig.graceMs,
    trashMs: v3JobConfig.trashMs,
  })
  const cleared =
    (await clearStale(store, 'uploads/', v3JobConfig.staleMs)) +
    (await clearStale(store, 'tmp/', v3JobConfig.staleMs))
  console.log(
    `[v3.sweep] pass ${result.pass}: ${result.collections} collections (${dropped} deleted ones dropped); records trashed ${result.records.trashed}, purged ${result.records.purged}; assets trashed ${result.assets.trashed}, purged ${result.assets.purged}; ${cleared} stale upload objects cleared`,
  )
  const missing = [...result.records.missing, ...result.assets.missing]
  if (missing.length > 0)
    console.error(`[v3.sweep] listed but missing: ${missing.slice(0, 20).join(', ')}`)
})

/** A round of rebuilding in progress: its plan, and the key-range units of each merge. */
interface Round {
  id: string
  createdAt: number
  round: number
  plan: v3.RebuildPlan
  units: { merge: number; range: v3.KeyRange }[]
}

const roundKey = (collectionId: string) => `v3-rebuilds/${collectionId}.json`
const unitKey = (collectionId: string, planId: string, unit: number) =>
  `v3-rebuilds/${collectionId}/${planId}/unit-${String(unit).padStart(5, '0')}.json`

async function readRound(ports: Ports, collectionId: string): Promise<Round | null> {
  const obj = await ports.stores.internal.get(roundKey(collectionId))
  return obj ? (JSON.parse(await obj.text()) as Round) : null
}

/**
 * Plan a round of the rebuild policy for a collection. A small round is merged and laid
 * out here; a large one is cut into units, each its own job.
 */
export async function rebuildCollection(ports: Ports, collectionId: string, round = 0) {
  const store = ports.stores.v3
  const internal = ports.stores.internal
  const current = await readRound(ports, collectionId)
  if (current) {
    // A round is in progress; its finish queues the next. A stale one failed: plan again.
    if (Date.now() - current.createdAt < v3JobConfig.roundStaleMs) return
    await internal.delete(roundKey(collectionId))
  }
  const opts = { tiers: { ratio: v3JobConfig.ratio }, adoptAfter: v3JobConfig.adoptAfter }
  const plan = await v3.planRebuild(store, collectionId, opts)
  if (!plan) {
    await pruneLayouts(store, collectionId, v3JobConfig.keepLayouts)
    return
  }
  const bytes = plan.merges.reduce((n, m) => n + m.inputs.reduce((k, f) => k + f.bytes, 0), 0)
  if (bytes <= v3JobConfig.unitBytes) {
    const outputs = []
    for (const m of plan.merges) {
      const r = await v3.mergeFiles(store, m.inputs, v3.mergeOptions(plan, m))
      outputs.push({ files: r.files, kept: r.kept.map((k) => k.id) })
    }
    const { won } = await v3.finishRebuild(store, plan, outputs)
    await pruneLayouts(store, collectionId, v3JobConfig.keepLayouts)
    if (won && round + 1 < v3JobConfig.rounds)
      await ports.jobs.enqueue({ type: 'v3.rebuild', collectionId, round: round + 1 })
    return
  }
  const units: Round['units'] = []
  for (const [i, m] of plan.merges.entries()) {
    for (const range of await v3.splitMerge(store, m.inputs, v3JobConfig.unitBytes))
      units.push({ merge: i, range })
  }
  const r: Round = { id: crypto.randomUUID(), createdAt: Date.now(), round, plan, units }
  // One round at a time: another job that planned at the same moment stops here.
  if (!(await createObject(internal, roundKey(collectionId), JSON.stringify(r)))) return
  console.log(
    `[v3.rebuild] ${collectionId}: layout ${plan.number}, ${plan.merges.length} merges, ${units.length} units, ${bytes} bytes of lines`,
  )
  await fanOut(
    ports,
    units.map((_, unit) => ({ type: 'v3.mergeUnit', collectionId, planId: r.id, unit })),
  )
}

/** Merge one key range of a round; the last unit to finish queues the round's finish. */
export async function mergeUnit(ports: Ports, collectionId: string, planId: string, unit: number) {
  const internal = ports.stores.internal
  const r = await readRound(ports, collectionId)
  if (!r || r.id !== planId) return
  const key = unitKey(collectionId, planId, unit)
  if (!(await internal.head(key))) {
    const u = r.units[unit]!
    const m = r.plan.merges[u.merge]!
    const out = await v3.mergeFiles(
      ports.stores.v3,
      m.inputs,
      v3.mergeOptions(r.plan, m, { range: u.range }),
    )
    await internal.put(key, JSON.stringify({ files: out.files }))
  }
  const done = await countUnits(ports, collectionId, planId)
  if (done === r.units.length)
    await ports.jobs.enqueue({ type: 'v3.finishRebuild', collectionId, planId })
}

async function countUnits(ports: Ports, collectionId: string, planId: string) {
  let n = 0
  let cursor: string | undefined
  do {
    const page = await ports.stores.internal.list(`v3-rebuilds/${collectionId}/${planId}/`, cursor)
    n += page.keys.length
    cursor = page.cursor
  } while (cursor)
  return n
}

/** Create a round's layout from its units' outputs, in unit order, and queue the next round. */
export async function finishRound(ports: Ports, collectionId: string, planId: string) {
  const internal = ports.stores.internal
  const r = await readRound(ports, collectionId)
  if (!r || r.id !== planId) return
  const outputs = r.plan.merges.map(() => ({ files: [] as v3.LayoutFile[], kept: [] as string[] }))
  for (const [i, u] of r.units.entries()) {
    const obj = await internal.get(unitKey(collectionId, planId, i))
    // A unit not written yet (a finish queued twice): its own finish comes later.
    if (!obj) return
    outputs[u.merge]!.files.push(
      ...(JSON.parse(await obj.text()) as { files: v3.LayoutFile[] }).files,
    )
  }
  const { won } = await v3.finishRebuild(ports.stores.v3, r.plan, outputs)
  console.log(
    `[v3.rebuild] ${collectionId}: layout ${r.plan.number} ${won ? 'created' : 'lost to another'}`,
  )
  await v3.inParallel(
    r.units.map((_, i) => () => internal.delete(unitKey(collectionId, planId, i))),
    8,
  )
  await internal.delete(roundKey(collectionId))
  await pruneLayouts(ports.stores.v3, collectionId, v3JobConfig.keepLayouts)
  if (won && r.round + 1 < v3JobConfig.rounds)
    await ports.jobs.enqueue({ type: 'v3.rebuild', collectionId, round: r.round + 1 })
}

/**
 * Delete all but the newest `keep` layout files of a collection. Each layout is complete
 * and only the newest is read (Section 5); the sweep lists files by the newest only.
 */
export async function pruneLayouts(store: Store, collectionId: string, keep: number) {
  const newest = (await v3.findLayout(store, collectionId))?.number ?? 0
  const prefix = `${v3.collectionPrefix(collectionId)}layouts/`
  const old: string[] = []
  let cursor: string | undefined
  do {
    const page = await store.list(prefix, cursor)
    for (const key of page.keys) {
      const n = Number(key.slice(prefix.length).replace(/\.json$/, ''))
      if (Number.isInteger(n) && n <= newest - keep) old.push(key)
    }
    cursor = page.cursor
  } while (cursor)
  await v3.inParallel(
    old.map((k) => () => store.delete(k)),
    8,
  )
  return old.length
}

/** Delete objects under a prefix last written more than `ageMs` ago. */
export async function clearStale(store: Store, prefix: string, ageMs: number): Promise<number> {
  const cutoff = Date.now() - ageMs
  const stale: string[] = []
  let cursor: string | undefined
  do {
    const page = await store.list(prefix, cursor)
    page.keys.forEach((k, i) => {
      const modified = page.info?.[i]?.modified
      if (modified !== undefined && modified < cutoff) stale.push(k)
    })
    cursor = page.cursor
  } while (cursor)
  await v3.inParallel(
    stale.map((k) => () => store.delete(k)),
    8,
  )
  return stale.length
}
