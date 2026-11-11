/**
 * v3's background work (v3-deploy-plan.md, Phase 1), on the bulk queue:
 *
 *   v3.rebuild   after each commit: the rebuild policy (docs/protocol-v3.md, Section 9),
 *                round after round while it finds merges, then old layout files pruned
 *   v3.sweep     on the cron: one pass of the deletion sweep over the v3 area, and upload
 *                sessions and temporary files older than a day cleared
 *
 * Both work only inside the v3 area (`Stores.v3`), never on v2's objects.
 */
import { v3 } from '@underlay/protocol'

import { registerJob } from '../jobs.js'
import type { Ports, Store } from '../ports.js'

export const v3JobConfig = {
  /** Size tiers a factor of this apart (decision 5 is open: 10 now, maybe 4 past a size). */
  ratio: 10,
  /** With nothing to merge, still write a layout once this many commits have landed. */
  adoptAfter: 8,
  /** Rounds of merging in one job: a merge can make the next one due. */
  rounds: 4,
  /** Layout files kept behind the newest (a reader with a stale hint finds one). */
  keepLayouts: 2,
  /** Upload sessions and temporary files older than this are cleared. */
  staleMs: 24 * 60 * 60 * 1000,
  /** Deletion sweep periods (the library's defaults). */
  graceMs: 24 * 60 * 60 * 1000,
  trashMs: 7 * 24 * 60 * 60 * 1000,
}

registerJob('v3.rebuild', async (job, ports) => {
  await rebuildCollection(ports, String(job.collectionId))
})

registerJob('v3.sweep', async (_job, ports) => {
  const store = ports.stores.v3
  const result = await v3.sweep(store, {
    graceMs: v3JobConfig.graceMs,
    trashMs: v3JobConfig.trashMs,
  })
  const cleared =
    (await clearStale(store, 'uploads/', v3JobConfig.staleMs)) +
    (await clearStale(store, 'tmp/', v3JobConfig.staleMs))
  console.log(
    `[v3.sweep] pass ${result.pass}: ${result.collections} collections; records trashed ${result.records.trashed}, purged ${result.records.purged}; assets trashed ${result.assets.trashed}, purged ${result.assets.purged}; ${cleared} stale upload objects cleared`,
  )
  const missing = [...result.records.missing, ...result.assets.missing]
  if (missing.length > 0)
    console.error(`[v3.sweep] listed but missing: ${missing.slice(0, 20).join(', ')}`)
})

/** Rebuild one collection by the policy, then prune its old layout files. */
export async function rebuildCollection(ports: Ports, collectionId: string) {
  const store = ports.stores.v3
  for (let round = 0; round < v3JobConfig.rounds; round++) {
    const r = await v3.rebuild(store, collectionId, {
      tiers: { ratio: v3JobConfig.ratio },
      adoptAfter: v3JobConfig.adoptAfter,
    })
    if (!r.layout || r.lost) break
  }
  await pruneLayouts(store, collectionId, v3JobConfig.keepLayouts)
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
