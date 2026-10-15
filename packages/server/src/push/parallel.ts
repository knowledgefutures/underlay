/**
 * Parallel commit (edge-redesign-build.md, "Parallel commit"). A delta session
 * of any size commits as one version: each (set, type) merge splits into
 * key-range units that run as separate jobs, then one assembly job builds the
 * interior levels and publishes. The trees come out byte-identical to the
 * serial merge.
 *
 *   plan       (in the push.commit job, once compaction has left at most
 *              `compactConfig.commitRuns` runs) split candidates per (set,
 *              type): the runs' natural-boundary marks plus natural last keys of
 *              the base tree's nodes at a level chosen by the tree's size.
 *              Intervals no run touches become gaps, left to assembly; the rest
 *              are grouped into units of about `unitBytes` of work: the changes'
 *              raw bytes plus the base leaves they will rewrite. The plan (base,
 *              trees, every unit's range) is one object; nothing here reads more
 *              than the runs' summaries and the base's upper levels.
 *   commit.plan       one chunk of the plan's units: writes each unit's slice
 *                     (the run parts overlapping its range) and its row, under
 *                     an id derived from the plan, so a retry rewrites the same
 *                     rows. D1 runs at most 1,000 queries an invocation, so rows
 *                     are written in chunks; the last chunk ends phase 'planning'.
 *   commit.unit       mergeTree in range mode: the range's leaves, change
 *                     counts and file reference deltas, to an output object.
 *   commit.assemble   one at a time (a lease on the session), never while the
 *                     plan is still being written. If a unit's `through` was
 *                     deleted, merge it with the following ranges up to the
 *                     first that survived, queue the new unit, and stop.
 *                     Otherwise assembleTree per (set, type), then
 *                     commitVersion with the prebuilt trees.
 *
 * Only commits where every type is plain go parallel: no type changes privacy
 * or schema, and none is removed. Those need O(type size) work that stays in
 * the serial commit for now, so the serial commit refuses one over
 * `serialMaxBytes` with an error that says to split the schema change off.
 */
import {
  assembleTree,
  bodyOfRecord,
  boundaryBytes,
  compareUtf8,
  dropRecordBody,
  FileRefDelta,
  LEAF_BOUNDARY_BITS,
  mergeTree,
  type NodeDesc,
  type RecordEntry,
  recordPayloadBytes,
  recordTree,
  type Repo,
  RepoSink,
  RepoSource,
  rootDesc,
  type Segment,
  type SetName,
  type SetObject,
  sha256Hex,
  trailingZeros,
  type TreeSummary,
} from '@underlay/protocol'
import { and, asc, count, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'

import { chunks } from '../db/chunks.js'
import * as schema from '../db/schema.js'
import { registerJob } from '../jobs.js'
import type { Ports } from '../ports.js'
import { type BaseVersion, commitVersion } from '../versions/commit.js'
import { deltaChanges, isPrivateSchema } from './changes.js'
import { touch } from './compact.js'
import { commitOutcome, settleSession } from './outcome.js'
import {
  normalizeIndex,
  partsInRange,
  readRunIndex,
  type RunIndex,
  runMarks,
  type RunPart,
  sliceRun,
} from './runs.js'
import {
  getSession,
  loadInputs,
  schemaHashes,
  type SessionInputs,
  type SessionRow,
} from './session.js'

export const parallelConfig = {
  /** Estimated work (raw bytes) above which a delta commit goes parallel. */
  aboveBytes: 256 * 1024 * 1024,
  /** Work per unit, about: changes' raw bytes plus the base leaves they rewrite. */
  unitBytes: 256 * 1024 * 1024,
  /** Base nodes per tree the planner may read split keys from: it picks the lowest level under this. */
  baseNodes: 50_000,
  /** A fixed base level (tests); null picks one by `baseNodes`. */
  baseLevel: null as number | null,
  /** Units per `commit.plan` chunk (D1: about 1,000 queries an invocation). */
  chunkUnits: 1_000,
  /** A commit the serial path can't take over this (a schema or privacy change) is refused. */
  serialMaxBytes: 2 * 1024 * 1024 * 1024,
}

/** How long an assembler holds the session before another may take over. */
const LEASE_MS = 15 * 60 * 1000
/** Body bytes a leaf holds before they go to a compressed member (each compresses with its raw text in memory). */
const SPILL_BYTES = 1024 * 1024
const builderOpts = {
  payloadBytes: recordPayloadBytes,
  dropPayload: dropRecordBody,
  spillBytes: SPILL_BYTES,
}

/** One unit's range, as planned. */
interface UnitSpec {
  set: SetName
  type: string
  ord: number
  after: string | null
  through: string | null
  gap: boolean
}

interface CommitPlan {
  id: string
  /**
   * The storage fence epoch read before the units wrote anything. Assembly
   * publishes under it, so a deletion window during the commit fails the push
   * (503, push again) rather than publishing a tree with a hole.
   */
  fence?: number
  base: BaseVersion | null
  /** Per type: its base trees, which the units merge into. */
  types: Record<string, { privateType: boolean; public: TreeSummary; private: TreeSummary }>
  /** The runs the units read (their summaries are sliced per unit). Plans before chunks: absent. */
  runs?: number[]
  units?: UnitSpec[]
  chunks?: number
}

interface UnitOutput {
  leaves: NodeDesc[]
  stats: { added: number; removed: number; updated: number }
  /** File reference count deltas: [fileHash, delta]. */
  refs: [string, number][]
}

type UnitRow = typeof schema.commitUnits.$inferSelect

const planDir = (sessionId: string, planId: string) => `sessions/${sessionId}/commit/${planId}`

async function putJson(ports: Ports, key: string, value: unknown) {
  await ports.stores.internal.put(key, JSON.stringify(value), { contentType: 'application/json' })
}

async function getJson<T>(ports: Ports, key: string): Promise<T> {
  const obj = await ports.stores.internal.get(key)
  if (!obj) throw new Error(`Parallel commit object ${key} is missing`)
  return JSON.parse(await obj.text()) as T
}

/** Run `fn` over items, at most `n` at a time. */
async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]!)
    }),
  )
}

const emptyTree: TreeSummary = { root: null, count: 0, bytes: 0 }
const summaryOf = (t: { root: string | null; count: number; bytes: number } | undefined) =>
  t ? { root: t.root, count: t.count, bytes: t.bytes } : emptyTree

const isNatural = (key: string) => trailingZeros(boundaryBytes(key)) >= LEAF_BOUNDARY_BITS

/** Mean entries per leaf, and per interior child (protocol constants' means). */
const LEAF_MEAN = 1024
const FANOUT_MEAN = 64

/** Raw bytes of the base leaf a change lands in, about: a leaf's mean entries at the tree's mean size. */
const leafBytesOf = (t: TreeSummary) => (t.count > 0 ? (t.bytes / t.count) * LEAF_MEAN : 0)

/** The base level whose nodes the planner reads: the lowest with at most `baseNodes` of them. */
function baseLevelFor(count: number): number {
  if (parallelConfig.baseLevel !== null) return parallelConfig.baseLevel
  let level = 1
  while (count / (LEAF_MEAN * FANOUT_MEAN ** (level - 1)) > parallelConfig.baseNodes) level++
  return level
}

/** The base tree's nodes at `level` (or its root, when that's lower), in order. */
async function baseNodes(repo: Repo, root: string | null, level: number): Promise<NodeDesc[]> {
  if (root === null) return []
  const source = new RepoSource(recordTree, repo)
  const top = await rootDesc(source, root)
  if (top.level <= level) return [top]
  const out: NodeDesc[] = []
  const visit = async (desc: NodeDesc): Promise<void> => {
    const node = await source.node(desc.hash)
    if (node.kind !== 'node') return
    for (const c of node.children) {
      if (c.level === level) out.push(c)
      else await visit(c)
    }
  }
  await visit(top)
  return out
}

interface Range {
  after: string | null
  through: string | null
  gap: boolean
}

/**
 * Group the intervals between candidates into units and gaps. An interval no
 * run part of the type overlaps holds no change, so it's a gap; its `through`
 * is then an unchanged base key (a run mark lies in a part, so its interval is
 * touched), which is what assembly needs.
 *
 * An interval's work is its changes' raw bytes (a part's spread evenly over the
 * intervals it spans), plus, when touched, the base bytes it may rewrite: at
 * most its base nodes' bytes (spread the same way), and at most a leaf for each
 * change.
 */
export function planRanges(
  slug: string,
  candidates: string[],
  parts: RunPart[],
  base: { nodes: NodeDesc[]; leafBytes: number },
  unitBytes: number,
): Range[] {
  const n = candidates.length + 1
  // Interval i is (candidates[i − 1], candidates[i]]; a key belongs to the first
  // interval whose upper candidate is ≥ it.
  const firstAtLeast = (id: string, strict: boolean) => {
    let a = 0
    let z = candidates.length
    while (a < z) {
      const m = (a + z) >> 1
      const c = compareUtf8(candidates[m]!, id)
      if (strict ? c > 0 : c >= 0) z = m
      else a = m + 1
    }
    return a
  }
  const intervalOf = (id: string | null) => (id === null ? n - 1 : firstAtLeast(id, false))
  const idOf = (runKey: string, edge: 'first' | 'last') => {
    const sep = runKey.indexOf('\u0000')
    if (runKey.slice(0, sep) === slug) return runKey.slice(sep + 1)
    // A part reaching into a neighbouring type spans this type's whole edge.
    return edge === 'first' ? '' : null
  }
  // Difference arrays: parts touching each interval, and per-interval rates of
  // change bytes, change entries and base bytes.
  const touch = new Int32Array(n + 1)
  const bytes = new Float64Array(n + 1)
  const entries = new Float64Array(n + 1)
  const baseBytes = new Float64Array(n + 1)
  const spread = (arr: Float64Array, i0: number, i1: number, v: number) => {
    arr[i0]! += v / (i1 - i0 + 1)
    arr[i1 + 1]! -= v / (i1 - i0 + 1)
  }
  for (const p of parts) {
    const i0 = intervalOf(idOf(p.first, 'first'))
    const i1 = intervalOf(idOf(p.last, 'last'))
    touch[i0]!++
    touch[i1 + 1]!--
    spread(bytes, i0, i1, p.bytes)
    spread(entries, i0, i1, p.count)
  }
  let low: string | null = null
  for (const node of base.nodes) {
    // The node holds base keys in (low, lastKey].
    const i0 = low === null ? 0 : Math.min(n - 1, firstAtLeast(low, true))
    const i1 = intervalOf(node.lastKey)
    if (i1 >= i0) spread(baseBytes, i0, i1, node.bytes)
    low = node.lastKey
  }
  const out: Range[] = []
  let unit: Range | null = null
  let acc = 0
  let touched = 0
  let b = 0
  let e = 0
  let bb = 0
  for (let i = 0; i < n; i++) {
    touched += touch[i]!
    b += bytes[i]!
    e += entries[i]!
    bb += baseBytes[i]!
    const after = i === 0 ? null : candidates[i - 1]!
    const through = i === n - 1 ? null : candidates[i]!
    if (touched === 0) {
      if (unit) out.push(unit)
      unit = null
      const last = out[out.length - 1]
      if (last?.gap) last.through = through
      else out.push({ after, through, gap: true })
      continue
    }
    const work = Math.max(0, b) + Math.max(0, Math.min(bb, e * base.leafBytes))
    if (unit && acc > 0 && acc + work > unitBytes) {
      out.push(unit)
      unit = null
    }
    if (!unit) {
      unit = { after, through, gap: false }
      acc = 0
    }
    unit.through = through
    acc += work
  }
  if (unit) out.push(unit)
  return out
}

/** Estimated work of a commit: per type, change bytes plus the base leaves the changes may rewrite. */
function estimatedWork(runs: RunIndex[], trees: Map<string, TreeSummary[]>): number {
  let total = 0
  for (const [slug, sets] of trees) {
    const parts = runs.flatMap((ix) => partsInRange(ix, { type: slug }))
    const changeBytes = parts.reduce((n, p) => n + p.bytes, 0)
    const changes = parts.reduce((n, p) => n + p.count, 0)
    total += changeBytes
    for (const t of sets) total += Math.min(t.bytes, changes * leafBytesOf(t))
  }
  return total
}

/**
 * Plan a parallel commit for a delta session, or return false when it should
 * commit serially (small, or not every type is plain). On true the plan's
 * chunks are queued and the assembly job settles the session. Throws
 * SerialTooLargeError for a commit only the serial path can take that's too
 * big for it.
 */
export async function planParallel(
  ports: Ports,
  session: SessionRow,
  ctx: {
    inputs: SessionInputs
    runs: RunIndex[]
    base: BaseVersion | null
    repo: Repo
    pub: SetObject
    priv: SetObject
    fence: number
  },
): Promise<boolean> {
  const { inputs, runs, pub, priv } = ctx
  const trees = new Map<string, TreeSummary[]>()
  for (const slug of Object.keys(inputs.schemas))
    trees.set(slug, [summaryOf(pub.types[slug]), summaryOf(priv.types[slug])])
  const work = estimatedWork(runs, trees)
  if (work <= parallelConfig.aboveBytes) return false
  const hashes = schemaHashes(inputs.schemas)
  const plain = () => {
    for (const [slug, s] of Object.entries(inputs.schemas)) {
      const pubBase = pub.types[slug]
      const privBase = priv.types[slug]
      const prior = pubBase ?? privBase
      if (prior && prior.schema !== hashes[slug]) return false
      if (isPrivateSchema(s) ? !!pubBase : !pubBase && !!privBase) return false
    }
    for (const slug of [...Object.keys(pub.types), ...Object.keys(priv.types)]) {
      if (!inputs.schemas[slug]) return false
    }
    return true
  }
  if (!plain()) {
    if (work > parallelConfig.serialMaxBytes) throw new SerialTooLargeError()
    return false
  }

  const planId = crypto.randomUUID()
  const dir = planDir(session.id, planId)
  const plan: CommitPlan = {
    id: planId,
    base: ctx.base,
    fence: ctx.fence,
    types: {},
    runs: runs.map((r) => r.seq),
    units: [],
  }
  for (const [slug, s] of Object.entries(inputs.schemas)) {
    const privateType = isPrivateSchema(s)
    plan.types[slug] = {
      privateType,
      public: summaryOf(pub.types[slug]),
      private: summaryOf(priv.types[slug]),
    }
    const parts = runs.flatMap((ix) => partsInRange(ix, { type: slug }))
    if (parts.length === 0) continue
    const anyPrivate = parts.some((p) => p.p)
    const marks = runMarks(runs, { type: slug }).map((m) => m.slice(m.indexOf('\u0000') + 1))
    for (const set of (privateType ? ['private'] : ['public', 'private']) as SetName[]) {
      const tree = plan.types[slug]![set]
      // Nothing can reach a private tree that doesn't exist without a private upsert.
      if (set === 'private' && !privateType && !tree.root && !anyPrivate) continue
      const nodes = await baseNodes(ctx.repo, tree.root, baseLevelFor(tree.count))
      const fromBase = nodes.map((d) => d.lastKey)
      const candidates = [...new Set([...marks, ...fromBase])].filter(isNatural).sort(compareUtf8)
      const ranges = planRanges(
        slug,
        candidates,
        parts,
        { nodes, leafBytes: leafBytesOf(tree) },
        parallelConfig.unitBytes,
      )
      for (const [ord, r] of ranges.entries()) plan.units!.push({ set, type: slug, ord, ...r })
    }
  }
  plan.chunks = Math.max(1, Math.ceil(plan.units!.length / parallelConfig.chunkUnits))
  await putJson(ports, `${dir}/plan.json`, plan)
  const won = await ports.db
    .update(schema.pushSessions)
    .set({ commitPlan: planId, commitPhase: 'planning', progressAt: new Date(), stalls: 0 })
    .where(
      and(
        eq(schema.pushSessions.id, session.id),
        eq(schema.pushSessions.status, 'committing'),
        isNull(schema.pushSessions.commitPlan),
      ),
    )
    .returning({ id: schema.pushSessions.id })
  // Another attempt planned first; its plan stands.
  if (won.length === 0) return true
  await queueChunks(ports, session.id, planId, plan.chunks)
  return true
}

/** A commit only the serial path can take (a schema or privacy change), too large for it. */
export class SerialTooLargeError extends Error {
  constructor() {
    super(
      'This push changes a type’s schema or privacy, or removes a type, and is too large to commit with that change. Commit the schema change on its own first (a push with the new schemas and no records), then push the records.',
    )
    this.name = 'SerialTooLargeError'
  }
}

const chunkDone = (sessionId: string, planId: string, chunk: number) =>
  `${planDir(sessionId, planId)}/chunk-${chunk}.done`

/** Queue the plan's chunks that aren't written yet. */
async function queueChunks(ports: Ports, sessionId: string, planId: string, chunks: number) {
  const todo: number[] = []
  for (let c = 0; c < chunks; c++) {
    if (!(await ports.stores.internal.head(chunkDone(sessionId, planId, c)))) todo.push(c)
  }
  await ports.jobs.enqueueBatch(
    todo.map((chunk) => ({ type: 'commit.plan', sessionId, planId, chunk })),
  )
}

/** A unit's id, from its place in the plan: a chunk written twice writes the same rows. */
const unitId = (planId: string, u: UnitSpec) =>
  sha256Hex(`${planId}\u0000${u.set}\u0000${u.type}\u0000${u.ord}`).slice(0, 32)

/** Write one chunk of a plan's units: slices and rows. The last chunk ends phase 'planning'. */
export async function writePlanChunk(
  ports: Ports,
  sessionId: string,
  planId: string,
  chunk: number,
): Promise<void> {
  const session = await getSession(ports, sessionId)
  if (session?.status !== 'committing' || session.commitPlan !== planId) return
  const dir = planDir(sessionId, planId)
  const plan = await getJson<CommitPlan>(ports, `${dir}/plan.json`)
  const store = ports.stores.internal
  if (!(await store.head(chunkDone(sessionId, planId, chunk)))) {
    const runs = await Promise.all(plan.runs!.map((seq) => readRunIndex(store, sessionId, seq)))
    const specs = plan.units!.slice(
      chunk * parallelConfig.chunkUnits,
      (chunk + 1) * parallelConfig.chunkUnits,
    )
    const rows: (typeof schema.commitUnits.$inferInsert)[] = specs.map((u) => {
      const id = unitId(planId, u)
      return {
        id,
        sessionId,
        planId,
        set: u.set,
        type: u.type,
        ord: u.ord,
        after: u.after,
        through: u.through,
        gap: u.gap,
        status: u.gap ? 'done' : 'pending',
        slicesKey: u.gap ? null : `${dir}/${id}.slices.json`,
      }
    })
    await pool(rows, 16, async (row) => {
      if (row.gap) return
      const range = { type: row.type, after: row.after ?? null, through: row.through ?? null }
      const slices = runs.map((ix) => sliceRun(ix, range)).filter((x) => x.parts.length > 0)
      await putJson(ports, row.slicesKey!, { runs: slices })
    })
    // D1 binds at most 100 parameters per statement: 12 a row, 8 rows.
    const inserts = []
    for (let i = 0; i < rows.length; i += 8)
      inserts.push(
        ports.db
          .insert(schema.commitUnits)
          .values(rows.slice(i, i + 8))
          .onConflictDoNothing(),
      )
    for (let i = 0; i < inserts.length; i += 50) {
      const part = inserts.slice(i, i + 50)
      await ports.db.batch(part as [(typeof part)[0], ...typeof part])
    }
    await store.put(chunkDone(sessionId, planId, chunk), '')
    await touch(ports, sessionId)
  }
  // Units start as soon as their rows exist; assembly waits for the whole plan.
  let done = 0
  for (let c = 0; c < plan.chunks!; c++) {
    if (await store.head(chunkDone(sessionId, planId, c))) done++
  }
  if (done === plan.chunks) {
    await ports.db
      .update(schema.pushSessions)
      .set({ commitPhase: null })
      .where(
        and(
          eq(schema.pushSessions.id, sessionId),
          eq(schema.pushSessions.commitPlan, planId),
          eq(schema.pushSessions.commitPhase, 'planning'),
        ),
      )
    await queueWork(ports, sessionId, planId)
  } else await topUpUnits(ports, session.userId)
}

/**
 * Commit units on the queue at once, per session and per account
 * (v2-scale-review.md S3): a billion-record push plans about a thousand units,
 * and they wait their turn instead of filling the bulk queue. A unit queued
 * longer than `staleMs` ago and still pending counts as lost and goes again;
 * one queued `maxAttempts` times fails its commit (recover.ts).
 */
export const unitLimits = {
  perSession: 32,
  perAccount: 64,
  staleMs: 30 * 60 * 1000,
  maxAttempts: 4,
}

/** Queue a plan's pending units (within the windows), or the assembly when none is left. Idempotent. */
async function queueWork(
  ports: Ports,
  sessionId: string,
  planId: string,
  opts: { assembleOnly?: boolean } = {},
): Promise<void> {
  const [pending] = await ports.db
    .select({ id: schema.commitUnits.id })
    .from(schema.commitUnits)
    .where(and(eq(schema.commitUnits.planId, planId), eq(schema.commitUnits.status, 'pending')))
    .limit(1)
  if (!pending) {
    await ports.jobs.enqueue({ type: 'commit.assemble', sessionId })
    return
  }
  if (opts.assembleOnly) return
  const session = await getSession(ports, sessionId)
  if (session) await topUpUnits(ports, session.userId)
}

/**
 * Put a user's waiting units on the queue, oldest session first, as far as the
 * windows allow. Runs after planning and after every unit, so the windows refill
 * as work finishes. A unit is claimed by setting `queuedAt`, so two top-ups
 * never queue it twice; each claim counts an attempt.
 */
export async function topUpUnits(ports: Ports, userId: string): Promise<void> {
  const { db } = ports
  const u = schema.commitUnits
  const sessions = await db
    .select({ id: schema.pushSessions.id, planId: schema.pushSessions.commitPlan })
    .from(schema.pushSessions)
    .where(
      and(
        eq(schema.pushSessions.userId, userId),
        eq(schema.pushSessions.status, 'committing'),
        isNotNull(schema.pushSessions.commitPlan),
      ),
    )
    .orderBy(asc(schema.pushSessions.createdAt))
  const staleBefore = new Date(Date.now() - unitLimits.staleMs)
  const inFlight = new Map<string, number>()
  for (const s of sessions) {
    const [row] = await db
      .select({ n: count() })
      .from(u)
      .where(
        and(
          eq(u.sessionId, s.id),
          eq(u.planId, s.planId!),
          eq(u.status, 'pending'),
          gte(u.queuedAt, staleBefore),
        ),
      )
    inFlight.set(s.id, row?.n ?? 0)
  }
  let account = [...inFlight.values()].reduce((a, b) => a + b, 0)
  for (const s of sessions) {
    const room = Math.min(
      unitLimits.perSession - inFlight.get(s.id)!,
      unitLimits.perAccount - account,
    )
    if (room <= 0) continue
    const waiting = and(
      or(isNull(u.queuedAt), lt(u.queuedAt, staleBefore)),
      // A unit out of attempts stays put; the sweep fails its commit.
      lt(u.attempts, unitLimits.maxAttempts),
    )
    const next = await db
      .select({ id: u.id })
      .from(u)
      .where(and(eq(u.sessionId, s.id), eq(u.planId, s.planId!), eq(u.status, 'pending'), waiting))
      .orderBy(asc(u.ord))
      .limit(room)
    if (next.length === 0) continue
    const claimed: string[] = []
    for (const part of chunks(next.map((x) => x.id))) {
      const rows = await db
        .update(u)
        .set({ queuedAt: new Date(), attempts: sql`${u.attempts} + 1` })
        .where(and(inArray(u.id, part), eq(u.status, 'pending'), waiting))
        .returning({ id: u.id })
      claimed.push(...rows.map((r) => r.id))
    }
    await ports.jobs.enqueueBatch(claimed.map((unitId) => ({ type: 'commit.unit', unitId })))
    account += claimed.length
  }
}

/** A push.commit job found a plan already in place (a retry, or the sweep): make sure its work is queued. */
export async function resumeParallel(ports: Ports, session: SessionRow): Promise<void> {
  if (!session.commitPlan) return
  if (session.commitPhase === 'planning') {
    const plan = await getJson<CommitPlan>(
      ports,
      `${planDir(session.id, session.commitPlan)}/plan.json`,
    )
    await queueChunks(ports, session.id, session.commitPlan, plan.chunks ?? 1)
    return
  }
  await queueWork(ports, session.id, session.commitPlan)
}

/** A unit's slices, in the current run index form (plans before pages listed blocks). */
async function unitRuns(ports: Ports, slicesKey: string): Promise<RunIndex[]> {
  const { runs } = await getJson<{ runs: Parameters<typeof normalizeIndex>[0][] }>(ports, slicesKey)
  return runs.map(normalizeIndex)
}

/** Run one unit. Idempotent: only a pending unit of the session's current plan runs. */
export async function runCommitUnit(ports: Ports, unitId: string): Promise<void> {
  const [unit] = await ports.db
    .select()
    .from(schema.commitUnits)
    .where(eq(schema.commitUnits.id, unitId))
  if (!unit || unit.status !== 'pending') return
  const session = await getSession(ports, unit.sessionId)
  if (session?.status !== 'committing' || session.commitPlan !== unit.planId) return
  const plan = await getJson<CommitPlan>(ports, `${planDir(session.id, unit.planId)}/plan.json`)
  const runs = await unitRuns(ports, unit.slicesKey!)
  const t = plan.types[unit.type]!
  const set = unit.set as SetName
  const repo = await ports.stores.forCollection(session.collectionId)
  const sink = new RepoSink<RecordEntry>(repo, { bodyOf: bodyOfRecord })
  const range = { after: unit.after, through: unit.through }
  const changes = deltaChanges(
    ports.stores.internal,
    repo,
    session.id,
    runs,
    unit.type,
    set,
    t.privateType,
    { pub: !!t.public.root, priv: !!t.private.root },
    range,
  )
  const leaves: NodeDesc[] = []
  const refs = new FileRefDelta()
  const merged = await mergeTree(new RepoSource(recordTree, repo), sink, t[set].root, changes, {
    ...builderOpts,
    range,
    leafOutput: (d) => leaves.push(d),
    onChange: (before, after) => refs.record(set, before, after, unit.type),
  })
  await sink.flush()
  await refs.resolve(repo)
  const survived = unit.through === null || merged.lastKey === unit.through
  const { added, removed, updated } = merged.stats
  const output: UnitOutput = {
    leaves,
    stats: { added, removed, updated },
    refs: [...refs.refs[set]].filter(([, n]) => n !== 0),
  }
  const outputKey = `${planDir(session.id, unit.planId)}/${unit.id}.out.json`
  await putJson(ports, outputKey, output)
  await ports.db
    .update(schema.commitUnits)
    .set({ status: survived ? 'done' : 'failed', outputKey })
    .where(and(eq(schema.commitUnits.id, unit.id), eq(schema.commitUnits.status, 'pending')))
  await touch(ports, session.id)
  // The last unit to finish queues the assembly (more than one may; it holds a lease).
  const [left] = await ports.db
    .select({ id: schema.commitUnits.id })
    .from(schema.commitUnits)
    .where(
      and(eq(schema.commitUnits.planId, unit.planId), eq(schema.commitUnits.status, 'pending')),
    )
    .limit(1)
  if (!left) await ports.jobs.enqueue({ type: 'commit.assemble', sessionId: session.id })
  // A slot is free: refill this user's windows, this session's or the next one's.
  await topUpUnits(ports, session.userId)
}

/** Units grouped per (set, type) tree, in key order, without superseded ones. */
function trees(rows: UnitRow[]): UnitRow[][] {
  const groups = new Map<string, UnitRow[]>()
  for (const r of rows) {
    if (r.status === 'superseded') continue
    const k = `${r.set}\u0000${r.type}`
    groups.set(k, [...(groups.get(k) ?? []), r])
  }
  return [...groups.values()].map((g) => g.sort((a, b) => a.ord - b.ord))
}

/**
 * Replace each failed unit, and the ranges after it up to the first whose
 * `through` survived (a done unit or a gap), by one new unit over their union.
 * Returns the new units' ids.
 */
async function mergeFailed(ports: Ports, sessionId: string, planId: string, rows: UnitRow[]) {
  const created: string[] = []
  for (const group of trees(rows)) {
    for (let i = 0; i < group.length; i++) {
      if (group[i]!.status !== 'failed') continue
      let j = i
      while (j < group.length - 1 && group[j]!.status === 'failed') j++
      const members = group.slice(i, j + 1)
      const merged = new Map<number, { seq: number; tier: number; parts: Map<number, RunPart> }>()
      for (const m of members) {
        if (!m.slicesKey) continue
        for (const r of await unitRuns(ports, m.slicesKey)) {
          const entry = merged.get(r.seq) ?? { seq: r.seq, tier: r.tier ?? 0, parts: new Map() }
          for (const p of r.parts) entry.parts.set(p.part, p)
          merged.set(r.seq, entry)
        }
      }
      const id = crypto.randomUUID()
      const slicesKey = `${planDir(sessionId, planId)}/${id}.slices.json`
      await putJson(ports, slicesKey, {
        runs: [...merged.values()].map((r) => ({
          seq: r.seq,
          tier: r.tier,
          parts: [...r.parts.values()].sort((a, b) => compareUtf8(a.first, b.first)),
        })),
      })
      const first = members[0]!
      await ports.db.batch([
        ports.db.insert(schema.commitUnits).values({
          id,
          sessionId,
          planId,
          set: first.set,
          type: first.type,
          ord: first.ord,
          after: first.after,
          through: members[members.length - 1]!.through,
          slicesKey,
        }),
        ports.db
          .update(schema.commitUnits)
          .set({ status: 'superseded' })
          .where(
            inArray(
              schema.commitUnits.id,
              members.map((m) => m.id),
            ),
          ),
      ])
      created.push(id)
      i = j
    }
  }
  return created
}

/** Assemble a parallel commit and settle its session. Runs under a lease on the session. */
export async function assembleParallel(ports: Ports, sessionId: string): Promise<void> {
  const session = await getSession(ports, sessionId)
  if (session?.status !== 'committing' || !session.commitPlan) return
  // The last plan chunk queues the assembly once every unit's row is written.
  if (session.commitPhase === 'planning') return
  const planId = session.commitPlan
  const now = Date.now()
  const lease = await ports.db
    .update(schema.pushSessions)
    .set({ assemblyLease: new Date(now) })
    .where(
      and(
        eq(schema.pushSessions.id, sessionId),
        eq(schema.pushSessions.commitPlan, planId),
        or(
          isNull(schema.pushSessions.assemblyLease),
          lt(schema.pushSessions.assemblyLease, new Date(now - LEASE_MS)),
        ),
      ),
    )
    .returning({ id: schema.pushSessions.id })
  if (lease.length === 0) return
  const release = () =>
    ports.db
      .update(schema.pushSessions)
      .set({ assemblyLease: null })
      .where(eq(schema.pushSessions.id, sessionId))
  try {
    const rows = await ports.db
      .select()
      .from(schema.commitUnits)
      .where(eq(schema.commitUnits.planId, planId))
      .orderBy(asc(schema.commitUnits.ord))
    if (rows.some((r) => r.status === 'pending')) {
      await release()
      // A unit that finished while this job held the lease queued an assembly
      // that found the lease taken; queue another if nothing is pending now.
      await queueWork(ports, sessionId, planId, { assembleOnly: true })
      return
    }
    if (rows.some((r) => r.status === 'failed')) {
      await mergeFailed(ports, sessionId, planId, rows)
      await release()
      // The merged units wait unqueued, like a new plan's.
      await topUpUnits(ports, session.userId)
      return
    }

    const plan = await getJson<CommitPlan>(ports, `${planDir(sessionId, planId)}/plan.json`)
    const repo = await ports.stores.forCollection(session.collectionId)
    const source = new RepoSource(recordTree, repo)
    const sink = new RepoSink<RecordEntry>(repo, { bodyOf: bodyOfRecord })
    const built: Record<string, { public: TreeSummary; private: TreeSummary }> = {}
    for (const [slug, t] of Object.entries(plan.types))
      built[slug] = { public: t.public, private: t.private }
    const refs = new FileRefDelta()
    const stats = { added: 0, removed: 0, updated: 0 }
    for (const group of trees(rows)) {
      const { set, type } = group[0]! as { set: SetName; type: string }
      // Each segment's output is read once, when assembly reaches it.
      const segments: Segment[] = group
        .filter((u) => !u.gap)
        .map((u) => ({
          after: u.after,
          through: u.through,
          leaves: async () => {
            const out = await getJson<UnitOutput>(ports, u.outputKey!)
            stats.added += out.stats.added
            stats.removed += out.stats.removed
            stats.updated += out.stats.updated
            // A unit covers one type, so its deltas are that type's too.
            for (const [h, n] of out.refs) refs.add(set, type, h, n)
            return out.leaves
          },
        }))
      const result = await assembleTree(source, sink, plan.types[type]![set].root, segments)
      built[type]![set] = summaryOf(
        result.root
          ? { root: result.root.hash, count: result.root.count, bytes: result.root.bytes }
          : undefined,
      )
      await touch(ports, sessionId)
    }
    await sink.flush()

    const inputs = await loadInputs(ports, sessionId)
    const hashes = schemaHashes(inputs.schemas)
    const outcome = await commitOutcome(ports, sessionId, () =>
      commitVersion(ports, {
        collectionId: session.collectionId,
        // Plans written before the fence existed fail if any window has opened since.
        fence: plan.fence ?? 0,
        base: plan.base,
        types: Object.entries(inputs.schemas).map(([slug, s]) => ({
          slug,
          schema: s,
          schemaHash: hashes[slug]!,
          public: null,
          private: null,
        })),
        metadata: inputs.metadata,
        declaredFiles: inputs.files,
        message: session.message,
        pushedBy: session.userId,
        appId: session.appId,
        actorId: session.actorId,
        pushSessionId: session.id,
        prebuilt: { trees: built, refs, stats },
      }),
    )
    await settleSession(ports, sessionId, outcome)
  } catch (err) {
    await release()
    throw err
  }
}

registerJob('commit.plan', async (job, ports) =>
  writePlanChunk(ports, String(job.sessionId), String(job.planId), Number(job.chunk)),
)
registerJob('commit.unit', async (job, ports) => runCommitUnit(ports, String(job.unitId)))
registerJob('commit.assemble', async (job, ports) => assembleParallel(ports, String(job.sessionId)))
