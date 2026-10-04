/**
 * Bucket mirrors (edge-redesign.md, "Placements": Sync). A mirror placement is a
 * complete repository of a collection in a customer location, kept current by
 * jobs; it never blocks a commit.
 *
 *   mirror.version   copy the next version a placement lacks, then queue the
 *                    one after; one job per (placement, step)
 *
 * A version's copy is exactly its sync work (`versionWork`): the objects it
 * reaches that the previous version doesn't, then the file bytes it added, the
 * private set object (public+private placements only), the root, then
 * collection.json, the signed log entry and head.json, in the repository's
 * write order. Backfill is the same loop from version 1. A copy stops after a
 * budget and resumes from a cursor (the tree and last key done), so no single
 * job copies more than a few thousand objects. Copies are tracked in the
 * placement row, never found by HEAD requests: a write-only mirror can't read.
 * Deletes don't propagate.
 */
import {
  diffTrees,
  entryHash,
  type FileEntry,
  fileTree,
  jcs,
  keys,
  type LogEntry,
  putFromParts,
  readCollectionInfo,
  readParts,
  RepoSource,
  type Store,
  type SyncSets,
  treeObjects,
  versionWork,
} from '@underlay/protocol'
import { and, asc, eq, isNull, lt, ne, or } from 'drizzle-orm'

import * as schema from '../db/schema.js'
import { registerJob } from '../jobs.js'
import type { Ports } from '../ports.js'
import { locationStore } from './locations.js'

const LEASE_MS = 15 * 60 * 1000

export const mirrorConfig = {
  /** Objects one job copies before it saves a cursor and queues the rest. */
  objectsPerJob: 2000,
  /** File bytes one job copies (at least one file). */
  fileBytesPerJob: 256 * 1024 * 1024,
  /** Files are read and written in parts of this size (S3 joins parts under 5 MiB). */
  partBytes: 8 * 1024 * 1024,
}

type Placement = typeof schema.placements.$inferSelect

/**
 * The org's default mirror placements, made concrete for one collection: a
 * collection row per org default it doesn't override, so each collection has
 * its own progress. Returns the collection's mirror placements.
 */
export async function collectionMirrors(ports: Ports, collectionId: string): Promise<Placement[]> {
  const { db } = ports
  const [col] = await db
    .select({ organizationId: schema.collections.organizationId })
    .from(schema.collections)
    .where(eq(schema.collections.id, collectionId))
  if (!col) return []
  const defaults = await db
    .select()
    .from(schema.placements)
    .where(
      and(
        eq(schema.placements.organizationId, col.organizationId),
        isNull(schema.placements.collectionId),
        eq(schema.placements.role, 'mirror'),
      ),
    )
  for (const d of defaults) {
    await db
      .insert(schema.placements)
      .values({
        collectionId,
        locationId: d.locationId,
        role: 'mirror',
        sets: d.sets,
        state: 'backfilling',
      })
      .onConflictDoNothing()
  }
  return db
    .select()
    .from(schema.placements)
    .where(
      and(eq(schema.placements.collectionId, collectionId), eq(schema.placements.role, 'mirror')),
    )
}

/** Queue the next copy for every mirror of a collection (after a publish, or to catch up). */
export async function queueMirrors(ports: Ports, collectionId: string): Promise<void> {
  const mirrors = (await collectionMirrors(ports, collectionId)).filter((p) => p.state !== 'paused')
  if (mirrors.length === 0) return
  await ports.jobs.enqueueBatch(mirrors.map((p) => ({ type: 'mirror.version', placementId: p.id })))
}

async function copyFileBytes(ports: Ports, dest: Store, hash: string, size: number): Promise<void> {
  const [row] = await ports.db
    .select()
    .from(schema.files)
    .where(eq(schema.files.hash, hash))
    .limit(1)
  if (!row) throw new Error(`File ${hash} is referenced but not stored`)
  // Ranged reads into a multipart write: at most a part (or S3's 5 MiB minimum)
  // of the file is held at once.
  await putFromParts(
    dest,
    keys.file(hash),
    readParts(ports.stores.fileBytes, row.storageKey, size, mirrorConfig.partBytes),
    { contentType: row.mimeType },
  )
}

/**
 * Copy (part of) the next version a placement lacks. Returns true when there is
 * more to do (a job has been queued for it).
 */
export async function mirrorStep(ports: Ports, placementId: string): Promise<boolean> {
  const { db } = ports
  const [p] = await db.select().from(schema.placements).where(eq(schema.placements.id, placementId))
  if (!p || p.role !== 'mirror' || !p.collectionId || p.state === 'paused') return false
  const collectionId = p.collectionId
  const [head] = await db
    .select({ seq: schema.versions.seq })
    .from(schema.collections)
    .innerJoin(schema.versions, eq(schema.versions.id, schema.collections.headVersionId))
    .where(eq(schema.collections.id, collectionId))
  if (!head || p.syncedSeq >= head.seq) {
    if (p.state !== 'active') {
      await db
        .update(schema.placements)
        .set({ state: 'active', lastError: null, updatedAt: new Date() })
        .where(eq(schema.placements.id, p.id))
    }
    return false
  }
  const seq = p.syncedSeq + 1
  const versions = await db
    .select()
    .from(schema.versions)
    .where(
      and(
        eq(schema.versions.collectionId, collectionId),
        or(eq(schema.versions.seq, seq), eq(schema.versions.seq, seq - 1)),
      ),
    )
    .orderBy(asc(schema.versions.seq))
  const version = versions.find((v) => v.seq === seq)
  const prev = versions.find((v) => v.seq === seq - 1) ?? null
  if (!version) throw new Error(`Collection ${collectionId} has no version ${seq}`)

  const [loc] = await db
    .select()
    .from(schema.storageLocations)
    .where(eq(schema.storageLocations.id, p.locationId))
  if (!loc || loc.status === 'disabled') return false

  // One copy at a time: a job queued while another holds the lease leaves it be
  // (the holder re-checks the head when it finishes).
  const started = Date.now()
  const claimed = await db
    .update(schema.placements)
    .set({ leaseUntil: new Date(started + LEASE_MS) })
    .where(
      and(
        eq(schema.placements.id, p.id),
        eq(schema.placements.syncedSeq, p.syncedSeq),
        or(
          isNull(schema.placements.leaseUntil),
          lt(schema.placements.leaseUntil, new Date(started)),
        ),
      ),
    )
    .returning({ cursor: schema.placements.cursor })
  if (claimed.length === 0) return false
  // The cursor as of the claim: another job may have moved it since the first read.
  const saved = claimed[0]!.cursor

  try {
    const repo = await ports.stores.forCollection(collectionId)
    const dest = await locationStore(ports, loc)
    const sets: SyncSets = p.sets === 'public+private' ? 'all' : 'public'
    const work = await versionWork(repo, version.hash, { base: prev?.hash ?? null, sets })
    const cursor = saved?.seq === seq ? saved : { seq, tree: -1, after: null }
    const raw = async (key: string) => {
      const obj = await repo.blobs.get(key)
      if (!obj) throw new Error(`Missing object ${key}`)
      return obj.bytes()
    }
    const save = async (tree: number, after: string | null) => {
      await db
        .update(schema.placements)
        .set({
          cursor: { seq, tree, after },
          state: 'backfilling',
          lastError: null,
          leaseUntil: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.placements.id, p.id))
      await ports.jobs.enqueue({ type: 'mirror.version', placementId: p.id })
      return true
    }
    let copied = 0

    if (cursor.tree === -1) {
      for (const key of work.schemas)
        await dest.put(key, await raw(key), { contentType: 'application/json' })
      cursor.tree = 0
    }
    for (let t = cursor.tree; t < work.trees.length; t++) {
      const after = t === cursor.tree ? cursor.after : null
      for await (const o of treeObjects(repo, work.trees[t]!, after)) {
        await dest.put(o.key, o.bytes)
        copied++
        if (o.resumeKey && copied >= mirrorConfig.objectsPerJob) return save(t, o.resumeKey)
      }
    }

    // File bytes the version added to the sets this placement holds.
    const filesStep = work.trees.length
    if (cursor.tree <= filesStep) {
      const source = new RepoSource(fileTree, repo)
      const added: FileEntry[] = []
      for (const tree of work.trees.filter((x) => x.kind === 'files')) {
        for await (const d of diffTrees(source, tree.base, tree.target))
          if (d.after) added.push(d.after)
      }
      added.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      const from = cursor.tree === filesStep ? cursor.after : null
      let bytes = 0
      for (const f of added) {
        if (from !== null && f.key <= from) continue
        await copyFileBytes(ports, dest, f.key, f.size)
        bytes += f.size
        if (bytes >= mirrorConfig.fileBytesPerJob) return save(filesStep, f.key)
      }
    }

    // The version itself, then its log entry and the head, last.
    if (work.privateSet)
      await dest.put(work.privateSet, await raw(work.privateSet), {
        contentType: 'application/json',
      })
    await dest.put(work.rootKey, await raw(work.rootKey), { contentType: 'application/json' })
    const info = await readCollectionInfo(repo, collectionId)
    if (info)
      await dest.put(keys.collection(collectionId), JSON.stringify(info, null, 1), {
        contentType: 'application/json',
      })
    const entryKey = keys.logEntry(collectionId, seq)
    const entry = await repo.blobs.get(entryKey)
    if (!entry) throw new Error(`Version ${seq} has no log entry yet`)
    const entryBytes = await entry.bytes()
    await dest.put(entryKey, entryBytes, { contentType: 'application/json' })
    // The mirror's head names the version just copied, never one it lacks.
    const logEntry = JSON.parse(new TextDecoder().decode(entryBytes)) as LogEntry
    await dest.put(
      keys.head(collectionId),
      jcs({ entryHash: entryHash(logEntry), seq, versionHash: version.hash }),
      { contentType: 'application/json' },
    )

    // A version published while this ran counts too.
    const [latest] = await db
      .select({ seq: schema.versions.seq })
      .from(schema.collections)
      .innerJoin(schema.versions, eq(schema.versions.id, schema.collections.headVersionId))
      .where(eq(schema.collections.id, collectionId))
    const more = seq < (latest?.seq ?? head.seq)
    await db
      .update(schema.placements)
      .set({
        syncedSeq: seq,
        cursor: null,
        state: more ? 'backfilling' : 'active',
        lastError: null,
        leaseUntil: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.placements.id, p.id))
    if (more) await ports.jobs.enqueue({ type: 'mirror.version', placementId: p.id })
    return more
  } catch (err) {
    await db
      .update(schema.placements)
      .set({
        state: 'error',
        lastError: (err as Error).message.slice(0, 500),
        leaseUntil: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.placements.id, p.id))
    throw err
  }
}

/** Placements behind their collection's head and not already being worked: for the sweep. */
export async function laggingPlacements(ports: Ports): Promise<string[]> {
  const rows = await ports.db
    .select({
      id: schema.placements.id,
      synced: schema.placements.syncedSeq,
      head: schema.versions.seq,
    })
    .from(schema.placements)
    .innerJoin(schema.collections, eq(schema.collections.id, schema.placements.collectionId))
    .innerJoin(schema.versions, eq(schema.versions.id, schema.collections.headVersionId))
    .where(
      and(
        eq(schema.placements.role, 'mirror'),
        ne(schema.placements.state, 'paused'),
        lt(schema.placements.syncedSeq, schema.versions.seq),
      ),
    )
  return rows.map((r) => r.id)
}

registerJob('mirror.version', async (job, ports) => {
  await mirrorStep(ports, String(job.placementId))
})
