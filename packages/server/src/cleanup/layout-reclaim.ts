/**
 * Layout F's reclaim as bounded jobs (record-storage-layout.md, "Reclaim needs a
 * mark again"): drops records no retained version of a collection holds.
 *
 *   plan      snapshot the index and packs, cut the key space into ranges
 *   range     one job a range: mark the range's live records over every retained
 *             version, keep the index entries they need; the last range done
 *             swaps the new index in, drops dead packs, queues the rewrites
 *   rewrite   a few mostly-dead packs a job: copy their live records out (a leveled
 *             collection's level packs in place, their range marked again)
 *
 * Nothing starts it yet: records only go dead when versions are thinned (a
 * deleted collection's files go whole, cleanup/sweep.ts), and nothing may commit to
 * the collection while a reclaim runs, so it needs the write fence first
 * (cleanup/fence.ts). The scale bench ran it on F through `startLayoutReclaim`.
 */
import {
  KeyedLayout,
  markRange,
  type RecordSet,
  type Repo,
  recordRoots,
  TooManyRunsError,
  type TypedRoot,
} from '@underlay/protocol'
import { eq } from 'drizzle-orm'

import * as schema from '../db/schema.js'
import { registerJob } from '../jobs.js'
import type { JobMessage, Ports } from '../ports.js'

/** Mostly-dead packs a rewrite job copies. */
const REWRITE_PACKS = 4

/** How long a plan waits for merges to bring the index's runs down (TooManyRunsError). */
const PLAN_RETRY_SECONDS = 300

interface Target {
  collectionId: string
  set: RecordSet
}

const target = (job: JobMessage): Target => ({
  collectionId: String(job.collectionId),
  set: job.set === 'private' ? 'private' : 'public',
})

async function open(ports: Ports, t: Target): Promise<{ repo: Repo; layout: KeyedLayout }> {
  const repo = await ports.stores.forCollection(t.collectionId)
  const layout = repo.records?.[t.set]
  if (!(layout instanceof KeyedLayout))
    throw new Error('layout.reclaim: the collection is not on layout F')
  return { repo, layout }
}

/** Every retained version of the collection. */
async function retained(ports: Ports, t: Target): Promise<string[]> {
  const rows = await ports.db
    .select({ hash: schema.versions.hash })
    .from(schema.versions)
    .where(eq(schema.versions.collectionId, t.collectionId))
  return rows.map((r) => r.hash)
}

export async function startLayoutReclaim(ports: Ports, t: Target): Promise<void> {
  await ports.jobs.enqueue({ type: 'layout.reclaim', step: 'plan', ...t })
}

registerJob('layout.reclaim', async (job, ports) => {
  const t = target(job)
  const { repo, layout } = await open(ports, t)
  switch (job.step) {
    case 'plan': {
      let plan
      try {
        plan = await layout.reclaimPlan()
      } catch (err) {
        if (!(err instanceof TooManyRunsError)) throw err
        // Each range job reads every run at once: merge them down first, then plan.
        await ports.jobs.enqueue({ type: 'layout.maintain', ...t })
        await ports.jobs.enqueue(
          { type: 'layout.reclaim', step: 'plan', ...t },
          { delaySeconds: PLAN_RETRY_SECONDS },
        )
        return
      }
      await ports.jobs.enqueueBatch(
        plan.ranges.map((_, i) => ({
          type: 'layout.reclaim',
          step: 'range',
          ...t,
          plan: plan.id,
          range: i,
        })),
      )
      return
    }
    case 'range': {
      const plan = await layout.reclaimPlanById(String(job.plan))
      const r = plan.ranges[Number(job.range)]!
      const { live } = await markRange(repo, await recordRoots(repo, await retained(ports, t)), r)
      if (!(await layout.reclaimRange(plan, Number(job.range), live))) return
      const swapped = await layout.reclaimSwap(plan)
      if (!swapped) return
      const jobs: JobMessage[] = []
      for (let i = 0; i < swapped.rewrite.length; i += REWRITE_PACKS)
        jobs.push({
          type: 'layout.reclaim',
          step: 'rewrite',
          ...t,
          packs: swapped.rewrite.slice(i, i + REWRITE_PACKS).join(','),
        })
      await ports.jobs.enqueueBatch(jobs)
      return
    }
    case 'rewrite': {
      // A level's pack has no index entries to say what's live: marked again over its
      // key range (the retained versions read once a job).
      let roots: Promise<TypedRoot[]> | undefined
      await layout.reclaimRewrite(String(job.packs).split(','), async (r) => {
        roots ??= retained(ports, t).then((v) => recordRoots(repo, v))
        return (await markRange(repo, await roots, r)).live
      })
      return
    }
    default:
      throw new Error(`layout.reclaim: unknown step ${String(job.step)}`)
  }
})
