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
 * lost race leaves only unreferenced objects. The publish holds only under the
 * storage fence the write phase began with (cleanup/fence.ts); when a deletion
 * window opened since, commitVersion throws FenceError and the caller, which
 * owns the change streams, runs the commit again (`fenced`). Cost is O(changes) except where
 * the work is inherently per-record: revalidating a type whose schema changed,
 * removing a type, and moving a type between sets when both sets hold records.
 *
 * This runs a whole commit in one call, which suits small and medium pushes.
 * Large ones split the per-(set, type) merges into key-range units run as jobs
 * (edge-redesign.md, Commit step 2); the merge code is the same.
 */
import {
  appendLog,
  type BuildTypeInput,
  buildVersion,
  bumpType,
  type CollectionInfo,
  compareUtf8,
  deriveSemver,
  FileRefDelta,
  fileTree,
  jcs,
  mergeTree,
  parseSemver,
  readCollectionInfo,
  readHead,
  type Repo,
  RepoSink,
  RepoSource,
  setRecordTotals,
  signEntry,
  type Signer,
  type TreeSummary,
  writeCollectionInfo,
} from '@underlay/protocol'
import { eq } from 'drizzle-orm'

import { FenceError, writeFence } from '../cleanup/fence.js'
import * as schema from '../db/schema.js'
import type { Ports } from '../ports.js'
import { collectionFileSizes, fileSizes } from './file-refs.js'
import { publishVersion, type SchemaUsageChange } from './publish.js'

export type { ChangeSource } from '@underlay/protocol'
export type TypeInput = BuildTypeInput

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
  /**
   * The storage fence epoch read when this commit's write phase began (before a
   * parallel commit's units, or around a retry loop). Read here when absent.
   */
  fence?: number
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
   * have differed over time), creation time and v1 hashes; and skip the
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

export async function commitVersion(ports: Ports, input: CommitInput): Promise<CommitResult> {
  const { db } = ports
  const repo = await ports.stores.forCollection(input.collectionId)
  const [collection] = await db
    .select()
    .from(schema.collections)
    .where(eq(schema.collections.id, input.collectionId))
    .limit(1)
  if (!collection) throw new Error(`Collection ${input.collectionId} not found`)
  const fence = input.fence ?? (await writeFence(db))

  const built = await buildVersion(repo, {
    base: input.base,
    types: input.types,
    metadata: input.metadata,
    ...(input.declaredFiles ? { declaredFiles: input.declaredFiles } : {}),
    salt: collection.privateSalt,
    // Migration copies v1's files as they were; every other commit proves possession.
    fileSizes: (hashes) =>
      input.migrated
        ? fileSizes(db, hashes)
        : collectionFileSizes(db, repo, collection, input.base?.hash ?? null, hashes),
    ...(input.validate ? { validate: input.validate } : {}),
    ...(input.prebuilt ? { prebuilt: input.prebuilt } : {}),
  })
  if (built.status === 'invalid') return built
  const base = input.base
  const {
    versionHash,
    root,
    basePublic,
    basePrivate,
    newPublic,
    newPrivate,
    stats,
    schemaChanged,
    recordsChanged,
  } = built
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
    built.publicFilesAdded,
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
    publicRefsRoot: built.publicRefsRoot,
    privateRefsRoot: built.privateRefsRoot,
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
    fence,
    version: versionRow,
    baseVersionId: base?.id ?? null,
    collectionUpdate: { publicFilesRoot, summary: summarize(input.metadata) },
    schemaHashes: [...new Set(input.types.map((t) => t.schemaHash))],
    usage,
  })
  if (published.fenced) throw new FenceError()
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
  return { status: 'committed', version: version!, written: built.written }
}

/** Bounded fields for collection lists, from the version metadata. */
export function summarize(
  metadata: Record<string, unknown> | null,
): schema.CollectionSummary | null {
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

export async function mergeCumulativeFiles(
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
  const signer = await ports.signer()
  // collection.json first: a reader must find the key before an entry it signs.
  await publishCollectionInfo(ports, repo, collectionId, signer)
  const entry = await signEntry(signer, {
    collectionId,
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

/**
 * Keep `collection.json` current: the collection's names and every key that has
 * signed its log (a rotated key stays listed, so old entries still verify).
 * Written only when it changes.
 */
export async function publishCollectionInfo(
  ports: Ports,
  repo: Repo,
  collectionId: string,
  signer: Signer,
): Promise<void> {
  const [row] = await ports.db
    .select({ c: schema.collections, owner: schema.organization.slug })
    .from(schema.collections)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.collections.organizationId))
    .where(eq(schema.collections.id, collectionId))
    .limit(1)
  if (!row) throw new Error(`Collection ${collectionId} not found`)
  const existing = await readCollectionInfo(repo, collectionId)
  const keys = [...(existing?.keys ?? []).filter((k) => k.id !== signer.keyId), signer.publicKey]
  const info: CollectionInfo = {
    id: collectionId,
    owner: row.owner,
    slug: row.c.slug,
    name: row.c.name,
    keys,
  }
  if (existing && jcs(existing) === jcs(info)) return
  await writeCollectionInfo(repo, info)
}
