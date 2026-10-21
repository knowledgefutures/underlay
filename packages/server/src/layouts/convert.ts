/**
 * Converting a collection from today's record layout to layout F (planning:
 * layout-f-pr.md, "PR 2"), as bounded jobs:
 *
 *   layout.convert   from a cursor (a version, one of its record trees, a key in it),
 *                    write the records each version's new leaves hold into the
 *                    collection's F packs and index, until a budget runs out; queue
 *                    the next. Once the head is converted and no push is committing,
 *                    switch the collection to F.
 *
 * Nodes don't change, so neither do roots or version hashes: only where records live.
 * Until the switch the collection reads and commits in today's layout as before, and
 * versions committed meanwhile are converted in turn. A record is written once however
 * many versions hold it, and a job that runs again writes nothing twice
 * (`convertTree`).
 *
 * The switch is one statement: the layout moves to `f` only if the head is the last
 * version converted and no push of the collection is committing. A commit reads the
 * layout when it starts and keeps it (a parallel one in its plan), and publishes only
 * if the collection is still in it (`publishVersion`), so no version is published in
 * the layout it isn't in. Isolates note a collection's layout for a minute
 * (`stores.ts`), so for a while after the switch commits wait (LayoutSwitchingError):
 * no version only F can read appears while an isolate may still read in today's.
 *
 * Old leaf bodies stay where they are: nothing reads them once the collection is on
 * F, and the storage cleanup's mark still covers them (a follow-up). Mirrors of the
 * collection get F's files from the next version they copy.
 */
import { convertTree, type LayoutName, versionTrees } from '@underlay/protocol'
import { and, asc, eq, gt, sql } from 'drizzle-orm'

import * as schema from '../db/schema.js'
import { registerJob } from '../jobs.js'
import type { Ports } from '../ports.js'
import { LayoutSwitchingError } from './errors.js'

export const convertConfig = {
  /** Leaves one job reads at most. */
  leavesPerJob: 2000,
  /** How long one job converts before it queues the rest. */
  budgetMs: 4 * 60_000,
  /** Commits wait this long after the switch: stores note a layout for a minute. */
  switchPauseMs: 90_000,
  /** Seconds before a job that couldn't switch (a push committing) tries again. */
  retrySeconds: 30,
}

export interface ConvertState {
  collectionId: string
  status: 'converting' | 'switched'
  startedAt: string
  /** The job step this state is at: a job of any other step is a duplicate. */
  step: number
  /** The last version fully converted (0: none), and its id and hash. */
  seq: number
  versionId: string | null
  versionHash: string | null
  /** In the next version: the record tree being converted (versionTrees' order), and the key it's done through. */
  tree: number
  after: string | null
  stats: { versions: number; leaves: number; records: number; skipped: number; jobs: number }
  switchedAt?: string
}

const stateKey = (collectionId: string) => `convert/${collectionId}.json`

export async function conversionState(
  ports: Ports,
  collectionId: string,
): Promise<ConvertState | null> {
  const o = await ports.stores.internal.get(stateKey(collectionId))
  return o ? (JSON.parse(await o.text()) as ConvertState) : null
}

const save = (ports: Ports, s: ConvertState) =>
  ports.stores.internal.put(stateKey(s.collectionId), JSON.stringify(s), {
    contentType: 'application/json',
  })

/** Start converting a collection on today's layout (a no-op while one is under way). */
export async function startConversion(ports: Ports, collectionId: string): Promise<ConvertState> {
  const [c] = await ports.db
    .select({ layout: schema.collections.recordLayout })
    .from(schema.collections)
    .where(eq(schema.collections.id, collectionId))
  if (!c) throw new Error(`Collection ${collectionId} not found`)
  const known = await conversionState(ports, collectionId)
  if (known?.status === 'converting') return known
  if (c.layout !== 'today')
    throw new Error(`Collection ${collectionId} is already on layout ${c.layout}`)
  const state: ConvertState = {
    collectionId,
    status: 'converting',
    startedAt: new Date().toISOString(),
    step: 0,
    seq: 0,
    versionId: null,
    versionHash: null,
    tree: 0,
    after: null,
    stats: { versions: 0, leaves: 0, records: 0, skipped: 0, jobs: 0 },
  }
  await save(ports, state)
  await ports.jobs.enqueue({ type: 'layout.convert', collectionId, step: 0 })
  return state
}

/**
 * Throws LayoutSwitchingError when a commit to a collection on `layout` must wait:
 * it was switched to F under switchPauseMs ago.
 */
export async function checkSwitching(
  ports: Ports,
  collectionId: string,
  layout: LayoutName,
): Promise<void> {
  if (layout !== 'f') return
  const s = await conversionState(ports, collectionId)
  if (s?.switchedAt && Date.now() - Date.parse(s.switchedAt) < convertConfig.switchPauseMs)
    throw new LayoutSwitchingError()
}

/** Queue the merges of the collection's F index (it isn't on F yet: `layout: 'f'`). */
const queueMaintain = (ports: Ports, collectionId: string) =>
  ports.jobs.enqueueBatch(
    (['public', 'private'] as const).map((set) => ({
      type: 'layout.maintain',
      collectionId,
      set,
      layout: 'f',
    })),
  )

registerJob('layout.convert', async (job, ports) => {
  const collectionId = String(job.collectionId)
  const state = await conversionState(ports, collectionId)
  if (state?.status !== 'converting' || state.step !== Number(job.step)) return
  const from = await ports.stores.forCollectionAs(collectionId, 'today')
  const to = await ports.stores.forCollectionAs(collectionId, 'f')
  const until = Date.now() + convertConfig.budgetMs
  let leaves = 0
  const next = async (delaySeconds?: number) => {
    state.step++
    state.stats.jobs++
    await save(ports, state)
    await queueMaintain(ports, collectionId)
    await ports.jobs.enqueue(
      { type: 'layout.convert', collectionId, step: state.step },
      delaySeconds ? { delaySeconds } : undefined,
    )
  }

  const versions = await ports.db
    .select({ id: schema.versions.id, seq: schema.versions.seq, hash: schema.versions.hash })
    .from(schema.versions)
    .where(and(eq(schema.versions.collectionId, collectionId), gt(schema.versions.seq, state.seq)))
    .orderBy(asc(schema.versions.seq))
    .limit(100)
  for (const v of versions) {
    const trees = await versionTrees(from, v.hash, state.versionHash)
    for (; state.tree < trees.length; state.tree++) {
      const p = await convertTree(from, to, trees[state.tree]!, state.after, {
        leaves: Math.max(1, convertConfig.leavesPerJob - leaves),
        until,
      })
      leaves += p.leaves
      state.stats.leaves += p.leaves
      state.stats.records += p.records
      state.stats.skipped += p.skipped
      state.after = p.after
      // Stopped inside the tree: the next job carries on from its key.
      if (p.after !== null) return next()
    }
    state.seq = v.seq
    state.versionId = v.id
    state.versionHash = v.hash
    state.tree = 0
    state.after = null
    state.stats.versions++
    if (leaves >= convertConfig.leavesPerJob || Date.now() >= until) return next()
  }
  if (versions.length === 100) return next()

  // Every version is converted: switch, if the head is still the last of them and no
  // push is committing (one statement, so neither can change in between).
  const switched = await ports.db
    .update(schema.collections)
    .set({ recordLayout: 'f' })
    .where(
      and(
        eq(schema.collections.id, collectionId),
        eq(schema.collections.recordLayout, 'today'),
        sql`${schema.collections.headVersionId} IS ${state.versionId}`,
        sql`NOT EXISTS (SELECT 1 FROM ${schema.pushSessions} WHERE ${schema.pushSessions.collectionId} = ${collectionId} AND ${schema.pushSessions.status} = 'committing')`,
      ),
    )
    .returning({ id: schema.collections.id })
  if (!switched.length) return next(convertConfig.retrySeconds)
  ports.stores.forget(collectionId)
  state.status = 'switched'
  state.switchedAt = new Date().toISOString()
  state.step++
  await save(ports, state)
  await queueMaintain(ports, collectionId)
  console.log(`[convert] ${collectionId} switched to layout F: ${JSON.stringify(state.stats)}`)
})
