/**
 * Restore (edge-redesign.md, "Restore and fallback"): rebuild a collection on
 * this instance from a repository in a storage location, typically a mirror.
 * This is what makes the backup claim true.
 *
 *   restore.version   restore the next version; one per job, oldest first
 *
 * Nothing in the location is trusted:
 * - each log entry must chain to the last and be signed by a trusted key: this
 *   deployment's own, or a key the caller named;
 * - each version moves as a pack read from the location (an untrusted
 *   repository, so bodies are checked as they're read) and is received with
 *   receiveVersion, which re-derives every tree before accepting it;
 * - file bytes must hash to their names.
 *
 * Versions keep their semver, time and message, and the signed entries are
 * copied verbatim, so the restored log verifies against the original keys and
 * new versions continue its hash chain. After the last version the file
 * reference counts are rebuilt, so the collection takes new commits.
 */
import {
  appendLog,
  type CollectionInfo,
  diffTrees,
  emptySet,
  type FileEntry,
  fileTree,
  keys,
  type LogEntry,
  openRepo,
  packVersion,
  readCollectionInfo,
  readHead,
  readLogEntry,
  rebuildFileRefs,
  receiveVersion,
  type Repo,
  RepoSource,
  setRecordTotals,
  sha256Hex,
  type SyncSets,
  type VersionRoot,
  verifyLogEntries,
  writeCollectionInfo,
} from '@underlay/protocol'
import { eq } from 'drizzle-orm'

import * as schema from '../db/schema.js'
import { registerJob } from '../jobs.js'
import type { Ports } from '../ports.js'
import { mergeCumulativeFiles, summarize } from '../versions/commit.js'
import { publishVersion, type SchemaUsageChange } from '../versions/publish.js'
import { parseSemver } from '../versions/semver.js'
import { locationStore, type LocationRow } from './locations.js'

type RestoreRow = typeof schema.restores.$inferSelect

export class RestoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RestoreError'
  }
}

/** The location as an untrusted repository. */
async function sourceRepo(ports: Ports, loc: LocationRow): Promise<Repo> {
  if (loc.permissions !== 'read_write') {
    throw new RestoreError('Restoring needs a location with read access (read_write)')
  }
  return openRepo(await locationStore(ports, loc))
}

/**
 * What a restore will read: the collection's info and head in the location, and
 * whether it holds the private sets. Throws when there's nothing to restore.
 */
export async function inspectSource(
  ports: Ports,
  loc: LocationRow,
  sourceCollectionId: string,
): Promise<{ info: CollectionInfo; head: { seq: number }; sets: SyncSets }> {
  const repo = await sourceRepo(ports, loc)
  const [info, head] = await Promise.all([
    readCollectionInfo(repo, sourceCollectionId),
    readHead(repo, sourceCollectionId),
  ])
  if (!info || !head) throw new RestoreError(`The location has no collection ${sourceCollectionId}`)
  const root = await repo.root(head.versionHash)
  const sets: SyncSets =
    root.private && (await repo.blobs.head(keys.privateSet(root.private))) ? 'all' : 'public'
  return { info, head, sets }
}

async function copyFiles(
  ports: Ports,
  source: Repo,
  target: Repo,
  prevRoot: VersionRoot | null,
  root: VersionRoot,
  sets: SyncSets,
): Promise<string[]> {
  const pairs: [string | null, string | null][] = [
    [prevRoot?.public.files.root ?? null, root.public.files.root],
  ]
  if (sets === 'all') {
    const prevPriv = prevRoot?.private ? await target.privateSet(prevRoot.private) : null
    const priv = root.private ? await target.privateSet(root.private) : null
    pairs.push([prevPriv?.files.root ?? null, priv?.files.root ?? null])
  }
  const added = new Map<string, FileEntry>()
  const src = new RepoSource(fileTree, target)
  for (const [a, b] of pairs) {
    for await (const d of diffTrees(src, a, b)) if (d.after) added.set(d.key, d.after)
  }
  const publicAdded: string[] = []
  const pubBefore = new Set<string>()
  for await (const d of diffTrees(
    src,
    prevRoot?.public.files.root ?? null,
    root.public.files.root,
  )) {
    if (d.after) publicAdded.push(d.key)
    else pubBefore.add(d.key)
  }
  for (const f of added.values()) {
    const [have] = await ports.db
      .select({ hash: schema.files.hash })
      .from(schema.files)
      .where(eq(schema.files.hash, f.key))
      .limit(1)
    if (have) continue
    const obj = await source.blobs.get(keys.file(f.key))
    if (!obj) throw new RestoreError(`File ${f.key} is missing from the location`)
    const bytes = await obj.bytes()
    if (bytes.byteLength !== f.size || sha256Hex(bytes) !== f.key) {
      throw new RestoreError(`File ${f.key} in the location fails its hash or size`)
    }
    const storageKey = ports.stores.canonicalFileKey(f.key)
    await ports.stores.fileBytes.put(storageKey, bytes, { ifAbsent: true })
    await ports.db
      .insert(schema.files)
      .values({
        hash: f.key,
        size: f.size,
        mimeType: obj.contentType ?? 'application/octet-stream',
        storageKey,
        verifiedAt: new Date(),
      })
      .onConflictDoNothing()
  }
  return publicAdded
}

/** Restore the next version. Returns true when more remain (and are queued). */
export async function restoreStep(ports: Ports, restoreId: string): Promise<boolean> {
  const { db } = ports
  const [r] = await db.select().from(schema.restores).where(eq(schema.restores.id, restoreId))
  if (!r || r.status !== 'running') return false
  try {
    return await step(ports, r)
  } catch (err) {
    await db
      .update(schema.restores)
      .set({ status: 'failed', error: (err as Error).message.slice(0, 500), updatedAt: new Date() })
      .where(eq(schema.restores.id, r.id))
    if (err instanceof RestoreError || (err as Error).name === 'IntegrityError') return false
    throw err
  }
}

async function step(ports: Ports, r: RestoreRow): Promise<boolean> {
  const { db } = ports
  const [loc] = await db
    .select()
    .from(schema.storageLocations)
    .where(eq(schema.storageLocations.id, r.locationId))
  if (!loc) throw new RestoreError('The location is gone')
  const source = await sourceRepo(ports, loc)
  const sid = r.sourceCollectionId
  const [info, head] = await Promise.all([readCollectionInfo(source, sid), readHead(source, sid)])
  if (!info || !head) throw new RestoreError(`The location has no collection ${sid}`)
  // Nothing the location says about keys is trusted: this deployment's key is
  // taken from its own signer, and a named key must hash to its id (verifyEntry).
  const own = (await ports.signer()).publicKey
  const named = info.keys.filter((k) => k.id !== own.id && r.trustKeyIds.includes(k.id))
  const trusted = [own, ...named]
  if (!info.keys.some((k) => k.id === own.id) && named.length === 0) {
    throw new RestoreError(
      `No trusted key signs this log (its keys: ${info.keys.map((k) => k.id).join(', ')}); name one in trustKeyIds`,
    )
  }
  const seq = r.restoredSeq + 1
  const entry: LogEntry | null = await readLogEntry(source, sid, seq)
  if (!entry) throw new RestoreError(`Log entry ${seq} is missing from the location`)
  const verified = await verifyLogEntries(
    [entry],
    trusted,
    r.lastEntryHash ? { seq: r.restoredSeq, entryHash: r.lastEntryHash } : null,
  )

  const target = await ports.stores.forCollection(r.collectionId)
  const base = r.lastVersionHash
  const sets = r.sets as SyncSets
  const got = await receiveVersion(target, packVersion(source, entry.versionHash, { base, sets }), {
    target: entry.versionHash,
    base,
    sets,
  })
  const root = got.root
  const prevRoot = base ? await target.root(base) : null
  const priv = sets === 'all' && root.private ? await target.privateSet(root.private) : null
  if (seq === 1 && priv) {
    // Later commits must reproduce this collection's private commitments.
    await db
      .update(schema.collections)
      .set({ privateSalt: priv.salt })
      .where(eq(schema.collections.id, r.collectionId))
  }
  const publicAdded = await copyFiles(ports, source, target, prevRoot, root, sets)

  // Publish with the version's original identity.
  const pubTotals = setRecordTotals(root.public)
  const privTotals = setRecordTotals(priv ?? emptySet())
  const typeCounts: Record<string, number> = {}
  const publicTypeCounts: Record<string, number> = {}
  for (const [slug, t] of Object.entries(root.public.types)) {
    typeCounts[slug] = (typeCounts[slug] ?? 0) + t.count
    publicTypeCounts[slug] = t.count
  }
  for (const [slug, t] of Object.entries(priv?.types ?? {}))
    typeCounts[slug] = (typeCounts[slug] ?? 0) + t.count
  const prevPriv =
    sets === 'all' && prevRoot?.private ? await target.privateSet(prevRoot.private) : null
  const usage: SchemaUsageChange[] = []
  for (const [set, before, after] of [
    ['public', prevRoot?.public ?? null, root.public],
    ['private', prevPriv, priv],
  ] as const) {
    const slugs = new Set([...Object.keys(before?.types ?? {}), ...Object.keys(after?.types ?? {})])
    for (const slug of slugs) {
      const was = before?.types[slug]?.schema ?? null
      const now = after?.types[slug]?.schema ?? null
      if (was !== now) usage.push({ set, typeSlug: slug, schemaHash: now, wasOpen: was !== null })
    }
  }
  const [collection] = await db
    .select()
    .from(schema.collections)
    .where(eq(schema.collections.id, r.collectionId))
  const [prevRow] = base
    ? await db.select().from(schema.versions).where(eq(schema.versions.hash, base)).limit(1)
    : []
  const publicFilesRoot = await mergeCumulativeFiles(
    ports,
    target,
    collection!.publicFilesRoot,
    publicAdded,
  )
  const sv = parseSemver(entry.semver)
  const id = crypto.randomUUID()
  const fileCount = root.public.files.count + (priv?.files.count ?? 0)
  const published = await publishVersion(db, {
    version: {
      id,
      collectionId: r.collectionId,
      seq,
      semver: sv.semver,
      major: sv.major,
      minor: sv.minor,
      patch: sv.patch,
      hash: entry.versionHash,
      baseSemver: entry.baseSemver,
      message: entry.message,
      pushedBy: null,
      appId: entry.appId,
      actorId: entry.actorId,
      recordCount: pubTotals.count + privTotals.count,
      publicRecordCount: pubTotals.count,
      fileCount,
      totalBytes:
        pubTotals.bytes + privTotals.bytes + root.public.files.bytes + (priv?.files.bytes ?? 0),
      publicFileCount: root.public.files.count,
      publicTotalBytes: pubTotals.bytes + root.public.files.bytes,
      typeCounts,
      publicTypeCounts,
      hasPrivate: root.private !== null,
      publicRefsRoot: null,
      privateRefsRoot: null,
      changes: got.changes,
      createdAt: new Date(entry.createdAt),
    },
    baseVersionId: prevRow?.id ?? null,
    collectionUpdate: { publicFilesRoot, summary: summarize(root.metadata) },
    schemaHashes: [
      ...new Set(
        [...Object.values(root.public.types), ...Object.values(priv?.types ?? {})].map(
          (t) => t.schema,
        ),
      ),
    ],
    usage,
  })
  if (!published.ok) throw new RestoreError('The collection changed while it was being restored')

  // The signed entry, verbatim, under this collection; its keys come along.
  // Only the keys this restore trusted are published with it.
  if (seq === 1) await writeCollectionInfo(target, { ...info, id: r.collectionId, keys: trusted })
  await appendLog(target, r.collectionId, entry)
  await ports.jobs.enqueue({ type: 'refs.index', versionId: id })

  const last = seq >= head.seq
  if (last) {
    // New commits build on the head: give it its file reference counts.
    const refs = await rebuildFileRefs(target, { public: root.public, private: priv ?? emptySet() })
    await db
      .update(schema.versions)
      .set({ publicRefsRoot: refs.public, privateRefsRoot: refs.private })
      .where(eq(schema.versions.id, id))
  }
  await db
    .update(schema.restores)
    .set({
      restoredSeq: seq,
      lastEntryHash: verified!.entryHash,
      lastVersionHash: entry.versionHash,
      status: last ? 'done' : 'running',
      updatedAt: new Date(),
    })
    .where(eq(schema.restores.id, r.id))
  if (!last) await ports.jobs.enqueue({ type: 'restore.version', restoreId: r.id })
  return !last
}

registerJob('restore.version', async (job, ports) => {
  await restoreStep(ports, String(job.restoreId))
})
