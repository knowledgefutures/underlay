/**
 * Committing a push session to a v3 collection (v3-deploy-plan.md, Phase 1).
 *
 * The push routes keep their shape: a session takes records and deletes as NDJSON, each
 * batch checked and stored as a key-sorted run. At commit the server turns the session
 * into rows and builds sorted-record-files from them, then commits them with the library:
 *
 *   `$asset` rows   files the push declares, or its records reference, not yet in the head;
 *                   removals for files it removes
 *   `$meta`         the session's metadata, if it differs from the head's
 *   `$schema` rows  each type whose schema the session adds or changes; a removal, and a
 *                   removal of each of its records, for a type it drops
 *   records         the session's runs, merged in key order, the last upload winning
 *
 * The runs are already in key order, so nothing is sorted here. Each row is looked up in
 * the head first: one that changes nothing (the same record, or the removal of one that
 * is not there) is left out, and the rest give the counts the `versions` row needs, so
 * recording the commit costs what it changed.
 */
import {
  hashSchema,
  jcs,
  MissingFilesError,
  recordCanonical,
  sha256Hex,
  v3,
} from '@underlay/protocol'
import { and, eq } from 'drizzle-orm'

import { chunks, inJson, JSON_CHUNK } from '../db/chunks.js'
import * as schema from '../db/schema.js'
import type { Ports } from '../ports.js'
import { headBase } from '../push/delta.js'
import type { SessionCommitResult } from '../push/outcome.js'
import { mergeRuns, type RunEntry } from '../push/runs.js'
import { loadInputs, schemaSetError, sessionRuns, type SessionRow } from '../push/session.js'
import {
  type AssetData,
  applyStats,
  assetsOf,
  type CommitStats,
  emptyStats,
  headView,
  metadataOf,
  recordCommit,
  rowsOfType,
  schemasOf,
  statsOfRow,
  syncCatalog,
  lastRow,
} from './catalog.js'
import { commitQueue } from './queue.js'
import { assetKey, privateMarkError } from './rules.js'

/** Commit a session to its v3 collection. Only an open session's base is accepted. */
export async function commitV3Session(
  ports: Ports,
  session: SessionRow,
): Promise<SessionCommitResult> {
  return commitQueue.run(session.collectionId, () => commitInTurn(ports, session))
}

async function commitInTurn(ports: Ports, session: SessionRow): Promise<SessionCommitResult> {
  const store = ports.stores.v3
  const cid = session.collectionId
  // D1 catches up with the bucket first, so the base check below sees every commit.
  await syncCatalog(ports, cid)
  const base = await headBase(ports, cid)
  if ((base?.id ?? null) !== session.baseVersionId) {
    return { status: 'base_moved', current: base?.semver ?? null }
  }
  const [collection] = await ports.db
    .select()
    .from(schema.collections)
    .where(eq(schema.collections.id, cid))
  if (!collection) return { status: 'schema_refused', error: 'Collection not found' }
  const inputs = await loadInputs(ports, session.id)
  const schemaErr =
    schemaSetError(inputs.schemas) ?? privateMarkError(collection.public, inputs.schemas)
  if (schemaErr) return { status: 'schema_refused', error: schemaErr }

  await ensureCollection(store, cid)
  const view = await headView(store, cid)
  const cache = new v3.FileCache(16 * 1024 * 1024)
  const read: v3.ReadOptions = { cache, readers: new Map() }
  const baseSchemas = await schemasOf(store, view, read)
  const baseMeta = await metadataOf(store, view, read)
  const runs = await sessionRuns(ports, session.id)

  // --- The reserved rows, which sort before every publisher type ---
  const reserved: v3.LineRow[] = []
  const schemaChanges = new Map<string, string | null>()
  for (const [type, body] of Object.entries(inputs.schemas)) {
    const h = hashSchema(body)
    if (baseSchemas[type] && hashSchema(baseSchemas[type]) === h) continue
    schemaChanges.set(type, h)
    reserved.push(v3.rowFromRecord(type, v3.SCHEMA_TYPE, body))
  }
  const dropped = Object.keys(baseSchemas)
    .filter((t) => !inputs.schemas[t])
    .sort(compare)
  for (const type of dropped) {
    schemaChanges.set(type, null)
    reserved.push(v3.removalRow(type, v3.SCHEMA_TYPE))
  }
  const metadata = inputs.metadata ?? null
  if (canonical(metadata) !== canonical(baseMeta)) {
    reserved.push(
      metadata === null
        ? v3.removalRow(v3.META_ID, v3.META_TYPE)
        : v3.rowFromRecord(v3.META_ID, v3.META_TYPE, metadata),
    )
  }
  const assetRows = await assetChanges(ports, session, collection.id, view, read)
  if ('missing' in assetRows) throw new MissingFilesError(assetRows.missing)
  reserved.push(...assetRows.rows)
  reserved.sort(v3.compareKey)

  // --- Every row, in key order, with no-ops left out and the counts kept ---
  const stats: CommitStats = {
    typeDelta: {},
    recordBytesDelta: 0,
    assetsDelta: 0,
    assetBytesDelta: 0,
    changes: { added: 0, removed: 0, updated: 0 },
  }
  const assetSizes = assetRows.sizes
  let rows = 0
  const judged = async function* (): AsyncGenerator<v3.LineRow> {
    for await (const row of allRows(ports, session, runs, reserved, dropped, view, read)) {
      const before = view ? await stateOf(store, view, row, read) : null
      if (row.kind === 'x' ? before === null : before?.hash === lineHash(row)) continue
      count(stats, row, before, assetSizes)
      rows++
      yield row
    }
  }
  const files = await v3.buildFiles(judged(), v3.uploadTarget(store, session.id))
  if (rows === 0) return { status: 'no_changes', versionHash: base?.hash ?? '' }

  const change = await v3.makeChange(cid, {
    files: files.map(refOf),
    base: base?.hash ?? null,
    message: session.message,
  })
  let stored: v3.StoredCommit & { check: v3.UploadCheck }
  try {
    stored = await v3.commitUpload(
      store,
      cid,
      { change },
      {
        session: session.id,
        signer: await ports.signer(),
        cache,
        verify: false,
        validateRows: false,
      },
    )
  } catch (err) {
    if (!(err instanceof v3.UploadError)) throw err
    return {
      status: 'invalid',
      errors: err.problems.map((p) => ({ recordId: '', type: '', errors: [p] })),
      total: err.problems.length,
    }
  }
  const before = await lastRow(ports, cid)
  const version = await recordCommit(ports, {
    collectionId: cid,
    stored,
    stats: applyStats(before ? statsOfRow(before) : emptyStats(), stats),
    changes: stats.changes,
    schemaChanges,
    metadata,
    pushedBy: session.userId,
    appId: session.appId,
    actorId: session.actorId,
    pushSessionId: session.id,
  })
  await ports.jobs.enqueue({
    type: 'version.published',
    versionId: version.id,
    bump: stored.check.bump,
  })
  return { status: 'committed', version, written: files.map((f) => f.id) }
}

const compare = (a: string, b: string) => v3.compareKeys(a, '', b, '')
const enc = new TextEncoder()
const canonical = (v: unknown) => (v === null || v === undefined ? null : jcs(v))
const lineHash = (row: v3.LineRow) => sha256Hex(row.line)

/** A commit names files by what a commit needs of them (buildFiles adds more). */
const refOf = (f: v3.FileRef): v3.FileRef => ({
  id: f.id,
  first: f.first,
  last: f.last,
  entries: f.entries,
  records: f.records,
  removals: f.removals,
  bytes: f.bytes,
})

/** Write the collection's description at its first commit (its D1 row came first). */
async function ensureCollection(store: Ports['stores']['v3'], id: string) {
  if (await v3.readDescription(store, id)) return
  try {
    await v3.createCollection(store, id)
  } catch (err) {
    // Another commit wrote it first.
    if (!(err instanceof v3.CollectionError)) throw err
  }
}

/** A key's state in the head: the hash and line size of its record, or null if absent. */
async function stateOf(
  store: Ports['stores']['v3'],
  view: v3.View,
  row: { type: string; id: string },
  read: v3.ReadOptions,
): Promise<{ hash: string; size: number } | null> {
  const [newest] = await v3.history(store, view, row.type, row.id, read)
  return !newest || newest.kind === 'x' ? null : { hash: newest.hash!, size: newest.size }
}

/** Add one row's effect to the commit's counts. */
function count(
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

/**
 * Every row of the commit in key order: the reserved rows, then the session's runs merged
 * with the removals of each dropped type's records (the two never share a type: a session
 * takes records only of the types it keeps).
 */
async function* allRows(
  ports: Ports,
  session: SessionRow,
  runs: Awaited<ReturnType<typeof sessionRuns>>,
  reserved: v3.LineRow[],
  dropped: string[],
  view: v3.View | null,
  read: v3.ReadOptions,
): AsyncGenerator<v3.LineRow> {
  yield* reserved
  const store = ports.stores.v3
  const fromRuns = (async function* () {
    for await (const e of mergeRuns(ports.stores.internal, session.id, runs)) yield runRow(e)
  })()
  const removals = (async function* () {
    if (!view) return
    for (const type of dropped) {
      for await (const r of rowsOfType(store, view, type, read)) yield v3.removalRow(r.id, r.type)
    }
  })()
  for await (const [row] of v3.mergeSorted([fromRuns, removals], v3.compareKey)) yield row
}

/** A run entry as a row: a record's canonical line is the v3 record line. */
function runRow(e: RunEntry): v3.LineRow {
  if (e.x) return v3.removalRow(e.k, e.t)
  return { kind: 'r', type: e.t, id: e.k, line: e.b ?? recordCanonical(e.k, e.t, null) }
}

/**
 * The session's asset changes: a `$asset` row for each file it declares (`files.add`) or
 * its records reference that the head does not name, and a removal for each it removes
 * (`files.remove`) that the head names. A new asset must have been uploaded for this
 * collection (the same test as v2's); its bytes are copied into the v3 area, where v3
 * keeps them, so they do not depend on v2's cleanup.
 */
async function assetChanges(
  ports: Ports,
  session: SessionRow,
  collectionId: string,
  view: v3.View | null,
  read: v3.ReadOptions,
): Promise<{ rows: v3.LineRow[]; sizes: Map<string, number> } | { missing: string[] }> {
  const store = ports.stores.v3
  const inputs = await loadInputs(ports, session.id)
  const wanted = new Set(inputs.files && 'add' in inputs.files ? inputs.files.add : [])
  // Files the session's records reference (`r` on each run entry, read at upload).
  for (const ix of await sessionRuns(ports, session.id, 'records')) {
    for await (const e of mergeRuns(ports.stores.internal, session.id, [ix])) {
      for (const h of e.r ?? []) wanted.add(h)
    }
  }
  const removed = (inputs.files && 'remove' in inputs.files ? inputs.files.remove : []).filter(
    (h) => !wanted.has(h),
  )
  const held: Map<string, AssetData> = view
    ? await assetsOf(store, view, read)
    : new Map<string, AssetData>()
  const fresh = [...wanted].filter((h) => !held.has(h))
  const rows: v3.LineRow[] = []
  const sizes = new Map<string, number>()
  const missing: string[] = []
  if (fresh.length > 0) {
    const byHash = new Map<
      string,
      { hash: string; size: number; mimeType: string; storageKey: string }
    >()
    for (const part of chunks(fresh, JSON_CHUNK)) {
      const uploaded = await ports.db
        .select({
          hash: schema.files.hash,
          size: schema.files.size,
          mimeType: schema.files.mimeType,
          storageKey: schema.files.storageKey,
        })
        .from(schema.files)
        .innerJoin(schema.fileUploads, eq(schema.fileUploads.hash, schema.files.hash))
        .where(
          and(
            eq(schema.fileUploads.collectionId, collectionId),
            eq(schema.fileUploads.status, 'verified'),
            inJson(schema.files.hash, part),
          ),
        )
      for (const u of uploaded) byHash.set(u.hash, u)
    }
    for (const h of fresh) {
      const u = byHash.get(h)
      if (!u) {
        missing.push(h)
        continue
      }
      await copyAsset(ports, u.storageKey, h, u.size)
      sizes.set(h, u.size)
      rows.push(v3.rowFromRecord(h, v3.ASSET_TYPE, { size: u.size, mediaType: u.mimeType }))
    }
  }
  if (missing.length > 0) return { missing: missing.sort() }
  for (const h of removed) {
    const a = held.get(h)
    if (!a) continue
    sizes.set(h, a.size)
    rows.push(v3.removalRow(h, v3.ASSET_TYPE))
  }
  return { rows, sizes }
}

/** Copy an uploaded file's bytes to `assets/<sha256>` in the v3 area, unless already there. */
async function copyAsset(ports: Ports, storageKey: string, hash: string, size: number) {
  const store = ports.stores.v3
  if (await store.head(assetKey(hash))) return
  const files = ports.stores.fileBytes
  const to = ports.stores.v3BucketKey(assetKey(hash))
  if (files.copy) {
    await files.copy(storageKey, to, size)
    return
  }
  const obj = await files.get(storageKey)
  if (!obj) throw new Error(`File ${hash} is recorded but its bytes are missing`)
  await store.put(assetKey(hash), await obj.bytes())
}

/**
 * A commit that changes only the collection's metadata (the metadata edit in the web app):
 * one `$meta` row, or its removal. Returns null when the metadata is already that.
 */
export async function commitV3Metadata(
  ports: Ports,
  collectionId: string,
  metadata: Record<string, unknown> | null,
  pushedBy: string | null,
): Promise<{ status: 'committed'; version: typeof schema.versions.$inferSelect } | null> {
  return commitQueue.run(collectionId, async () => {
    const store = ports.stores.v3
    await syncCatalog(ports, collectionId)
    const view = await headView(store, collectionId)
    if (canonical(metadata) === canonical(await metadataOf(store, view))) return null
    const row =
      metadata === null
        ? v3.removalRow(v3.META_ID, v3.META_TYPE)
        : v3.rowFromRecord(v3.META_ID, v3.META_TYPE, metadata)
    const session = v3.newSession()
    const files = await v3.buildFiles([row], v3.uploadTarget(store, session))
    const base = await headBase(ports, collectionId)
    const change = await v3.makeChange(collectionId, {
      files: files.map(refOf),
      base: base?.hash ?? null,
      message: 'Metadata update',
    })
    const stored = await v3.commitUpload(
      store,
      collectionId,
      { change },
      { session, signer: await ports.signer(), verify: false, validateRows: false },
    )
    const before = await lastRow(ports, collectionId)
    const version = await recordCommit(ports, {
      collectionId,
      stored,
      stats: before ? statsOfRow(before) : emptyStats(),
      changes: { added: 0, removed: 0, updated: 0 },
      schemaChanges: new Map(),
      metadata,
      pushedBy,
      appId: null,
      actorId: null,
      pushSessionId: null,
    })
    await ports.jobs.enqueue({ type: 'version.published', versionId: version.id, bump: 'patch' })
    return { status: 'committed' as const, version }
  })
}
