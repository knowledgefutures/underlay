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
  type Change,
  type DecodedNode,
  type LayoutName,
  compileSchema,
  boundaryBytes,
  compareUtf8,
  dropRecordBody,
  FileRefDelta,
  LEAF_BOUNDARY_BITS,
  mergeTree,
  type NodeDesc,
  type BodyRead,
  type HeldRun,
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
  schemaRelaxes,
  sha256Hex,
  tracksTypes,
  trailingZeros,
  type TreeSummary,
} from '@underlay/protocol'
import { and, asc, count, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'

import { chunks } from '../db/chunks.js'
import * as schema from '../db/schema.js'
import { registerJob } from '../jobs.js'
import { isolateTag, isolate } from '../lib/isolate.js'
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
  /**
   * Entries per unit, about: changes plus the base entries they rewrite. Bytes
   * alone let a range of tiny records (Crossref's OED chapters, 2026-10-16) hold
   * ten times the usual entries, and its unit ran out of time on every attempt.
   */
  unitEntries: 100_000,
  /** Base nodes per tree the planner may read split keys from: it picks the lowest level under this. */
  baseNodes: 50_000,
  /** A fixed base level (tests); null picks one by `baseNodes`. */
  baseLevel: null as number | null,
  /**
   * A level-1 base node over `unitBytes` whose mean leaf is over this many times
   * the tree's is read, and its leaves become split candidates (heavy ranges).
   */
  expandRatio: 1.5,
  /** Level-1 nodes read that way per tree, heaviest first. */
  expandReads: 2_000,
  /** Units per `commit.plan` chunk (D1: about 1,000 queries an invocation). */
  chunkUnits: 1_000,
  /** A commit the serial path can't take over this (a schema or privacy change) is refused. */
  serialMaxBytes: 2 * 1024 * 1024 * 1024,
}

/** How long an assembler holds the session before another may take over. */
const LEASE_MS = 15 * 60 * 1000

/**
 * An assembly starts no new tree after `budgetMs`: it queues itself again and
 * stops, well inside a queue job's 15 minutes of wall clock, and the next
 * attempt takes the trees already built as they are. One tree still has to fit
 * in one invocation, with what's left of the 15 minutes after the budget (Crossref's
 * journal-article, 1,274 units: 516 s on staging).
 */
export const assemblyLimits = { budgetMs: 3 * 60 * 1000 }
/** Body bytes a leaf holds before they go to a compressed member (each compresses with its raw text in memory). */
const SPILL_BYTES = 1024 * 1024
/** A unit's repository writes in flight: leaf bodies (compressed) and their raw bytes. */
const unitSink = { concurrency: 8, pendingBytes: 8 * 1024 * 1024 }
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
   * The record layout the commit writes in, read when it was planned: its units and
   * assembly write in it whatever their isolates last noted, and it publishes only
   * if the collection is still in it. Absent in plans made before conversions.
   */
  layout?: LayoutName
  /**
   * The storage fence epoch read before the units wrote anything. Assembly
   * publishes under it, so a deletion window during the commit fails the push
   * (503, push again) rather than publishing a tree with a hole.
   */
  fence?: number
  base: BaseVersion | null
  /**
   * Per type: its base trees (`public`, `private`: which sets the base has,
   * for the change streams), the trees its units merge into (`bases`: the
   * moved tree for a privacy change; plans before moves: the base trees), a
   * privacy move, and whether its new trees are revalidated in jobs.
   */
  types: Record<
    string,
    {
      privateType: boolean
      public: TreeSummary
      private: TreeSummary
      bases?: { public: TreeSummary; private: TreeSummary }
      move?: 'toPrivate' | 'toPublic'
      validate?: boolean
    }
  >
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
  /**
   * Layout F: the index runs and packs it wrote, held back from the manifest; the
   * assembly names a tree's together (one pending object a tree, not one a unit).
   */
  records?: HeldRun[]
}

type UnitRow = typeof schema.commitUnits.$inferSelect

const planDir = (sessionId: string, planId: string) => `sessions/${sessionId}/commit/${planId}`

async function putJson(ports: Ports, key: string, value: unknown) {
  await ports.stores.internal.put(key, JSON.stringify(value), { contentType: 'application/json' })
}

async function getJson<T>(ports: Ports, key: string): Promise<T> {
  const obj = await getJsonIfAny<T>(ports, key)
  if (obj === null) throw new Error(`Parallel commit object ${key} is missing`)
  return obj
}

async function getJsonIfAny<T>(ports: Ports, key: string): Promise<T | null> {
  const obj = await ports.stores.internal.get(key)
  return obj ? (JSON.parse(await obj.text()) as T) : null
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

/**
 * The base level whose nodes the planner reads: the lowest (above the leaves)
 * with at most `baseNodes` of them. Level L has about count / (LEAF_MEAN ×
 * FANOUT_MEAN^L) nodes; this counted level L − 1's until 2026-10-16, so a
 * Crossref type read 26 nodes of ~4,096 leaves instead of 1,678 of ~64.
 */
export function baseLevelFor(count: number): number {
  if (parallelConfig.baseLevel !== null) return parallelConfig.baseLevel
  let level = 1
  while (count / (LEAF_MEAN * FANOUT_MEAN ** level) > parallelConfig.baseNodes) level++
  return level
}

/** The collection's repository in the layout its commit was planned in. */
const planRepo = (ports: Ports, collectionId: string, plan: CommitPlan) =>
  plan.layout
    ? ports.stores.forCollectionAs(collectionId, plan.layout)
    : ports.stores.forCollection(collectionId)

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

/**
 * Replace heavy level-1 base nodes by their leaves. Units can't be cut finer
 * than split candidates (run marks, 1 in ~8 leaves; base node ends), so over
 * leaves of large records (Crossref, 2026-10-16: up to 216 MB of records each) a
 * unit was one interval of up to ~50 leaves and GBs of base. A node over
 * `unitBytes` whose mean leaf is over `expandRatio` times the tree's is read,
 * heaviest first, at most `expandReads` per tree; its leaves' last keys become
 * candidates and their bytes exact. Order is kept.
 */
export async function expandHeavyNodes(
  source: { node(hash: string): Promise<DecodedNode<RecordEntry>> },
  nodes: NodeDesc[],
  treeLeafBytes: number,
): Promise<NodeDesc[]> {
  const { unitBytes, expandRatio, expandReads } = parallelConfig
  const meanLeaf = (d: NodeDesc) => (d.bytes / d.count) * LEAF_MEAN
  const heavy = nodes
    .filter(
      (d) => d.level === 1 && d.bytes > unitBytes && meanLeaf(d) > expandRatio * treeLeafBytes,
    )
    .sort((a, b) => meanLeaf(b) - meanLeaf(a))
    .slice(0, expandReads)
  const children = new Map<string, NodeDesc[]>()
  await pool(heavy, 6, async (d) => {
    const node = await source.node(d.hash)
    if (node.kind === 'node') children.set(d.hash, node.children)
  })
  return nodes.flatMap((d) => children.get(d.hash) ?? [d])
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
 * change. A unit closes at `unitBytes` of work, or at `unitEntries` entries
 * counted the same way.
 */
export function planRanges(
  slug: string,
  candidates: string[],
  parts: RunPart[],
  base: { nodes: NodeDesc[]; leafBytes: number },
  unitBytes: number,
  unitEntries = Infinity,
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
  const baseCount = new Float64Array(n + 1)
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
    if (i1 >= i0) {
      spread(baseBytes, i0, i1, node.bytes)
      spread(baseCount, i0, i1, node.count)
    }
    low = node.lastKey
  }
  const leafEntries = 2 ** LEAF_BOUNDARY_BITS
  const out: Range[] = []
  let unit: Range | null = null
  let acc = 0
  let accEntries = 0
  let touched = 0
  let b = 0
  let e = 0
  let bb = 0
  let bc = 0
  for (let i = 0; i < n; i++) {
    touched += touch[i]!
    b += bytes[i]!
    e += entries[i]!
    bb += baseBytes[i]!
    bc += baseCount[i]!
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
    const count = Math.max(0, e) + Math.max(0, Math.min(bc, e * leafEntries))
    if (unit && acc > 0 && (acc + work > unitBytes || accEntries + count > unitEntries)) {
      out.push(unit)
      unit = null
    }
    if (!unit) {
      unit = { after, through, gap: false }
      acc = 0
      accEntries = 0
    }
    unit.through = through
    acc += work
    accEntries += count
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

/** How a type's trees get from the base to the new version (decided per type by the planner). */
interface TypeMode {
  /** The type's whole tree moves to the other set (a privacy change), as the serial build moves it. */
  move?: 'toPrivate' | 'toPublic'
  /** Its schema changed in a way that can reject records: the new trees are revalidated in jobs. */
  validate: boolean
  /** Only the serial build handles it; the bytes it would read or rewrite there. */
  serialOnly?: number
}

/**
 * Decide each type's mode. A privacy change goes parallel when the serial build
 * would move the type's tree as it is and the base counts file references per
 * type (so moving them is O(files)): public → private with nothing in the
 * private set yet, and private → public with no private upsert of the type in
 * this push. Anything else that changes privacy, and a type removed from a base
 * without per-type counts, stays serial at the cost of the type. In layout F a
 * moved type's records move to the other set's packs (build.ts copyRecords), so
 * every privacy change is serial there, at the cost of the type.
 */
async function typeModes(
  repo: Repo,
  inputs: SessionInputs,
  runs: RunIndex[],
  base: BaseVersion | null,
  pub: SetObject,
  priv: SetObject,
) {
  const tracked = {
    public: await tracksTypes(repo, base?.publicRefsRoot ?? null),
    private: await tracksTypes(repo, base?.privateRefsRoot ?? null),
  }
  const hashes = schemaHashes(inputs.schemas)
  const modes: Record<string, TypeMode> = {}
  for (const [slug, s] of Object.entries(inputs.schemas)) {
    const pubBase = pub.types[slug]
    const privBase = priv.types[slug]
    const prior = pubBase ?? privBase
    const bytes = (pubBase?.bytes ?? 0) + (privBase?.bytes ?? 0)
    const changed = !!prior && prior.schema !== hashes[slug]
    const mode: TypeMode = {
      validate: changed && !schemaRelaxes(await repo.schema(prior.schema), s),
    }
    const pubRoot = pubBase?.root ?? null
    const privRoot = privBase?.root ?? null
    if (isPrivateSchema(s) && pubRoot) {
      if (!privRoot && tracked.public && !repo.records) mode.move = 'toPrivate'
      else mode.serialOnly = bytes
    } else if (!isPrivateSchema(s) && !pubBase && privBase) {
      const privateUpserts = runs.some((ix) => partsInRange(ix, { type: slug }).some((p) => p.p))
      if (tracked.private && !privateUpserts && !repo.records) mode.move = 'toPublic'
      else mode.serialOnly = bytes
    }
    modes[slug] = mode
  }
  // Removed types release their file references: O(files) with per-type counts, else O(type).
  let removedSerial = 0
  for (const [set, types] of [
    ['public', pub.types],
    ['private', priv.types],
  ] as const) {
    for (const [slug, t] of Object.entries(types)) {
      if (!inputs.schemas[slug] && !tracked[set]) removedSerial += t.bytes
    }
  }
  return { modes, removedSerial }
}

/** The trees a type's units merge into: its base trees, or the moved tree. */
function mergeBases(mode: TypeMode, pubBase: TreeSummary, privBase: TreeSummary) {
  if (mode.move === 'toPrivate') return { public: emptyTree, private: pubBase }
  if (mode.move === 'toPublic') return { public: privBase, private: emptyTree }
  return { public: pubBase, private: privBase }
}

/**
 * Plan a parallel commit for a delta session, or return false when it should
 * commit serially (small, or a change only the serial build handles). On true
 * the plan's chunks are queued and the assembly job settles the session.
 * Throws SerialTooLargeError for a commit only the serial build can take that
 * is too big for it.
 *
 * Work counts the changes, the base leaves they rewrite, the records a changed
 * schema revalidates, and whatever only the serial build can do, so a small
 * push that revalidates a large type goes parallel too.
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
  const { modes, removedSerial } = await typeModes(ctx.repo, inputs, runs, ctx.base, pub, priv)
  let serialOnly = removedSerial
  let revalidate = 0
  for (const [slug, m] of Object.entries(modes)) {
    serialOnly += m.serialOnly ?? 0
    if (m.validate) for (const t of trees.get(slug)!) revalidate += t.bytes
  }
  const anySerialOnly =
    removedSerial > 0 || Object.values(modes).some((m) => m.serialOnly !== undefined)
  const work = estimatedWork(runs, trees) + revalidate + serialOnly
  if (work <= parallelConfig.aboveBytes) return false
  if (anySerialOnly) {
    if (work > parallelConfig.serialMaxBytes) throw new SerialTooLargeError()
    return false
  }

  const planId = crypto.randomUUID()
  const dir = planDir(session.id, planId)
  const plan: CommitPlan = {
    id: planId,
    layout: ctx.repo.layout,
    base: ctx.base,
    fence: ctx.fence,
    types: {},
    runs: runs.map((r) => r.seq),
    units: [],
  }
  for (const [slug, s] of Object.entries(inputs.schemas)) {
    const privateType = isPrivateSchema(s)
    const mode = modes[slug]!
    const original = { public: summaryOf(pub.types[slug]), private: summaryOf(priv.types[slug]) }
    plan.types[slug] = {
      privateType,
      ...original,
      bases: mergeBases(mode, original.public, original.private),
      ...(mode.move ? { move: mode.move } : {}),
      ...(mode.validate ? { validate: true } : {}),
    }
    const parts = runs.flatMap((ix) => partsInRange(ix, { type: slug }))
    if (parts.length === 0) continue
    const anyPrivate = parts.some((p) => p.p)
    const marks = runMarks(runs, { type: slug }).map((m) => m.slice(m.indexOf('\u0000') + 1))
    for (const set of (privateType ? ['private'] : ['public', 'private']) as SetName[]) {
      const tree = plan.types[slug]!.bases![set]
      // Nothing can reach a private tree that doesn't exist without a private upsert.
      if (set === 'private' && !privateType && !tree.root && !anyPrivate) continue
      const nodes = await expandHeavyNodes(
        new RepoSource(recordTree, ctx.repo),
        await baseNodes(ctx.repo, tree.root, baseLevelFor(tree.count)),
        leafBytesOf(tree),
      )
      const fromBase = nodes.map((d) => d.lastKey)
      const candidates = [...new Set([...marks, ...fromBase])].filter(isNatural).sort(compareUtf8)
      const ranges = planRanges(
        slug,
        candidates,
        parts,
        { nodes, leafBytes: leafBytesOf(tree) },
        parallelConfig.unitBytes,
        parallelConfig.unitEntries,
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

/** A commit only the serial build can take, too large for it. */
export class SerialTooLargeError extends Error {
  constructor() {
    super(
      'This push changes a type’s privacy in a way that needs the whole type rewritten (records already in both sets, or private records pushed as the type turns public), or removes a type from a collection that predates per-type file counts, and is too large to commit that way. Split the change off: push the privacy change or the removal on its own, with no records.',
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
  perSession: 64,
  perAccount: 96,
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
  if (session.commitPhase === 'validating') {
    const { tasks } = await getJson<{ tasks: ValidationTask[] }>(
      ports,
      `${validationDir(session.id, session.commitPlan)}.json`,
    )
    await queueValidation(ports, session.id, session.commitPlan, tasks.length)
    return
  }
  await queueWork(ports, session.id, session.commitPlan)
}

/** A unit's slices, in the current run index form (plans before pages listed blocks). */
async function unitRuns(ports: Ports, slicesKey: string): Promise<RunIndex[]> {
  const { runs } = await getJson<{ runs: Parameters<typeof normalizeIndex>[0][] }>(ports, slicesKey)
  return runs.map(normalizeIndex)
}

/** Leaves and records this large are logged as a unit meets them. */
const BIG_LEAF_BYTES = 16 * 1024 * 1024
const BIG_RECORD_BYTES = 1024 * 1024
/** Base bodies this large (stored) are logged as a unit reads them. */
const BIG_BODY_BYTES = 1024 * 1024
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`

/** A unit's changes, passed through, logging large records and every 20,000th change. */
async function* watchChanges(
  log: (msg: string) => void,
  changes: AsyncIterable<Change<RecordEntry>>,
): AsyncGenerator<Change<RecordEntry>> {
  let n = 0
  let largest = 0
  for await (const c of changes) {
    n++
    const size = c.entry?.size ?? 0
    if (size > largest) largest = size
    if (size >= BIG_RECORD_BYTES) log(`change ${c.key} is ${mb(size)}`)
    if (n % 20_000 === 0) log(`${n} changes, at ${c.key}, largest ${mb(largest)}`)
    yield c
  }
  log(`${n} changes in all, largest ${mb(largest)}`)
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
  isolate.unitsStarted++
  try {
    await runPendingUnit(ports, unit, session)
  } finally {
    isolate.unitsEnded++
  }
}

async function runPendingUnit(ports: Ports, unit: UnitRow, session: SessionRow): Promise<void> {
  const started = Date.now()
  const plan = await getJson<CommitPlan>(ports, `${planDir(session.id, unit.planId)}/plan.json`)
  const runs = await unitRuns(ports, unit.slicesKey!)
  const t = plan.types[unit.type]!
  const set = unit.set as SetName
  const repo = await planRepo(ports, session.collectionId, plan)
  // Writes in flight hold compressed leaves; halved from the default so two units fit an isolate.
  const sink = new RepoSink<RecordEntry>(repo, {
    bodyOf: bodyOfRecord,
    ...unitSink,
    set,
    type: unit.type,
    holdRecords: true,
  })
  const range = { after: unit.after, through: unit.through }
  // Progress in the Worker's log, so a unit that dies (out of memory, say) shows
  // how far it got, the largest things it met, and what else its isolate ran.
  const tag = `${unit.id} ${unit.type}/${set} (${unit.after ?? 'start'}, ${unit.through ?? 'end'}]`
  const log = (msg: string) => console.log(`[unit] ${isolateTag()} ${tag}: ${msg}`)
  log(`start, attempt ${unit.attempts}, ${runs.length} runs`)
  const changes = watchChanges(
    log,
    deltaChanges(
      ports.stores.internal,
      repo,
      session.id,
      runs,
      unit.type,
      set,
      t.privateType,
      { pub: !!t.public.root, priv: !!t.private.root },
      range,
    ),
  )
  const leaves: NodeDesc[] = []
  const refs = new FileRefDelta()
  // A base with no file references in this set: old records can't hold any, so a
  // packed layout needn't read them (the scale bench, round 3).
  const [baseRefs] = session.baseVersionId
    ? await ports.db
        .select({ pub: schema.versions.publicRefsRoot, priv: schema.versions.privateRefsRoot })
        .from(schema.versions)
        .where(eq(schema.versions.id, session.baseVersionId))
    : []
  if (!baseRefs || (set === 'public' ? baseRefs.pub : baseRefs.priv) === null)
    refs.noOldRefs.add(set)
  // A privacy change merges into the moved tree (`bases`).
  const into = (t.bases ?? t)[set].root
  // Base bodies by how they were read, and their stored bytes where known.
  const reads = { memory: 0, cache: 0, whole: 0, stream: 0, storedBytes: 0 }
  const onBodyRead = (r: BodyRead) => {
    reads[r.from]++
    reads.storedBytes += r.storedBytes ?? 0
    if ((r.storedBytes ?? 0) >= BIG_BODY_BYTES)
      log(`base body ${r.leaf.slice(0, 12)} from ${r.from}, ${mb(r.storedBytes ?? 0)} stored`)
  }
  // The most members compressing at a leaf's end: what a leaf's write holds raw.
  let mostCompressing = 0
  const merged = await mergeTree(
    new RepoSource(recordTree, repo, { onBodyRead, pointers: true, set, type: unit.type }),
    sink,
    into,
    changes,
    {
      ...builderOpts,
      range,
      leafOutput: (d) => {
        leaves.push(d)
        mostCompressing = Math.max(mostCompressing, sink.compressingCount)
        if (d.bytes >= BIG_LEAF_BYTES || leaves.length % 100 === 0)
          log(
            `leaf ${leaves.length} through ${d.lastKey}, ${d.count} entries, ${mb(d.bytes)}; ` +
              `sink: ${sink.compressingCount} compressing (${mb(sink.compressingBytes)}), ` +
              `${sink.writeCount} writes of ${mb(sink.writeBytes)}`,
          )
      },
      onChange: (before, after) => refs.record(set, before, after, unit.type),
      oldPayloads: !refs.noOldRefs.has(set),
    },
  )
  log(
    `merged, ${leaves.length} leaves, ${JSON.stringify(merged.stats)}; ` +
      `base bodies ${JSON.stringify({ ...reads, storedBytes: mb(reads.storedBytes) })}; ` +
      `most compressing ${mostCompressing}`,
  )
  await sink.flush()
  await refs.resolve(repo)
  const survived = unit.through === null || merged.lastKey === unit.through
  const { added, removed, updated } = merged.stats
  const output: UnitOutput = {
    leaves,
    stats: { added, removed, updated },
    refs: [...refs.refs[set]].filter(([, n]) => n !== 0),
    ...(sink.held.length ? { records: sink.held } : {}),
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
  log(`done in ${Math.round((Date.now() - started) / 1000)}s`)
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
  // The last plan chunk queues the assembly once every unit's row is written;
  // once assembled, a commit that revalidates is in its validation jobs.
  if (session.commitPhase === 'planning' || session.commitPhase === 'validating') return
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
    const repo = await planRepo(ports, session.collectionId, plan)
    // Base leaves keep large records as pointers, as in units (runPendingUnit). A source
    // a tree and a sink a set (told each tree's type): layout F reads and writes each
    // set's records apart, and finds them by type.
    const sourceOf = (set: SetName, type: string) =>
      new RepoSource(recordTree, repo, { pointers: true, set, type })
    const sinks = {
      public: new RepoSink<RecordEntry>(repo, { bodyOf: bodyOfRecord, set: 'public' }),
      private: new RepoSink<RecordEntry>(repo, { bodyOf: bodyOfRecord, set: 'private' }),
    }
    const built: Record<string, { public: TreeSummary; private: TreeSummary }> = {}
    for (const [slug, t] of Object.entries(plan.types)) built[slug] = { ...(t.bases ?? t) }
    const refs = new FileRefDelta()
    const stats = { added: 0, removed: 0, updated: 0 }
    const take = (tree: AssembledTree) => {
      built[tree.type]![tree.set] = tree.summary
      stats.added += tree.stats.added
      stats.removed += tree.stats.removed
      stats.updated += tree.stats.updated
      for (const [h, n] of tree.refs) refs.add(tree.set, tree.type, h, n)
    }
    // Trees built by this invocation: it always builds one before it may stop.
    let builtHere = 0
    for (const group of trees(rows)) {
      const { set, type } = group[0]! as { set: SetName; type: string }
      const units = group.filter((u) => !u.gap)
      // A tree an earlier attempt finished is kept, so an attempt that stops
      // (its time budget, or the wall clock) carries on at the next tree.
      const treeKey = `${planDir(sessionId, planId)}/trees/${set}.${encodeURIComponent(type)}.json`
      const saved = await getJsonIfAny<AssembledTree>(ports, treeKey)
      if (saved && saved.units.join() === units.map((u) => u.id).join()) {
        take(saved)
        continue
      }
      if (builtHere > 0 && Date.now() - now > assemblyLimits.budgetMs) {
        // Out of time for another tree: hand the rest to a fresh invocation.
        await release()
        await ports.jobs.enqueue({ type: 'commit.assemble', sessionId })
        return
      }
      // A type made public counts every record of its new public tree as added
      // (the build does that), not its public changes.
      const countStats = !(plan.types[type]!.move === 'toPublic' && set === 'public')
      const treeStats = { added: 0, removed: 0, updated: 0 }
      const treeRefs = new Map<string, number>()
      const treeRuns: HeldRun[] = []
      // Each segment's output is read once, when assembly reaches it.
      const segments: Segment[] = units.map((u) => ({
        after: u.after,
        through: u.through,
        leaves: async () => {
          const out = await getJson<UnitOutput>(ports, u.outputKey!)
          if (countStats) {
            treeStats.added += out.stats.added
            treeStats.removed += out.stats.removed
            treeStats.updated += out.stats.updated
          }
          // A unit covers one type, so its deltas are that type's too.
          for (const [h, n] of out.refs) treeRefs.set(h, (treeRefs.get(h) ?? 0) + n)
          if (out.records) treeRuns.push(...out.records)
          return out.leaves
        },
      }))
      const treeStarted = Date.now()
      sinks[set].type = type
      const result = await assembleTree(
        sourceOf(set, type),
        sinks[set],
        built[type]![set].root,
        segments,
      )
      console.log(
        `[assemble] ${isolateTag()} ${sessionId} ${type}/${set}: ${segments.length} segments ` +
          `in ${Math.round((Date.now() - treeStarted) / 1000)}s, ${JSON.stringify(result.stats)}`,
      )
      const tree: AssembledTree = {
        set,
        type,
        units: units.map((u) => u.id),
        summary: summaryOf(
          result.root
            ? { root: result.root.hash, count: result.root.count, bytes: result.root.bytes }
            : undefined,
        ),
        stats: treeStats,
        refs: [...treeRefs],
      }
      // The tree's nodes are written before it counts as done, and in layout F its units'
      // records named in the set's index (a retry writing them again folds in once).
      await sinks[set].flush()
      await repo.records?.[set].appendRuns?.(treeRuns)
      await putJson(ports, treeKey, tree)
      take(tree)
      builtHere++
      await touch(ports, sessionId)
    }
    await sinks.public.flush()
    await sinks.private.flush()

    const assembled: Assembled = { built, refs: refsOut(refs), stats }
    if (Object.values(plan.types).some((t) => t.validate)) {
      // A changed schema: the new trees are revalidated in jobs, then published.
      await putJson(ports, `${planDir(sessionId, planId)}/assembled.json`, assembled)
      await startValidation(ports, session, plan, built)
      await release()
      return
    }
    await publish(ports, session, plan, assembled)
  } catch (err) {
    await release()
    throw err
  }
}

/** One tree assembly finished, kept so a later attempt doesn't build it again. */
interface AssembledTree {
  set: SetName
  type: string
  /** The units it was built from: a saved tree counts only for the same ones. */
  units: string[]
  summary: TreeSummary
  stats: { added: number; removed: number; updated: number }
  /** File reference deltas: [file hash, delta]. */
  refs: [string, number][]
}

/** What assembly built, kept for the publish job when a schema is revalidated first. */
interface Assembled {
  built: Record<string, { public: TreeSummary; private: TreeSummary }>
  /** File reference deltas: [set, type, file hash, delta]. */
  refs: [SetName, string, string, number][]
  stats: { added: number; removed: number; updated: number }
}

const refsOut = (refs: FileRefDelta): Assembled['refs'] =>
  (['public', 'private'] as const).flatMap((set) =>
    [...refs.typed[set]].map(([k, n]) => {
      const slash = k.lastIndexOf('/')
      return [set, k.slice(0, slash), k.slice(slash + 1), n] as [SetName, string, string, number]
    }),
  )

function refsIn(rows: Assembled['refs']): FileRefDelta {
  const refs = new FileRefDelta()
  for (const [set, type, h, n] of rows) refs.add(set, type, h, n)
  return refs
}

/** Commit the assembled trees as the new version and settle the session. */
async function publish(ports: Ports, session: SessionRow, plan: CommitPlan, a: Assembled) {
  const inputs = await loadInputs(ports, session.id)
  const hashes = schemaHashes(inputs.schemas)
  const moves: Record<string, 'toPrivate' | 'toPublic'> = {}
  for (const [slug, t] of Object.entries(plan.types)) if (t.move) moves[slug] = t.move
  const outcome = await commitOutcome(ports, session.id, () =>
    commitVersion(ports, {
      collectionId: session.collectionId,
      ...(plan.layout ? { recordLayout: plan.layout } : {}),
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
      prebuilt: { trees: a.built, refs: refsIn(a.refs), stats: a.stats, moves },
    }),
  )
  await settleSession(ports, session.id, outcome)
}

// --- Revalidating a changed schema ------------------------------------------------------

export const validateConfig = {
  /** Record bytes one validation job reads, about. */
  taskBytes: 256 * 1024 * 1024,
}

/** One validation job: one key range `(after, through]` of one new tree. */
interface ValidationTask {
  type: string
  set: SetName
  root: string
  after: string | null
  through: string | null
}

interface ValidationResult {
  total: number
  errors: { recordId: string; type: string; errors: string[] }[]
}

const MAX_REPORTED = 100
const validationDir = (sessionId: string, planId: string) =>
  `${planDir(sessionId, planId)}/validate`

/**
 * Split the new trees of every type to revalidate into key ranges of about
 * `taskBytes` (at node boundaries of the level the planner reads), and queue a
 * job for each. The session goes to phase 'validating'; the job that finds
 * every range done queues the publish.
 */
async function startValidation(
  ports: Ports,
  session: SessionRow,
  plan: CommitPlan,
  built: Assembled['built'],
) {
  const repo = await planRepo(ports, session.collectionId, plan)
  const tasks: ValidationTask[] = []
  for (const [type, t] of Object.entries(plan.types)) {
    if (!t.validate) continue
    for (const set of ['public', 'private'] as SetName[]) {
      const tree = built[type]![set]
      if (!tree.root) continue
      const nodes = await baseNodes(repo, tree.root, baseLevelFor(tree.count))
      let after: string | null = null
      let acc = 0
      for (const [i, n] of nodes.entries()) {
        acc += n.bytes
        const last = i === nodes.length - 1
        if (acc >= validateConfig.taskBytes || last) {
          tasks.push({ type, set, root: tree.root, after, through: last ? null : n.lastKey })
          after = n.lastKey
          acc = 0
        }
      }
    }
  }
  await putJson(ports, `${validationDir(session.id, plan.id)}.json`, { tasks })
  await ports.db
    .update(schema.pushSessions)
    .set({ commitPhase: 'validating', progressAt: new Date(), stalls: 0 })
    .where(and(eq(schema.pushSessions.id, session.id), eq(schema.pushSessions.commitPlan, plan.id)))
  await queueValidation(ports, session.id, plan.id, tasks.length)
}

/** Validation results written so far. */
async function validationsDone(ports: Ports, sessionId: string, planId: string) {
  const prefix = `${validationDir(sessionId, planId)}/`
  const done = new Set<number>()
  let cursor: string | undefined
  do {
    const page = await ports.stores.internal.list(prefix, cursor)
    for (const key of page.keys) done.add(Number(key.slice(prefix.length, -'.json'.length)))
    cursor = page.cursor
  } while (cursor)
  return done
}

/** Queue the validation jobs not done yet, or the publish when all are. */
async function queueValidation(ports: Ports, sessionId: string, planId: string, count: number) {
  const done = await validationsDone(ports, sessionId, planId)
  const todo = Array.from({ length: count }, (_, i) => i).filter((i) => !done.has(i))
  if (todo.length === 0) {
    await ports.jobs.enqueue({ type: 'commit.publish', sessionId })
    return
  }
  await ports.jobs.enqueueBatch(
    todo.map((task) => ({ type: 'commit.validate', sessionId, planId, task })),
  )
}

/** A tree's entries with bodies in `(after, through]`, leaf by leaf, each streamed. */
async function* entriesInRange(
  source: RepoSource<RecordEntry>,
  root: string,
  after: string | null,
  through: string | null,
): AsyncGenerator<RecordEntry> {
  const inRange = (k: string) =>
    (after === null || compareUtf8(k, after) > 0) &&
    (through === null || compareUtf8(k, through) <= 0)
  async function* visit(desc: NodeDesc, low: string | null): AsyncGenerator<RecordEntry> {
    if (after !== null && compareUtf8(desc.lastKey, after) <= 0) return
    if (through !== null && low !== null && compareUtf8(low, through) >= 0) return
    if (desc.level === 0) {
      for await (const e of source.leafStream(desc.hash)) if (inRange(e.key)) yield e
      return
    }
    const node = await source.node(desc.hash)
    if (node.kind !== 'node') return
    for (const [i, c] of node.children.entries())
      yield* visit(c, i === 0 ? low : node.children[i - 1]!.lastKey)
  }
  yield* visit(await rootDesc(source, root), null)
}

/** One validation job. Idempotent: a range already checked is skipped. */
export async function runValidation(
  ports: Ports,
  sessionId: string,
  planId: string,
  task: number,
): Promise<void> {
  const session = await getSession(ports, sessionId)
  if (
    session?.status !== 'committing' ||
    session.commitPlan !== planId ||
    session.commitPhase !== 'validating'
  )
    return
  const { tasks } = await getJson<{ tasks: ValidationTask[] }>(
    ports,
    `${validationDir(sessionId, planId)}.json`,
  )
  const key = `${validationDir(sessionId, planId)}/${task}.json`
  if (!(await ports.stores.internal.head(key))) {
    const t = tasks[task]!
    const inputs = await loadInputs(ports, sessionId)
    const validate = compileSchema(inputs.schemas[t.type]!)
    const plan = await getJson<CommitPlan>(ports, `${planDir(sessionId, planId)}/plan.json`)
    const repo = await planRepo(ports, session.collectionId, plan)
    const source = new RepoSource(recordTree, repo, { set: t.set, type: t.type })
    const result: ValidationResult = { total: 0, errors: [] }
    for await (const e of entriesInRange(source, t.root, t.after, t.through)) {
      const errs = validate((JSON.parse(e.body!) as { data: unknown }).data)
      if (errs.length === 0) continue
      result.total++
      if (result.errors.length < MAX_REPORTED)
        result.errors.push({ recordId: e.key, type: t.type, errors: errs })
    }
    await putJson(ports, key, result)
    await touch(ports, sessionId)
  }
  const done = await validationsDone(ports, sessionId, planId)
  if (done.size === tasks.length) await ports.jobs.enqueue({ type: 'commit.publish', sessionId })
}

/** After validation: publish the assembled version, or fail with the records that don't fit. */
export async function publishValidated(ports: Ports, sessionId: string): Promise<void> {
  const session = await getSession(ports, sessionId)
  if (
    session?.status !== 'committing' ||
    !session.commitPlan ||
    session.commitPhase !== 'validating'
  )
    return
  const planId = session.commitPlan
  const dir = validationDir(sessionId, planId)
  const { tasks } = await getJson<{ tasks: ValidationTask[] }>(ports, `${dir}.json`)
  if ((await validationsDone(ports, sessionId, planId)).size < tasks.length) return
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
  try {
    let total = 0
    const errors: ValidationResult['errors'] = []
    for (let i = 0; i < tasks.length; i++) {
      const r = await getJson<ValidationResult>(ports, `${dir}/${i}.json`)
      total += r.total
      errors.push(...r.errors.slice(0, MAX_REPORTED - errors.length))
    }
    if (total > 0) {
      const outcome = await commitOutcome(ports, sessionId, async () => ({
        status: 'invalid' as const,
        errors,
        total,
      }))
      await settleSession(ports, sessionId, outcome)
      return
    }
    const plan = await getJson<CommitPlan>(ports, `${planDir(sessionId, planId)}/plan.json`)
    const assembled = await getJson<Assembled>(
      ports,
      `${planDir(sessionId, planId)}/assembled.json`,
    )
    await publish(ports, session, plan, assembled)
  } finally {
    await ports.db
      .update(schema.pushSessions)
      .set({ assemblyLease: null })
      .where(eq(schema.pushSessions.id, sessionId))
  }
}

registerJob('commit.plan', async (job, ports) =>
  writePlanChunk(ports, String(job.sessionId), String(job.planId), Number(job.chunk)),
)
registerJob('commit.unit', async (job, ports) => runCommitUnit(ports, String(job.unitId)))
registerJob('commit.assemble', async (job, ports) => assembleParallel(ports, String(job.sessionId)))
registerJob('commit.validate', async (job, ports) =>
  runValidation(ports, String(job.sessionId), String(job.planId), Number(job.task)),
)
registerJob('commit.publish', async (job, ports) => publishValidated(ports, String(job.sessionId)))
