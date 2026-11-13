/**
 * Building a push session's files for a v3 commit (v3/commit.ts), in one job or in parts.
 *
 * Every row is looked up in the head, a chunk at a time; a row that changes nothing is left
 * out, and the rest are counted and written as sorted-record-files. A session of up to
 * `sessionBuildConfig.partBytes` of run lines is built in the commit job itself. A larger one
 * is cut into key ranges of about that size (compact.ts `pieceCuts`, at the runs' part
 * boundaries), and each range is a `v3.sessionPart` job in the v3 pool: it merges only its
 * range of the runs, checks and writes its rows, notes the files its records reference, and
 * writes its result once. The last part to finish queues the commit again, which assembles
 * the parts in key order (commit.ts).
 *
 * One job for the whole session stalled a 5.5M-record push into an empty v3 collection
 * (prod, 2026-11-13): it read every run twice, built every file, and copied them, in one
 * queue invocation, and was ended without a log after compaction.
 *
 * The plan and the parts' results are under the commit attempt (the session's
 * `finalize_started_at`), so a commit tried again, or reopened for missing files, plans
 * afresh; the sweep's nudge of a stalled one resumes the same plan, and queues only the
 * parts with no result. A part's files end at its range's end, so a session built in parts
 * has a few more, smaller files than one built whole; a server may cut files anywhere.
 */
import { recordCanonical, sha256Hex, v3 } from '@underlay/protocol'
import { and, eq } from 'drizzle-orm'

import * as schema from '../db/schema.js'
import { registerJob } from '../jobs.js'
import type { Ports } from '../ports.js'
import { pieceCuts } from '../push/compact.js'
import {
  type KeyRange,
  mergeRuns,
  readRunIndex,
  type RunEntry,
  type RunIndex,
  runBytes,
  sliceRun,
} from '../push/runs.js'
import { getSession, type SessionRow } from '../push/session.js'
import { logCommit, traceConfig } from '../push/trace.js'
import { type CommitStats, emptyCommitStats, viewOf } from './catalog.js'
import { fanOut } from './fanout.js'

export const sessionBuildConfig = {
  /** Run lines (raw bytes) one job builds, about: a larger session is built in parts. */
  partBytes: 128 * 1024 * 1024,
}

export type BuiltFile = Awaited<ReturnType<typeof v3.buildFiles>>[number]

const enc = new TextEncoder()
export const lineHash = (row: v3.LineRow) => sha256Hex(row.line)
export const fmt = (n: number) => n.toLocaleString('en-US')

/** A run entry as a row: a record's canonical line is the v3 record line. */
export function runRow(e: RunEntry): v3.LineRow {
  if (e.x) return v3.removalRow(e.k, e.t)
  return { kind: 'r', type: e.t, id: e.k, line: e.b ?? recordCanonical(e.k, e.t, null) }
}

/** Add one row's effect to the commit's counts. */
export function count(
  s: CommitStats,
  row: v3.LineRow,
  before: { hash: string; size: number } | null,
  assetSizes: Map<string, number>,
) {
  if (row.type === v3.ASSET_TYPE) {
    const size = assetSizes.get(row.id) ?? 0
    if (row.kind === 'x') {
      s.assetsDelta--
      s.assetBytesDelta -= size
    } else if (!before) {
      s.assetsDelta++
      s.assetBytesDelta += size
    }
    return
  }
  if (row.type.startsWith('$')) return
  const size = enc.encode(row.line).byteLength
  if (row.kind === 'x') {
    s.typeDelta[row.type] = (s.typeDelta[row.type] ?? 0) - 1
    s.recordBytesDelta -= before!.size
    s.changes.removed++
  } else if (before) {
    s.recordBytesDelta += size - before.size
    s.changes.updated++
  } else {
    s.typeDelta[row.type] = (s.typeDelta[row.type] ?? 0) + 1
    s.recordBytesDelta += size
    s.changes.added++
  }
}

/** Add one set of counts into another. */
export function addStats(into: CommitStats, from: CommitStats) {
  for (const [t, n] of Object.entries(from.typeDelta))
    into.typeDelta[t] = (into.typeDelta[t] ?? 0) + n
  into.recordBytesDelta += from.recordBytesDelta
  into.assetsDelta += from.assetsDelta
  into.assetBytesDelta += from.assetBytesDelta
  into.changes.added += from.changes.added
  into.changes.removed += from.changes.removed
  into.changes.updated += from.changes.updated
}

export interface BuildProgress {
  /** Rows read so far, rows kept (changed), files finished. */
  read: number
  rows: number
  files: number
}

/**
 * Check rows (in key order) against the head and write the ones that change it as files in
 * the session's upload area, counting them into `stats`. `onChunk` runs after each chunk of
 * rows is checked, for progress.
 */
export async function buildChecked(
  ports: Ports,
  sessionId: string,
  view: v3.View | null,
  read: v3.ReadOptions,
  source: AsyncIterable<v3.LineRow> | Iterable<v3.LineRow>,
  stats: CommitStats,
  assetSizes: Map<string, number>,
  onChunk: (p: BuildProgress) => Promise<void> = async () => {},
): Promise<{ files: BuiltFile[]; rows: number }> {
  const store = ports.stores.v3
  const p: BuildProgress = { read: 0, rows: 0, files: 0 }
  // A chunk of rows at a time, each chunk's keys looked up in the head at once.
  const judged = async function* (): AsyncGenerator<v3.LineRow> {
    let chunk: v3.LineRow[] = []
    const flush = async () => {
      const befores = view ? await v3.statesAt(store, view, chunk, read) : []
      const out: v3.LineRow[] = []
      for (const [i, row] of chunk.entries()) {
        const before = befores[i] ?? null
        if (row.kind === 'x' ? before === null : before?.hash === lineHash(row)) continue
        count(stats, row, before, assetSizes)
        p.rows++
        out.push(row)
      }
      p.read += chunk.length
      chunk = []
      await onChunk(p)
      return out
    }
    for await (const row of source) {
      chunk.push(row)
      if (chunk.length >= 1024) yield* await flush()
    }
    if (chunk.length > 0) yield* await flush()
  }
  const target = v3.uploadTarget(store, sessionId)
  const counted: v3.FileTarget = {
    begin: async () => {
      const draft = await target.begin()
      return {
        ...draft,
        keep: async (id: string) => {
          await draft.keep(id)
          p.files++
        },
      }
    },
  }
  const files = await v3.buildFiles(judged(), counted)
  return { files, rows: p.rows }
}

// --- In parts ----------------------------------------------------------------------------

/** A session's build in parts: the runs it reads, and where each part's range ends. */
export interface PartPlan {
  /** The commit attempt it belongs to (`finalize_started_at`, ms). */
  attempt: number
  /** The head the parts check rows against, by commit number (0: an empty collection). */
  head: number
  /** The run seqs the parts read: a compaction finishing meanwhile leaves its inputs in storage. */
  seqs: number[]
  /** Part i covers run keys (cuts[i − 1], cuts[i]]; the last runs to the end. */
  cuts: string[]
}

/** What one part built. */
export interface PartResult {
  files: BuiltFile[]
  stats: CommitStats
  rows: number
  read: number
  /** Files its records reference (`r` on the run entries). */
  refs: string[]
  ms: number
}

const buildDir = (sessionId: string, attempt: number) => `sessions/${sessionId}/v3-build/${attempt}`
const planKey = (sessionId: string, attempt: number) => `${buildDir(sessionId, attempt)}/plan.json`
const partKey = (sessionId: string, attempt: number, part: number) =>
  `${buildDir(sessionId, attempt)}/part-${part}.json`

export const attemptOf = (s: SessionRow) => s.finalizeStartedAt?.getTime() ?? 0

export const partRange = (cuts: string[], part: number): KeyRange => ({
  after: part === 0 ? null : cuts[part - 1]!,
  through: part === cuts.length ? null : cuts[part]!,
})

/**
 * The session's plan in parts for this commit attempt: the one written already, or a new one
 * if its runs come to more than one part. Null: build it in one job.
 */
export async function partPlan(
  ports: Ports,
  session: SessionRow,
  runs: RunIndex[],
  head: number,
): Promise<PartPlan | null> {
  const internal = ports.stores.internal
  const attempt = attemptOf(session)
  const existing = await internal.get(planKey(session.id, attempt))
  if (existing) return JSON.parse(await existing.text()) as PartPlan
  const bytes = runs.reduce((n, r) => n + runBytes(r), 0)
  if (bytes <= sessionBuildConfig.partBytes) return null
  const cuts = pieceCuts(runs, sessionBuildConfig.partBytes)
  if (cuts.length === 0) return null
  const plan: PartPlan = { attempt, head, seqs: runs.map((r) => r.seq), cuts }
  await internal.put(planKey(session.id, attempt), JSON.stringify(plan), {
    contentType: 'application/json',
    ifAbsent: true,
  })
  // Two commit jobs may plan at once: the plan stored first is the one.
  const stored = await internal.get(planKey(session.id, attempt))
  return stored ? (JSON.parse(await stored.text()) as PartPlan) : plan
}

/** The parts with a result, by number. */
async function partsDone(ports: Ports, sessionId: string, attempt: number): Promise<Set<number>> {
  const done = new Set<number>()
  const prefix = `${buildDir(sessionId, attempt)}/part-`
  let cursor: string | undefined
  do {
    const page = await ports.stores.internal.list(prefix, cursor)
    for (const key of page.keys) done.add(Number(key.slice(prefix.length, -'.json'.length)))
    cursor = page.cursor
  } while (cursor)
  return done
}

const partCount = (plan: PartPlan) => plan.cuts.length + 1

/**
 * Queue the parts with no result yet, or, when every part has one, read them in key order.
 * 'waiting': the last part to finish queues the commit again.
 */
export async function buildParts(
  ports: Ports,
  session: SessionRow,
  plan: PartPlan,
  progress: (detail: string, fields: Record<string, unknown>) => Promise<void>,
): Promise<PartResult[] | 'waiting'> {
  const n = partCount(plan)
  let done = await partsDone(ports, session.id, plan.attempt)
  if (done.size < n) {
    await setPhase(ports, session.id, 'building')
    await progress(`${done.size} of ${n} parts built`, { parts_done: done.size, parts: n })
    const todo = Array.from({ length: n }, (_, i) => i).filter((i) => !done.has(i))
    await fanOut(
      ports,
      todo.map((part) => ({
        type: 'v3.sessionPart',
        sessionId: session.id,
        attempt: plan.attempt,
        part,
      })),
    )
    // With a pool the parts ran while we waited; without one they are queued. The last
    // part to finish may have claimed the assembly already, and queued it.
    done = await partsDone(ports, session.id, plan.attempt)
    if (done.size < n || !(await claimAssembly(ports, session.id))) return 'waiting'
  }
  const out: PartResult[] = []
  for (let i = 0; i < n; i++) {
    const obj = await ports.stores.internal.get(partKey(session.id, plan.attempt, i))
    if (!obj) return 'waiting'
    out.push(JSON.parse(await obj.text()) as PartResult)
  }
  return out
}

/** Build one part of a session's files. Idempotent: a part with a result is not built again. */
export async function buildPart(
  ports: Ports,
  sessionId: string,
  attempt: number,
  part: number,
): Promise<void> {
  const internal = ports.stores.internal
  const session = await getSession(ports, sessionId)
  // A commit since settled, reopened, or tried again: this attempt's parts are not wanted.
  if (!session || session.status !== 'committing' || attemptOf(session) !== attempt) return
  const planObj = await internal.get(planKey(sessionId, attempt))
  if (!planObj) return
  const plan = JSON.parse(await planObj.text()) as PartPlan
  const key = partKey(sessionId, attempt, part)
  if (!(await internal.head(key))) {
    const started = Date.now()
    const store = ports.stores.v3
    const view = await viewOf(store, session.collectionId, plan.head)
    if (plan.head > 0 && !view) throw new Error(`Version ${plan.head} of the collection is gone`)
    const read: v3.ReadOptions = { cache: new v3.FileCache(16 * 1024 * 1024), readers: new Map() }
    const range = partRange(plan.cuts, part)
    const indexes = await Promise.all(plan.seqs.map((s) => readRunIndex(internal, sessionId, s)))
    const slices = indexes.map((ix) => sliceRun(ix, range)).filter((ix) => ix.parts.length > 0)
    const refs = new Set<string>()
    const rows = (async function* () {
      for await (const e of mergeRuns(internal, sessionId, slices, range)) {
        for (const h of e.r ?? []) refs.add(h)
        yield runRow(e)
      }
    })()
    const stats = emptyCommitStats()
    let last = started
    let readRows = 0
    const built = await buildChecked(
      ports,
      sessionId,
      view,
      read,
      rows,
      stats,
      new Map(),
      async (p) => {
        readRows = p.read
        if (Date.now() - last < traceConfig.progressMs) return
        last = Date.now()
        logCommit({ session: sessionId, step: 'v3.part', at: 'progress', part, rows_read: p.read })
      },
    )
    const result: PartResult = {
      files: built.files,
      stats,
      rows: built.rows,
      read: readRows,
      refs: [...refs].sort(),
      ms: Date.now() - started,
    }
    await internal.put(key, JSON.stringify(result), {
      contentType: 'application/json',
      ifAbsent: true,
    })
    logCommit({
      session: sessionId,
      step: 'v3.part',
      at: 'end',
      part,
      ms: result.ms,
      read: result.read,
      rows: result.rows,
      files: result.files.length,
    })
  }
  // The last part to finish queues the commit, which assembles them.
  const done = await partsDone(ports, sessionId, attempt)
  const n = partCount(plan)
  await ports.db
    .update(schema.pushSessions)
    .set({
      commitStep: `v3.parts: ${done.size} of ${n} parts built`,
      progressAt: new Date(),
      // A part built stays built: the build is moving.
      stalls: 0,
    })
    .where(and(eq(schema.pushSessions.id, sessionId), eq(schema.pushSessions.status, 'committing')))
  if (done.size === n && (await claimAssembly(ports, sessionId)))
    await ports.jobs.enqueue({ type: 'push.commit', sessionId })
}

/** Where a session building in parts is: 'building', then 'assembling'. */
export async function setPhase(ports: Ports, sessionId: string, phase: string | null) {
  const s = schema.pushSessions
  await ports.db
    .update(s)
    .set({ commitPhase: phase })
    .where(and(eq(s.id, sessionId), eq(s.status, 'committing')))
}

/**
 * Every part is built: claim the assembly (building → assembling), so that of the last
 * parts to finish and the commit job waiting on the pool, one assembles. A commit job the
 * sweep queues again assembles whatever the phase (the one that claimed it may be gone).
 */
async function claimAssembly(ports: Ports, sessionId: string): Promise<boolean> {
  const s = schema.pushSessions
  const won = await ports.db
    .update(s)
    .set({ commitPhase: 'assembling', progressAt: new Date() })
    .where(and(eq(s.id, sessionId), eq(s.status, 'committing'), eq(s.commitPhase, 'building')))
    .returning({ id: s.id })
  return won.length > 0
}

registerJob('v3.sessionPart', async (job, ports) => {
  await buildPart(ports, String(job.sessionId), Number(job.attempt), Number(job.part))
})
