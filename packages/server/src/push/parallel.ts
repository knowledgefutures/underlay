/**
 * Parallel commit (edge-redesign-build.md, "Parallel commit"). One commit job
 * handles a few million changed records in a Worker's CPU budget. A delta
 * session bigger than that splits each (set, type) merge into key-range units
 * that run as separate jobs, then one assembly job builds the interior levels
 * and publishes. The trees come out byte-identical to the serial merge.
 *
 *   plan       (in the push.commit job) split candidates per (set, type): the
 *              runs' natural-boundary marks plus natural last keys of the base
 *              tree's upper level. Intervals no run block touches become gaps,
 *              left to assembly; the rest are grouped into units of about
 *              `unitEntries` run entries. Each unit gets a slice object listing
 *              the run blocks overlapping its range, so it reads nothing else.
 *   commit.unit       mergeTree in range mode: the range's leaves, change
 *                     counts and file reference deltas, to an output object.
 *   commit.assemble   one at a time (a lease on the session). If a unit's
 *                     `through` was deleted, merge it with the following ranges
 *                     up to the first that survived, queue the new unit, and
 *                     stop. Otherwise assembleTree per (set, type), then
 *                     commitVersion with the prebuilt trees.
 *
 * Only commits where every type is plain go parallel: no type changes privacy
 * or schema, and none is removed. Those need O(type size) work that stays in
 * the serial commit for now.
 */
import {
  assembleTree,
  bodyOfRecord,
  boundaryBytes,
  compareUtf8,
  dropRecordBody,
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
  type SetObject,
  trailingZeros,
  type TreeSummary,
} from '@underlay/protocol'
import { and, asc, eq, inArray, isNull, lt, or } from 'drizzle-orm'

import * as schema from '../db/schema.js'
import { registerJob } from '../jobs.js'
import type { Ports } from '../ports.js'
import { type BaseVersion, commitVersion } from '../versions/commit.js'
import { FileRefDelta, type SetName } from '../versions/file-refs.js'
import { deltaChanges, isPrivateSchema } from './changes.js'
import { commitOutcome, settleSession } from './outcome.js'
import { blocksInRange, type RunBlock, type RunIndex, runMarks } from './runs.js'
import {
  getSession,
  loadInputs,
  schemaHashes,
  type SessionInputs,
  type SessionRow,
} from './session.js'

export const parallelConfig = {
  /** Run entries above which a delta commit goes parallel. */
  above: 2_000_000,
  /** Run entries per unit, about. */
  unitEntries: 1_000_000,
  /** Level whose nodes' natural last keys are split candidates (2: about one per 4M records). */
  baseLevel: 2,
}

/** How long an assembler holds the session before another may take over. */
const LEASE_MS = 15 * 60 * 1000
const SPILL_BYTES = 4 * 1024 * 1024
const builderOpts = {
  payloadBytes: recordPayloadBytes,
  dropPayload: dropRecordBody,
  spillBytes: SPILL_BYTES,
}

interface CommitPlan {
  id: string
  base: BaseVersion | null
  /** Per type: its base trees, which the units merge into. */
  types: Record<string, { privateType: boolean; public: TreeSummary; private: TreeSummary }>
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

const emptyTree: TreeSummary = { root: null, count: 0, bytes: 0 }
const summaryOf = (t: { root: string | null; count: number; bytes: number } | undefined) =>
  t ? { root: t.root, count: t.count, bytes: t.bytes } : emptyTree

const isNatural = (key: string) => trailingZeros(boundaryBytes(key)) >= LEAF_BOUNDARY_BITS

/** Natural last keys of the base tree's nodes at `level`, in order. */
async function baseCandidates(repo: Repo, root: string | null, level: number): Promise<string[]> {
  if (root === null) return []
  const source = new RepoSource(recordTree, repo)
  const top = await rootDesc(source, root)
  if (top.level <= level) return []
  const out: string[] = []
  const visit = async (desc: NodeDesc): Promise<void> => {
    const node = await source.node(desc.hash)
    if (node.kind !== 'node') return
    for (const c of node.children) {
      if (c.level === level) {
        if (isNatural(c.lastKey)) out.push(c.lastKey)
      } else await visit(c)
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
 * block of the type overlaps holds no change, so it's a gap; its `through` is
 * then an unchanged base key (a run mark lies in a block, so its interval is
 * touched), which is what assembly needs.
 */
function planRanges(
  slug: string,
  candidates: string[],
  blocks: RunBlock[],
  unitEntries: number,
): Range[] {
  const n = candidates.length + 1
  // Interval i is (candidates[i − 1], candidates[i]]; a key belongs to the first
  // interval whose upper candidate is ≥ it.
  const intervalOf = (id: string | null) => {
    if (id === null) return n - 1
    let a = 0
    let z = candidates.length
    while (a < z) {
      const m = (a + z) >> 1
      if (compareUtf8(candidates[m]!, id) >= 0) z = m
      else a = m + 1
    }
    return a
  }
  const idOf = (runKey: string, edge: 'first' | 'last') => {
    const sep = runKey.indexOf('\u0000')
    if (runKey.slice(0, sep) === slug) return runKey.slice(sep + 1)
    // A block reaching into a neighbouring type spans this type's whole edge.
    return edge === 'first' ? '' : null
  }
  // Difference arrays: how many blocks touch each interval, and its estimated
  // entries (a block's count spread evenly over the intervals it spans).
  const diff = new Int32Array(n + 1)
  const rate = new Float64Array(n + 1)
  for (const b of blocks) {
    const i0 = intervalOf(idOf(b.first, 'first'))
    const i1 = intervalOf(idOf(b.last, 'last'))
    diff[i0]!++
    diff[i1 + 1]!--
    rate[i0]! += b.count / (i1 - i0 + 1)
    rate[i1 + 1]! -= b.count / (i1 - i0 + 1)
  }
  const out: Range[] = []
  let unit: Range | null = null
  let acc = 0
  let touched = 0
  let estimate = 0
  for (let i = 0; i < n; i++) {
    touched += diff[i]!
    estimate += rate[i]!
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
    if (unit && acc > 0 && acc + estimate > unitEntries) {
      out.push(unit)
      unit = null
    }
    if (!unit) {
      unit = { after, through, gap: false }
      acc = 0
    }
    unit.through = through
    acc += estimate
  }
  if (unit) out.push(unit)
  return out
}

/**
 * Plan a parallel commit for a delta session, or return false when it should
 * commit serially (small, or not every type is plain). On true the units are
 * queued and the assembly job settles the session.
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
  },
): Promise<boolean> {
  const { inputs, runs, pub, priv } = ctx
  const total = runs.reduce((n, r) => n + r.blocks.reduce((m, b) => m + b.count, 0), 0)
  if (total <= parallelConfig.above) return false
  const hashes = schemaHashes(inputs.schemas)
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

  const planId = crypto.randomUUID()
  const dir = planDir(session.id, planId)
  const plan: CommitPlan = { id: planId, base: ctx.base, types: {} }
  const rows: (typeof schema.commitUnits.$inferInsert)[] = []
  for (const [slug, s] of Object.entries(inputs.schemas)) {
    const privateType = isPrivateSchema(s)
    plan.types[slug] = {
      privateType,
      public: summaryOf(pub.types[slug]),
      private: summaryOf(priv.types[slug]),
    }
    const typeRuns = runs.map((ix) => ({ ix, blocks: blocksInRange(ix, { type: slug }) }))
    const blocks = typeRuns.flatMap((r) => r.blocks)
    if (blocks.length === 0) continue
    const anyPrivate = blocks.some((b) => b.p)
    const marks = runMarks(runs, { type: slug }).map((m) => m.slice(m.indexOf('\u0000') + 1))
    for (const set of (privateType ? ['private'] : ['public', 'private']) as SetName[]) {
      const baseRoot = plan.types[slug]![set].root
      // Nothing can reach a private tree that doesn't exist without a private upsert.
      if (set === 'private' && !privateType && !baseRoot && !anyPrivate) continue
      const fromBase = await baseCandidates(ctx.repo, baseRoot, parallelConfig.baseLevel)
      const candidates = [...new Set([...marks, ...fromBase])].filter(isNatural).sort(compareUtf8)
      const ranges = planRanges(slug, candidates, blocks, parallelConfig.unitEntries)
      for (const [ord, r] of ranges.entries()) {
        const id = crypto.randomUUID()
        let slicesKey: string | null = null
        if (!r.gap) {
          slicesKey = `${dir}/${id}.slices.json`
          const range = { type: slug, after: r.after, through: r.through }
          const slices = typeRuns
            .map(({ ix }) => ({ seq: ix.seq, tier: ix.tier, blocks: blocksInRange(ix, range) }))
            .filter((x) => x.blocks.length > 0)
          await putJson(ports, slicesKey, { runs: slices })
        }
        rows.push({
          id,
          sessionId: session.id,
          planId,
          set,
          type: slug,
          ord,
          after: r.after,
          through: r.through,
          gap: r.gap,
          status: r.gap ? 'done' : 'pending',
          slicesKey,
        })
      }
    }
  }
  await putJson(ports, `${dir}/plan.json`, plan)
  // D1 binds at most 100 parameters per statement: 12 columns, 8 rows.
  for (let i = 0; i < rows.length; i += 8) {
    await ports.db.insert(schema.commitUnits).values(rows.slice(i, i + 8))
  }
  const won = await ports.db
    .update(schema.pushSessions)
    .set({ commitPlan: planId })
    .where(
      and(
        eq(schema.pushSessions.id, session.id),
        eq(schema.pushSessions.status, 'committing'),
        isNull(schema.pushSessions.commitPlan),
      ),
    )
    .returning({ id: schema.pushSessions.id })
  if (won.length === 0) {
    // Another attempt planned first; its plan stands.
    await ports.db.delete(schema.commitUnits).where(eq(schema.commitUnits.planId, planId))
    return true
  }
  await queueWork(ports, session.id, planId)
  return true
}

/** Queue every pending unit of a plan, or the assembly when none is left. Idempotent. */
async function queueWork(
  ports: Ports,
  sessionId: string,
  planId: string,
  opts: { assembleOnly?: boolean } = {},
): Promise<void> {
  const pending = await ports.db
    .select({ id: schema.commitUnits.id })
    .from(schema.commitUnits)
    .where(and(eq(schema.commitUnits.planId, planId), eq(schema.commitUnits.status, 'pending')))
  if (pending.length === 0) {
    await ports.jobs.enqueue({ type: 'commit.assemble', sessionId })
    return
  }
  if (opts.assembleOnly) return
  await ports.jobs.enqueueBatch(pending.map((u) => ({ type: 'commit.unit', unitId: u.id })))
}

/** A push.commit job found a plan already in place (a retry): make sure its work is queued. */
export async function resumeParallel(ports: Ports, session: SessionRow): Promise<void> {
  if (session.commitPlan) await queueWork(ports, session.id, session.commitPlan)
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
  const { runs } = await getJson<{ runs: RunIndex[] }>(ports, unit.slicesKey!)
  const t = plan.types[unit.type]!
  const set = unit.set as SetName
  const repo = await ports.stores.forCollection(session.collectionId)
  const sink = new RepoSink<RecordEntry>(repo, { bodyOf: bodyOfRecord })
  const range = { after: unit.after, through: unit.through }
  const changes = deltaChanges(
    ports.stores.internal,
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
    onChange: (before, after) => refs.record(set, before, after),
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
  // The last unit to finish queues the assembly (more than one may; it holds a lease).
  const [left] = await ports.db
    .select({ id: schema.commitUnits.id })
    .from(schema.commitUnits)
    .where(
      and(eq(schema.commitUnits.planId, unit.planId), eq(schema.commitUnits.status, 'pending')),
    )
    .limit(1)
  if (!left) await ports.jobs.enqueue({ type: 'commit.assemble', sessionId: session.id })
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
      const blocks = new Map<
        number,
        { seq: number; tier?: number; blocks: Map<string, RunBlock> }
      >()
      for (const m of members) {
        if (!m.slicesKey) continue
        const { runs } = await getJson<{ runs: RunIndex[] }>(ports, m.slicesKey)
        for (const r of runs) {
          const entry = blocks.get(r.seq) ?? { seq: r.seq, tier: r.tier ?? 0, blocks: new Map() }
          for (const b of r.blocks) entry.blocks.set(`${b.part}:${b.offset}`, b)
          blocks.set(r.seq, entry)
        }
      }
      const id = crypto.randomUUID()
      const slicesKey = `${planDir(sessionId, planId)}/${id}.slices.json`
      await putJson(ports, slicesKey, {
        runs: [...blocks.values()].map((r) => ({
          seq: r.seq,
          tier: r.tier,
          blocks: [...r.blocks.values()].sort((a, b) => a.part - b.part || a.offset - b.offset),
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
      const created = await mergeFailed(ports, sessionId, planId, rows)
      await release()
      await ports.jobs.enqueueBatch(created.map((unitId) => ({ type: 'commit.unit', unitId })))
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
            const m = refs.refs[set]
            for (const [h, n] of out.refs) m.set(h, (m.get(h) ?? 0) + n)
            return out.leaves
          },
        }))
      const result = await assembleTree(source, sink, plan.types[type]![set].root, segments)
      built[type]![set] = summaryOf(
        result.root
          ? { root: result.root.hash, count: result.root.count, bytes: result.root.bytes }
          : undefined,
      )
    }
    await sink.flush()

    const inputs = await loadInputs(ports, sessionId)
    const hashes = schemaHashes(inputs.schemas)
    const declared = 'all' in inputs.files ? null : inputs.files
    const outcome = await commitOutcome(sessionId, () =>
      commitVersion(ports, {
        collectionId: session.collectionId,
        base: plan.base,
        types: Object.entries(inputs.schemas).map(([slug, s]) => ({
          slug,
          schema: s,
          schemaHash: hashes[slug]!,
          public: null,
          private: null,
        })),
        metadata: inputs.metadata,
        ...(declared ? { declaredFiles: declared } : {}),
        message: session.message,
        pushedBy: session.userId,
        appId: session.appId,
        actorId: session.actorId,
        prebuilt: { trees: built, refs, stats },
      }),
    )
    await settleSession(ports, sessionId, outcome)
  } catch (err) {
    await release()
    throw err
  }
}

registerJob('commit.unit', async (job, ports) => runCommitUnit(ports, String(job.unitId)))
registerJob('commit.assemble', async (job, ports) => assembleParallel(ports, String(job.sessionId)))
