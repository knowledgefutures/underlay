/**
 * Run compaction: the merge phase of the session's external sort. Two triggers:
 *
 *   - During upload, whenever MERGE_FAN_IN runs of one tier accumulate, they
 *     merge into one run of the next tier (a size-tiered LSM, no top tier). A
 *     session of any size therefore holds at most MERGE_FAN_IN − 1 runs per
 *     tier, O(log) tiers.
 *   - At commit (compactForCommit), the session's runs are merged down to at
 *     most `commitRuns`, smallest first, so every commit job reads a bounded
 *     number of runs. The session waits in phase 'compacting' and the last
 *     compaction to finish queues the commit again.
 *
 * A compaction is sized by bytes, not runs: one over `pieceBytes` is split into
 * key-range pieces (cut at the inputs' part boundaries), each a `push.compactPiece`
 * job writing its own parts of the output run; the piece that finds every piece
 * written joins their part lists into the run's index. Every step is idempotent:
 * a piece already written is skipped, the join writes the same index, and the
 * row swap is a conditional batch.
 *
 * A compaction claims its inputs by setting `merging_into` to the seq of the run
 * it will write (with `claimed_at`, so the sweep can queue a lost one again). When
 * the merged run is written, one batch records it and drops the input rows. A
 * commit reads the run list in one query, so it sees either the inputs or the
 * merged run, never both; input objects stay until the session's objects expire,
 * so a commit already reading them is unaffected.
 *
 * Precedence is per entry (runs.ts), so any group of runs can be merged.
 */
import { compareUtf8 } from '@underlay/protocol'
import { and, asc, count, eq, inArray, isNull, or, sql } from 'drizzle-orm'

import * as schema from '../db/schema.js'
import { registerJob } from '../jobs.js'
import type { Ports } from '../ports.js'
import {
  compactRuns,
  type KeyRange,
  MERGE_FAN_IN,
  readRunIndex,
  runBytes,
  runCount,
  type RunIndex,
  type RunPart,
  sliceRun,
  writeRunIndex,
} from './runs.js'
import { getSession, type SessionRow } from './session.js'

export const compactConfig = {
  /** Raw bytes one compaction job merges, about; a larger compaction is split into pieces. */
  pieceBytes: 1024 * 1024 * 1024,
  /** Runs one commit reads, at most: a session with more is compacted first. */
  commitRuns: 32,
}

/** Part numbers per piece: piece n numbers its parts from n × this. */
const PIECE_PARTS = 1_000_000

const runDir = (sessionId: string, seq: number) => `sessions/${sessionId}/runs/${seq}`
const planKey = (sessionId: string, seq: number) => `${runDir(sessionId, seq)}/compaction.json`
const pieceKey = (sessionId: string, seq: number, piece: number) =>
  `${runDir(sessionId, seq)}/piece-${piece}.json`

interface CompactionPlan {
  inputs: number[]
  tier: number
  /** Piece i covers run keys (cuts[i − 1], cuts[i]]; the last piece runs to the end. */
  cuts: string[]
}

/** Compactions run while the session takes uploads, or while its commit waits for them. */
const active = (s: SessionRow | null) =>
  s?.status === 'open' || (s?.status === 'committing' && s.commitPhase === 'compacting')

/** A run number for a compaction's output, while compaction may run. */
async function compactionSeq(ports: Ports, sessionId: string): Promise<number | null> {
  const s = schema.pushSessions
  const [row] = await ports.db
    .update(s)
    .set({ runs: sql`${s.runs} + 1` })
    .where(
      and(
        eq(s.id, sessionId),
        or(eq(s.status, 'open'), and(eq(s.status, 'committing'), eq(s.commitPhase, 'compacting'))),
      ),
    )
    .returning({ runs: s.runs })
  return row?.runs ?? null
}

/** Claim these runs for one compaction and queue it; false if any was already claimed. */
async function claim(ports: Ports, sessionId: string, seqs: number[]): Promise<boolean> {
  const runs = schema.pushRuns
  const out = await compactionSeq(ports, sessionId)
  if (out === null) return false
  const claimed = await ports.db
    .update(runs)
    .set({ mergingInto: out, claimedAt: new Date() })
    .where(and(eq(runs.sessionId, sessionId), inArray(runs.seq, seqs), isNull(runs.mergingInto)))
    .returning({ seq: runs.seq })
  if (claimed.length < seqs.length) {
    // Another compaction claimed some of them first; leave the rest for later.
    await ports.db
      .update(runs)
      .set({ mergingInto: null, claimedAt: null })
      .where(and(eq(runs.sessionId, sessionId), eq(runs.mergingInto, out)))
    return false
  }
  await ports.jobs.enqueue({ type: 'push.compact', sessionId, seq: out })
  return true
}

/** After a run of `tier` is recorded: claim a full tier and queue its compaction. */
export async function maybeCompact(ports: Ports, sessionId: string, tier: number): Promise<void> {
  const runs = schema.pushRuns
  const free = and(eq(runs.sessionId, sessionId), eq(runs.tier, tier), isNull(runs.mergingInto))
  const [row] = await ports.db.select({ n: count() }).from(runs).where(free)
  if ((row?.n ?? 0) < MERGE_FAN_IN) return
  const oldest = await ports.db
    .select({ seq: runs.seq })
    .from(runs)
    .where(free)
    .orderBy(asc(runs.seq))
    .limit(MERGE_FAN_IN)
  await claim(
    ports,
    sessionId,
    oldest.map((r) => r.seq),
  )
}

/**
 * Before a commit plans: are the session's runs few enough for one commit to
 * read? If not, the session goes to phase 'compacting', its smallest free runs
 * are claimed in groups until the count will fit, and 'waiting' is returned;
 * each finished compaction queues the commit again. On 'ready' the phase is
 * cleared, and runs still being compacted are read as they are.
 */
export async function compactForCommit(
  ports: Ports,
  session: SessionRow,
): Promise<'ready' | 'waiting'> {
  const rows = await ports.db
    .select()
    .from(schema.pushRuns)
    .where(eq(schema.pushRuns.sessionId, session.id))
  if (rows.length <= compactConfig.commitRuns) {
    if (session.commitPhase !== null) await setPhase(ports, session.id, null)
    return 'ready'
  }
  if (session.commitPhase !== 'compacting') await setPhase(ports, session.id, 'compacting')
  const inFlight = new Set(rows.filter((r) => r.mergingInto !== null).map((r) => r.mergingInto))
  const free = rows.filter((r) => r.mergingInto === null).sort((a, b) => a.bytes - b.bytes)
  // What the run list comes to once every claimed compaction is done.
  let n = free.length + inFlight.size
  while (n > compactConfig.commitRuns && free.length >= 2) {
    const k = Math.min(MERGE_FAN_IN, n - compactConfig.commitRuns + 1, free.length)
    const group = free.splice(0, k)
    if (
      await claim(
        ports,
        session.id,
        group.map((r) => r.seq),
      )
    )
      n -= k - 1
  }
  return 'waiting'
}

async function setPhase(ports: Ports, sessionId: string, phase: string | null) {
  await ports.db
    .update(schema.pushSessions)
    .set({ commitPhase: phase, progressAt: new Date(), stalls: 0 })
    .where(eq(schema.pushSessions.id, sessionId))
}

/**
 * Key-range cuts that split a compaction into pieces of about `pieceBytes`, at
 * the inputs' part boundaries. A part straddling a cut is read by both pieces.
 */
export function pieceCuts(indexes: RunIndex[], pieceBytes: number): string[] {
  const parts: RunPart[] = indexes.flatMap((ix) => ix.parts)
  parts.sort((a, b) => compareUtf8(a.last, b.last))
  const cuts: string[] = []
  let acc = 0
  for (let i = 0; i < parts.length - 1; i++) {
    acc += parts[i]!.bytes
    const key = parts[i]!.last
    if (acc >= pieceBytes && key !== cuts[cuts.length - 1] && key !== parts[i + 1]!.last) {
      cuts.push(key)
      acc = 0
    }
  }
  return cuts
}

const pieceRange = (cuts: string[], piece: number): KeyRange => ({
  after: piece === 0 ? null : cuts[piece - 1]!,
  through: piece === cuts.length ? null : cuts[piece]!,
})

async function claimedInputs(ports: Ports, sessionId: string, seq: number) {
  const runs = schema.pushRuns
  return ports.db
    .select()
    .from(runs)
    .where(and(eq(runs.sessionId, sessionId), eq(runs.mergingInto, seq)))
    .orderBy(asc(runs.seq))
}

/** Write the compacted run `seq` from the runs claimed for it, or queue its pieces. Idempotent. */
export async function compactClaimed(ports: Ports, sessionId: string, seq: number): Promise<void> {
  const inputs = await claimedInputs(ports, sessionId, seq)
  if (inputs.length === 0) return
  if (!active(await getSession(ports, sessionId))) return
  const store = ports.stores.internal
  const indexes = await Promise.all(inputs.map((r) => readRunIndex(store, sessionId, r.seq)))
  const tier = Math.max(...inputs.map((r) => r.tier)) + 1
  const total = indexes.reduce((n, ix) => n + runBytes(ix), 0)
  if (total <= compactConfig.pieceBytes) {
    const index = await compactRuns(store, sessionId, indexes, seq, tier)
    await finishCompaction(ports, sessionId, seq, index)
    return
  }
  let plan: CompactionPlan
  const existing = await store.get(planKey(sessionId, seq))
  if (existing) plan = JSON.parse(await existing.text()) as CompactionPlan
  else {
    plan = {
      inputs: inputs.map((r) => r.seq),
      tier,
      cuts: pieceCuts(indexes, compactConfig.pieceBytes),
    }
    await store.put(planKey(sessionId, seq), JSON.stringify(plan), {
      contentType: 'application/json',
    })
  }
  const done = await piecesDone(ports, sessionId, seq)
  const todo = Array.from({ length: plan.cuts.length + 1 }, (_, piece) => piece).filter(
    (piece) => !done.has(piece),
  )
  if (todo.length === 0) await joinPieces(ports, sessionId, seq, plan)
  else
    await ports.jobs.enqueueBatch(
      todo.map((piece) => ({ type: 'push.compactPiece', sessionId, seq, piece })),
    )
}

async function piecesDone(ports: Ports, sessionId: string, seq: number): Promise<Set<number>> {
  const done = new Set<number>()
  const prefix = `${runDir(sessionId, seq)}/piece-`
  let cursor: string | undefined
  do {
    const page = await ports.stores.internal.list(prefix, cursor)
    for (const key of page.keys) done.add(Number(key.slice(prefix.length, -'.json'.length)))
    cursor = page.cursor
  } while (cursor)
  return done
}

/** One key-range piece of a split compaction; the last piece to finish joins them. */
export async function compactPiece(
  ports: Ports,
  sessionId: string,
  seq: number,
  piece: number,
): Promise<void> {
  const store = ports.stores.internal
  const planObj = await store.get(planKey(sessionId, seq))
  if (!planObj) return
  const plan = JSON.parse(await planObj.text()) as CompactionPlan
  if ((await claimedInputs(ports, sessionId, seq)).length === 0) return // joined already
  if (!active(await getSession(ports, sessionId))) return
  if (!(await store.head(pieceKey(sessionId, seq, piece)))) {
    const range = pieceRange(plan.cuts, piece)
    const slices = await Promise.all(
      plan.inputs.map(async (s) => sliceRun(await readRunIndex(store, sessionId, s), range)),
    )
    const out = await compactRuns(
      store,
      sessionId,
      slices.filter((ix) => ix.parts.length > 0),
      seq,
      plan.tier,
      { range, partBase: piece * PIECE_PARTS },
    )
    await store.put(pieceKey(sessionId, seq, piece), JSON.stringify(out.parts), {
      contentType: 'application/json',
    })
    await touch(ports, sessionId)
  }
  const done = await piecesDone(ports, sessionId, seq)
  if (done.size === plan.cuts.length + 1) await joinPieces(ports, sessionId, seq, plan)
}

async function joinPieces(ports: Ports, sessionId: string, seq: number, plan: CompactionPlan) {
  const store = ports.stores.internal
  const parts: RunPart[] = []
  for (let piece = 0; piece <= plan.cuts.length; piece++) {
    const obj = await store.get(pieceKey(sessionId, seq, piece))
    if (!obj) throw new Error(`Compaction piece ${piece} of run ${seq} is missing`)
    parts.push(...(JSON.parse(await obj.text()) as RunPart[]))
  }
  const index: RunIndex = { seq, tier: plan.tier, parts }
  await writeRunIndex(store, sessionId, index)
  await finishCompaction(ports, sessionId, seq, index)
}

/** Record the merged run in place of its inputs, then carry on: the next tier, or the commit. */
async function finishCompaction(ports: Ports, sessionId: string, seq: number, index: RunIndex) {
  const runs = schema.pushRuns
  const inputs = await claimedInputs(ports, sessionId, seq)
  if (inputs.length === 0) return
  const tier = index.tier ?? 0
  const kind = inputs.every((r) => r.kind === 'deletes') ? 'deletes' : 'records'
  await ports.db.batch([
    ports.db
      .insert(runs)
      .values({
        sessionId,
        seq,
        kind,
        objectKey: runDir(sessionId, seq),
        count: runCount(index),
        bytes: runBytes(index),
        firstKey: index.parts[0]?.first ?? '',
        lastKey: index.parts[index.parts.length - 1]?.last ?? '',
        tier,
      })
      .onConflictDoNothing(),
    ports.db.delete(runs).where(and(eq(runs.sessionId, sessionId), eq(runs.mergingInto, seq))),
  ])
  const session = await getSession(ports, sessionId)
  if (session?.status === 'open') await maybeCompact(ports, sessionId, tier)
  else if (session?.status === 'committing' && session.commitPhase === 'compacting') {
    await touch(ports, sessionId)
    await ports.jobs.enqueue({ type: 'push.commit', sessionId })
  }
}

/** A commit's job finished a step: the sweep leaves a moving session alone. */
export async function touch(ports: Ports, sessionId: string) {
  await ports.db
    .update(schema.pushSessions)
    .set({ progressAt: new Date(), stalls: 0 })
    .where(and(eq(schema.pushSessions.id, sessionId), eq(schema.pushSessions.status, 'committing')))
}

registerJob('push.compact', async (job, ports) => {
  await compactClaimed(ports, String(job.sessionId), Number(job.seq))
})

registerJob('push.compactPiece', async (job, ports) => {
  await compactPiece(ports, String(job.sessionId), Number(job.seq), Number(job.piece))
})
