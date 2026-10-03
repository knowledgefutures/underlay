/**
 * The commit engine: turn a base version plus sorted changes into a new
 * version, and publish it.
 *
 *   1. per (set, type): merge the base tree with that set's changes
 *      (unchanged trees are reused as they are; type flips move whole trees);
 *   2. file sets from reference-count deltas (file-refs.ts);
 *   3. set objects, the private set object, the root, the version hash;
 *   4. CAS publish (publish.ts), then the signed log entry and head.json.
 *
 * Every object is written before the publish, keyed by content, so a crash or a
 * lost race leaves only unreferenced objects. Cost is O(changes) except where
 * the work is inherently per-record: revalidating a type whose schema changed,
 * removing a type, and moving a type between sets when both sets hold records.
 *
 * This runs a whole commit in one call, which suits small and medium pushes.
 * Large ones split the per-(set, type) merges into key-range units run as jobs
 * (edge-redesign.md, Commit step 2); the merge code is the same.
 */
import {
  type Change,
  compareUtf8,
  emptySet,
  fileTree,
  isEmptySet,
  iterate,
  makeRoot,
  mergeTree,
  type PrivateSetObject,
  type RecordEntry,
  recordTree,
  type SetObject,
  setRecordTotals,
  type TreeSummary,
} from '@underlay/core'
import {
  appendLog,
  bodyOfRecord,
  dropRecordBody,
  readHead,
  recordPayloadBytes,
  type Repo,
  RepoSink,
  RepoSource,
  signEntry,
} from '@underlay/repo'
import { eq } from 'drizzle-orm'

import * as schema from '../db/schema.js'
import type { Ports } from '../ports.js'
import { applyFileSet, FileRefDelta, fileSizes, type SetName } from './file-refs.js'
import { publishVersion, type SchemaUsageChange } from './publish.js'
import { bumpType, deriveSemver, parseSemver } from './semver.js'

export type ChangeSource = Iterable<Change<RecordEntry>> | AsyncIterable<Change<RecordEntry>>

export interface TypeInput {
  slug: string
  schema: Record<string, unknown>
  schemaHash: string
  /** Sorted changes per set (null: no changes there). Upserts carry `body`. */
  public: ChangeSource | null
  private: ChangeSource | null
}

export interface BaseVersion {
  id: string
  seq: number
  semver: string
  hash: string
  publicRefsRoot: string | null
  privateRefsRoot: string | null
}

export interface CommitInput {
  collectionId: string
  base: BaseVersion | null
  /** The full new type set: types in the base but not here are removed. */
  types: TypeInput[]
  /** The full new metadata. */
  metadata: Record<string, unknown> | null
  /** Changes to declared (possibly unreferenced) files. */
  declaredFiles?: { add: string[]; remove: string[] }
  message?: string | null
  pushedBy?: string | null
  appId?: string | null
  actorId?: string | null
  /**
   * Trees already merged by a parallel commit (push/parallel.ts), per type, with
   * the file reference deltas and change counts of the units that built them.
   * The types' change sources are then ignored. Only for commits where no type
   * changes privacy or schema and none is removed.
   */
  prebuilt?: {
    trees: Record<string, { public: TreeSummary; private: TreeSummary }>
    refs: FileRefDelta
    stats: { added: number; removed: number; updated: number }
  }
  /** Validate a record's data against its type's schema; errors or null. Used when a schema changes. */
  validate?: (schema: Record<string, unknown>, data: unknown) => string[] | null
  /**
   * Migration only: keep a v1 version's identity. Its semver (v1's rules may
   * have differed over time), creation time and format 1 hashes; and skip the
   * post-publish job (webhooks would fire for history).
   */
  migrated?: {
    semver: string
    createdAt: Date
    legacyHash: string | null
    legacyPublicHash: string | null
  }
}

export type CommitResult =
  | { status: 'committed'; version: typeof schema.versions.$inferSelect; written: string[] }
  | { status: 'no_changes'; versionHash: string }
  | { status: 'conflict'; headVersionId: string | null }
  | {
      status: 'invalid'
      errors: { recordId: string; type: string; errors: string[] }[]
      total: number
    }

const MAX_REPORTED_ERRORS = 100
const SPILL_BYTES = 4 * 1024 * 1024

const summaryOf = (t: {
  root: { hash: string; count: number; bytes: number } | null
}): TreeSummary =>
  t.root
    ? { root: t.root.hash, count: t.root.count, bytes: t.root.bytes }
    : { root: null, count: 0, bytes: 0 }

const isPrivateSchema = (s: Record<string, unknown>) => s.private === true

async function* asAsync<T>(src: Iterable<T> | AsyncIterable<T>): AsyncGenerator<T> {
  yield* src as AsyncIterable<T>
}

/** Merge two sorted change streams; on equal keys the second wins. */
async function* overlay(
  a: AsyncIterable<Change<RecordEntry>>,
  b: AsyncIterable<Change<RecordEntry>>,
): AsyncGenerator<Change<RecordEntry>> {
  const ai = a[Symbol.asyncIterator]()
  const bi = b[Symbol.asyncIterator]()
  let x = await ai.next()
  let y = await bi.next()
  while (!x.done || !y.done) {
    if (y.done || (!x.done && compareUtf8(x.value.key, y.value.key) < 0)) {
      yield x.value
      x = await ai.next()
    } else if (x.done || compareUtf8(y.value.key, x.value.key) < 0) {
      yield y.value
      y = await bi.next()
    } else {
      yield y.value
      x = await ai.next()
      y = await bi.next()
    }
  }
}

/** Every entry of a tree (with bodies) as upserts. */
async function* treeAsUpserts(
  repo: Repo,
  root: string | null,
): AsyncGenerator<Change<RecordEntry>> {
  for await (const e of iterate(new RepoSource(recordTree, repo), root, { payloads: true })) {
    yield { key: e.key, entry: e }
  }
}

export async function commitVersion(ports: Ports, input: CommitInput): Promise<CommitResult> {
  const { db } = ports
  const repo = await ports.stores.forCollection(input.collectionId)
  const [collection] = await db
    .select()
    .from(schema.collections)
    .where(eq(schema.collections.id, input.collectionId))
    .limit(1)
  if (!collection) throw new Error(`Collection ${input.collectionId} not found`)

  const base = input.base
  const baseRoot = base ? await repo.root(base.hash) : null
  const basePublic: SetObject = baseRoot?.public ?? emptySet()
  const basePrivate: SetObject = baseRoot?.private
    ? await repo.privateSet(baseRoot.private)
    : emptySet()

  const source = new RepoSource(recordTree, repo)
  const sink = new RepoSink<RecordEntry>(repo, { bodyOf: bodyOfRecord })
  const builderOpts = {
    payloadBytes: recordPayloadBytes,
    dropPayload: dropRecordBody,
    spillBytes: SPILL_BYTES,
  }
  const refs = input.prebuilt?.refs ?? new FileRefDelta()
  const stats = input.prebuilt ? { ...input.prebuilt.stats } : { added: 0, removed: 0, updated: 0 }
  let recordsChanged = stats.added + stats.removed + stats.updated > 0

  const newPublic: SetObject = emptySet()
  const newPrivate: SetObject = emptySet()

  // Stats count per set: a record moving between sets is a removal and an addition.
  const merge = async (
    set: SetName,
    baseTree: string | null,
    changes: AsyncIterable<Change<RecordEntry>>,
  ) => {
    const result = await mergeTree(source, sink, baseTree, changes, {
      ...builderOpts,
      onChange: (before, after) => {
        refs.record(set, before, after)
        recordsChanged = true
        if (before && after) stats.updated++
        else if (after) stats.added++
        else stats.removed++
      },
    })
    return summaryOf(result)
  }

  const inputSlugs = new Set(input.types.map((t) => t.slug))
  let schemaChanged = false

  // Schemas are repository objects too (schemas/<hash>.json).
  await Promise.all(
    input.types.map(async (t) => {
      if ((await repo.putSchema(t.schema)) !== t.schemaHash) {
        throw new Error(`Schema for ${t.slug} does not match its hash`)
      }
    }),
  )
  sink.written.push(...input.types.map((t) => `schemas/${t.schemaHash}.json`))

  for (const t of input.types) {
    const pubBase = basePublic.types[t.slug]
    const privBase = basePrivate.types[t.slug]
    if ((pubBase ?? privBase)?.schema !== t.schemaHash) schemaChanged = true
    const prebuilt = input.prebuilt?.trees[t.slug]
    if (input.prebuilt) {
      if (!prebuilt) throw new Error(`Parallel commit has no trees for type ${t.slug}`)
      if (isPrivateSchema(t.schema)) {
        newPrivate.types[t.slug] = { schema: t.schemaHash, ...prebuilt.private }
      } else {
        newPublic.types[t.slug] = { schema: t.schemaHash, ...prebuilt.public }
        if (prebuilt.private.root)
          newPrivate.types[t.slug] = { schema: t.schemaHash, ...prebuilt.private }
      }
      continue
    }
    const nowPrivate = isPrivateSchema(t.schema)
    const wasPrivateType = !pubBase && !!privBase
    const pubChanges = t.public ? asAsync(t.public) : null
    const privChanges = t.private ? asAsync(t.private) : null

    let pub: TreeSummary = { root: null, count: 0, bytes: 0 }
    let priv: TreeSummary = { root: null, count: 0, bytes: 0 }
    const pubRoot = pubBase?.root ?? null
    const privRoot = privBase?.root ?? null

    if (nowPrivate) {
      // Every record of a private type is in the private set. If the type was
      // public, its public records move over: a plain move when the private
      // tree was empty, otherwise a merge.
      if (pubChanges)
        throw new Error(`Type ${t.slug} is private; its changes belong to the private set`)
      if (pubRoot && !privRoot && !privChanges) {
        priv = pubBase!
      } else if (pubRoot) {
        priv = await merge(
          'private',
          privRoot,
          overlay(treeAsUpserts(repo, pubRoot), privChanges ?? asAsync([])),
        )
        for await (const e of treeAsUpserts(repo, pubRoot)) refs.record('public', e.entry, null)
      } else {
        priv = privChanges ? await merge('private', privRoot, privChanges) : summary(privBase)
      }
      if (pubRoot) recordsChanged = true
    } else if (wasPrivateType) {
      // A private type made public: its records become public (per-record flags
      // were not kept while the whole type was private), except those this push
      // marks private.
      pub = await merge(
        'public',
        null,
        overlay(treeAsUpserts(repo, privRoot), pubChanges ?? asAsync([])),
      )
      for await (const e of treeAsUpserts(repo, privRoot)) refs.record('private', e.entry, null)
      priv = privChanges
        ? await merge('private', null, privChanges)
        : { root: null, count: 0, bytes: 0 }
      recordsChanged = true
    } else {
      pub = pubChanges ? await merge('public', pubRoot, pubChanges) : summary(pubBase)
      priv = privChanges ? await merge('private', privRoot, privChanges) : summary(privBase)
    }

    if (nowPrivate) {
      newPrivate.types[t.slug] = { schema: t.schemaHash, ...priv }
    } else {
      newPublic.types[t.slug] = { schema: t.schemaHash, ...pub }
      if (priv.root) newPrivate.types[t.slug] = { schema: t.schemaHash, ...priv }
    }
  }

  // Removed types: drop their trees, and release their file references.
  for (const [set, base_] of [
    ['public', basePublic],
    ['private', basePrivate],
  ] as const) {
    for (const [slug, entry] of Object.entries(base_.types)) {
      if (inputSlugs.has(slug)) continue
      schemaChanged = true
      for await (const e of treeAsUpserts(repo, entry.root)) {
        refs.record(set, e.entry, null)
        stats.removed++
        recordsChanged = true
      }
    }
  }
  await sink.flush()

  // Revalidate types whose schema changed (records pushed earlier were checked
  // against the old schema). O(type size), inherent to a schema change.
  const errors: { recordId: string; type: string; errors: string[] }[] = []
  let errorCount = 0
  if (input.validate) {
    for (const t of input.types) {
      const before = basePublic.types[t.slug] ?? basePrivate.types[t.slug]
      if (!before || before.schema === t.schemaHash) continue
      for (const tree of [newPublic.types[t.slug], newPrivate.types[t.slug]]) {
        for await (const e of iterate(source, tree?.root ?? null, { payloads: true })) {
          const errs = input.validate(t.schema, (JSON.parse(e.body!) as { data: unknown }).data)
          if (errs) {
            errorCount++
            if (errors.length < MAX_REPORTED_ERRORS)
              errors.push({ recordId: e.key, type: t.slug, errors: errs })
          }
        }
      }
    }
  }
  if (errorCount > 0) return { status: 'invalid', errors, total: errorCount }

  // File sets.
  const pubFiles = await applyFileSet(
    db,
    repo,
    { refsRoot: base?.publicRefsRoot ?? null, files: basePublic.files },
    refs.refs.public,
    null,
  )
  const privFiles = await applyFileSet(
    db,
    repo,
    { refsRoot: base?.privateRefsRoot ?? null, files: basePrivate.files },
    refs.refs.private,
    input.declaredFiles ?? null,
  )
  newPublic.files = pubFiles.files
  newPrivate.files = privFiles.files

  // Root.
  const privSet: PrivateSetObject = { ...newPrivate, salt: collection.privateSalt }
  const root = makeRoot(input.metadata, newPublic, isEmptySet(newPrivate) ? null : privSet)
  if (root.private) await repo.putPrivateSet(privSet)
  const versionHash = await repo.putRoot(root)
  if (base && versionHash === base.hash) return { status: 'no_changes', versionHash }

  const sv = input.migrated
    ? parseSemver(input.migrated.semver)
    : deriveSemver(base?.semver ?? null, schemaChanged, recordsChanged)

  const pubTotals = setRecordTotals(newPublic)
  const privTotals = setRecordTotals(newPrivate)
  const typeCounts: Record<string, number> = {}
  const publicTypeCounts: Record<string, number> = {}
  for (const [slug, t] of Object.entries(newPublic.types)) {
    typeCounts[slug] = (typeCounts[slug] ?? 0) + t.count
    publicTypeCounts[slug] = t.count
  }
  for (const [slug, t] of Object.entries(newPrivate.types))
    typeCounts[slug] = (typeCounts[slug] ?? 0) + t.count

  const usage: SchemaUsageChange[] = []
  for (const [set, before, after] of [
    ['public', basePublic, newPublic],
    ['private', basePrivate, newPrivate],
  ] as const) {
    const slugs = new Set([...Object.keys(before.types), ...Object.keys(after.types)])
    for (const slug of slugs) {
      const was = before.types[slug]?.schema ?? null
      const now = after.types[slug]?.schema ?? null
      if (was !== now) usage.push({ set, typeSlug: slug, schemaHash: now, wasOpen: was !== null })
    }
  }

  // The cumulative public files tree: add files that entered the public set.
  const publicFilesRoot = await mergeCumulativeFiles(
    ports,
    repo,
    collection.publicFilesRoot,
    pubFiles.added,
  )

  const versionId = crypto.randomUUID()
  const versionRow = {
    id: versionId,
    collectionId: input.collectionId,
    seq: (base?.seq ?? 0) + 1,
    semver: sv.semver,
    major: sv.major,
    minor: sv.minor,
    patch: sv.patch,
    hash: versionHash,
    baseSemver: base?.semver ?? null,
    message: input.message ?? null,
    pushedBy: input.pushedBy ?? null,
    appId: input.appId ?? null,
    actorId: input.actorId ?? null,
    recordCount: pubTotals.count + privTotals.count,
    publicRecordCount: pubTotals.count,
    fileCount: newPublic.files.count + newPrivate.files.count,
    totalBytes: pubTotals.bytes + privTotals.bytes + newPublic.files.bytes + newPrivate.files.bytes,
    publicFileCount: newPublic.files.count,
    publicTotalBytes: pubTotals.bytes + newPublic.files.bytes,
    typeCounts,
    publicTypeCounts,
    hasPrivate: root.private !== null,
    publicRefsRoot: pubFiles.refsRoot,
    privateRefsRoot: privFiles.refsRoot,
    changes: stats,
    ...(input.migrated
      ? {
          createdAt: input.migrated.createdAt,
          legacyHash: input.migrated.legacyHash,
          legacyPublicHash: input.migrated.legacyPublicHash,
        }
      : {}),
  }
  const published = await publishVersion(db, {
    version: versionRow,
    baseVersionId: base?.id ?? null,
    collectionUpdate: { publicFilesRoot, summary: summarize(input.metadata) },
    schemaHashes: [...new Set(input.types.map((t) => t.schemaHash))],
    usage,
  })
  if (!published.ok) return { status: 'conflict', headVersionId: published.headVersionId }

  const [version] = await db
    .select()
    .from(schema.versions)
    .where(eq(schema.versions.id, versionId))
    .limit(1)

  // The version log and head, after every object the version reaches. If this
  // fails the version is still published; the repair job rewrites the log.
  try {
    await appendVersionLog(ports, repo, input.collectionId, version!)
  } catch (err) {
    console.error(`[commit] version log for ${versionId} failed; queued a repair`, err)
    await ports.jobs.enqueue({ type: 'repo.repairLog', collectionId: input.collectionId })
  }
  // Migrated history gets its reference-log events but fires no webhooks.
  await ports.jobs.enqueue(
    input.migrated
      ? { type: 'refs.index', versionId }
      : { type: 'version.published', versionId, bump: bumpType(schemaChanged, recordsChanged) },
  )
  return { status: 'committed', version: version!, written: sink.written }
}

const summary = (t: TreeSummary | undefined): TreeSummary =>
  t ? { root: t.root, count: t.count, bytes: t.bytes } : { root: null, count: 0, bytes: 0 }

/** Bounded fields for collection lists, from the version metadata. */
function summarize(metadata: Record<string, unknown> | null): schema.CollectionSummary | null {
  if (!metadata) return null
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined)
  const out: schema.CollectionSummary = {}
  const title = str(metadata.title ?? metadata.name, 200)
  const description = str(metadata.description, 1000)
  const license = str(metadata.license, 100)
  if (title) out.title = title
  if (description) out.description = description
  if (license) out.license = license
  if (Array.isArray(metadata.tags)) {
    out.tags = metadata.tags
      .filter((t): t is string => typeof t === 'string')
      .slice(0, 20)
      .map((t) => t.slice(0, 50))
  }
  return out
}

async function mergeCumulativeFiles(
  ports: Ports,
  repo: Repo,
  root: string | null,
  added: string[],
): Promise<string | null> {
  if (added.length === 0) return root
  const sizes = await fileSizes(ports.db, added)
  const changes = added
    .slice()
    .sort(compareUtf8)
    .map((h) => ({ key: h, entry: { key: h, size: sizes.get(h)! } }))
  const sink = new RepoSink(repo)
  const merged = await mergeTree(new RepoSource(fileTree, repo), sink, root, changes)
  await sink.flush()
  return merged.root?.hash ?? null
}

/** Write the signed log entry for a published version, then head.json. Idempotent. */
export async function appendVersionLog(
  ports: Ports,
  repo: Repo,
  collectionId: string,
  v: Pick<
    typeof schema.versions.$inferSelect,
    'seq' | 'semver' | 'hash' | 'baseSemver' | 'message' | 'appId' | 'actorId' | 'createdAt'
  >,
): Promise<void> {
  const head = await readHead(repo, collectionId)
  if (head && head.seq >= v.seq) return
  if ((head?.seq ?? 0) !== v.seq - 1) {
    throw new Error(`Log for ${collectionId} is at ${head?.seq ?? 0}, cannot append ${v.seq}`)
  }
  const entry = await signEntry(await ports.signer(), {
    seq: v.seq,
    semver: v.semver,
    versionHash: v.hash,
    baseSemver: v.baseSemver,
    message: v.message,
    appId: v.appId,
    actorId: v.actorId,
    createdAt: v.createdAt.toISOString(),
    prev: head?.entryHash ?? null,
  })
  await appendLog(repo, collectionId, entry)
}
