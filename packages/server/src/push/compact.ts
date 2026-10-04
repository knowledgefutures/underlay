/**
 * Run compaction during upload. Whenever MERGE_FAN_IN runs of one tier
 * accumulate in a session, a `push.compact` job merges them into one run of the
 * next tier, up to MAX_TIER. A session therefore holds O(log) runs per tier plus
 * capped top-tier runs, and a commit unit can read its key range from all of
 * them at once.
 *
 * A compaction claims its inputs by setting `merging_into` to the seq of the run
 * it will write, in one statement, so two jobs never merge the same run. When
 * the merged run is written, one batch records it and drops the input rows. A
 * commit reads the run list in one query, so it sees either the inputs or the
 * merged run, never both; input objects stay until the session's objects expire,
 * so a commit already reading them is unaffected.
 *
 * Precedence is per entry (runs.ts), so any group of runs can be merged.
 */
import { and, asc, count, eq, inArray, isNull } from 'drizzle-orm'

import * as schema from '../db/schema.js'
import { registerJob } from '../jobs.js'
import type { Ports } from '../ports.js'
import { compactRuns, MAX_TIER, MERGE_FAN_IN, readRunIndex } from './runs.js'
import { getSession, nextRunSeq } from './session.js'

type RunKind = 'records' | 'deletes'

/** Runs merged together: a session's records and deletes are one stream. */
const GROUPS: Record<RunKind, RunKind[]> = {
  records: ['records', 'deletes'],
  deletes: ['records', 'deletes'],
}

/** After a run of `kind` and `tier` is recorded: claim a full group and queue its compaction. */
export async function maybeCompact(
  ports: Ports,
  sessionId: string,
  kind: RunKind,
  tier: number,
): Promise<void> {
  if (tier >= MAX_TIER) return
  const runs = schema.pushRuns
  const free = and(
    eq(runs.sessionId, sessionId),
    eq(runs.tier, tier),
    inArray(runs.kind, GROUPS[kind]),
    isNull(runs.mergingInto),
  )
  const [row] = await ports.db.select({ n: count() }).from(runs).where(free)
  if ((row?.n ?? 0) < MERGE_FAN_IN) return
  const out = await nextRunSeq(ports, sessionId)
  if (out === null) return
  const oldest = ports.db
    .select({ seq: runs.seq })
    .from(runs)
    .where(free)
    .orderBy(asc(runs.seq))
    .limit(MERGE_FAN_IN)
  const claimed = await ports.db
    .update(runs)
    .set({ mergingInto: out })
    .where(and(eq(runs.sessionId, sessionId), inArray(runs.seq, oldest)))
    .returning({ seq: runs.seq })
  if (claimed.length < MERGE_FAN_IN) {
    // Another upload claimed some of them first; leave the rest for later.
    await ports.db
      .update(runs)
      .set({ mergingInto: null })
      .where(and(eq(runs.sessionId, sessionId), eq(runs.mergingInto, out)))
    return
  }
  await ports.jobs.enqueue({ type: 'push.compact', sessionId, seq: out })
}

/** Write the compacted run `seq` from the runs claimed for it. Idempotent. */
export async function compactClaimed(ports: Ports, sessionId: string, seq: number): Promise<void> {
  const runs = schema.pushRuns
  const claimed = and(eq(runs.sessionId, sessionId), eq(runs.mergingInto, seq))
  const inputs = await ports.db.select().from(runs).where(claimed).orderBy(asc(runs.seq))
  if (inputs.length === 0) return
  // A session that stopped taking uploads commits from the inputs as they are.
  const session = await getSession(ports, sessionId)
  if (session?.status !== 'open') return
  const store = ports.stores.internal
  const indexes = await Promise.all(inputs.map((r) => readRunIndex(store, sessionId, r.seq)))
  const tier = inputs[0]!.tier + 1
  const index = await compactRuns(store, sessionId, indexes, seq, tier)
  const kind = inputs.every((r) => r.kind === inputs[0]!.kind) ? inputs[0]!.kind : 'records'
  await ports.db.batch([
    ports.db
      .insert(runs)
      .values({
        sessionId,
        seq,
        kind,
        objectKey: `sessions/${sessionId}/runs/${seq}`,
        count: index.blocks.reduce((n, b) => n + b.count, 0),
        firstKey: index.blocks[0]?.first ?? '',
        lastKey: index.blocks[index.blocks.length - 1]?.last ?? '',
        tier,
      })
      .onConflictDoNothing(),
    ports.db.delete(runs).where(claimed),
  ])
  await maybeCompact(ports, sessionId, kind, tier)
}

registerJob('push.compact', async (job, ports) => {
  await compactClaimed(ports, String(job.sessionId), Number(job.seq))
})
