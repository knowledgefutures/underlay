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
import { hashSchema, jcs, MissingFilesError, v3 } from '@underlay/protocol'
import { and, eq } from 'drizzle-orm'

import { chunks, inJson, JSON_CHUNK } from '../db/chunks.js'
import * as schema from '../db/schema.js'
import type { Ports } from '../ports.js'
import { headBase } from '../push/delta.js'
import { commitOutcome, type SessionCommitResult, settleSession } from '../push/outcome.js'
import { mergeRuns, runCount } from '../push/runs.js'
import { loadInputs, schemaSetError, sessionRuns, type SessionRow } from '../push/session.js'
import { type CommitTrace, noTrace } from '../push/trace.js'
import {
  type AssetData,
  assetsOf,
  emptyCommitStats,
  headView,
  lastRow,
  metadataOf,
  rowsOfType,
  schemasOf,
  syncCatalog,
} from './catalog.js'
import { type Landed, type Landing } from './landing.js'
import { commitsOf } from './queue.js'
import { assetKey, v3SchemaError } from './rules.js'
import {
  scanConfig,
  scanFinished,
  scanInline,
  scanUnits,
  startScan,
  tightenedTypes,
} from './scans.js'
import {
  addStats,
  type BuildProgress,
  buildChecked,
  type BuiltFile,
  buildParts,
  fmt,
  partPlan,
  runRow,
  setPhase,
} from './session-build.js'

/**
 * Commit a session to its v3 collection: prepare the change here (the heavy part), then
 * land it through the collection's commit queue (the short part, one at a time).
 */
export async function commitV3Session(
  ports: Ports,
  session: SessionRow,
  trace: CommitTrace = noTrace,
): Promise<SessionCommitResult> {
  const prepared = await prepareSession(ports, session, trace)
  if ('status' in prepared) return prepared
  const landed = await trace.step('v3.land', () => commitsOf(ports).land(ports, prepared.landing))
  return settled(ports, session.collectionId, landed, prepared.written)
}

/** What a landing means for the push that prepared it. */
async function settled(
  ports: Ports,
  collectionId: string,
  landed: Landed,
  written: string[],
): Promise<SessionCommitResult> {
  if (landed.status === 'invalid') return invalid(landed.problems)
  if (landed.status === 'base_moved') {
    await syncCatalog(ports, collectionId)
    return { status: 'base_moved', current: (await headBase(ports, collectionId))?.semver ?? null }
  }
  const [version] = await ports.db
    .select()
    .from(schema.versions)
    .where(eq(schema.versions.id, landed.versionId))
  return { status: 'committed', version: version!, written }
}

/** Build a session's change against the head: its files, its counts, and what it sets. */
async function prepareSession(
  ports: Ports,
  session: SessionRow,
  trace: CommitTrace,
): Promise<SessionCommitResult | { landing: Landing; written: string[] }> {
  const store = ports.stores.v3
  const cid = session.collectionId
  // D1 catches up with the bucket first, so the base check below sees every commit.
  await trace.step('v3.sync', () => syncCatalog(ports, cid))
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
    schemaSetError(inputs.schemas) ?? v3SchemaError(collection.public, inputs.schemas)
  if (schemaErr) return { status: 'schema_refused', error: schemaErr }

  await ensureCollection(store, cid)
  const view = await headView(store, cid)
  const headCounts = (await lastRow(ports, cid))?.typeCounts ?? {}
  // The head the change is built against: the log's, which must be the D1 row's.
  const expectHead = view ? (await v3.findHead(store, cid))!.id : null
  if (expectHead !== (base?.hash ?? null)) {
    return { status: 'base_moved', current: base?.semver ?? null }
  }
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
  // --- Every row, in key order, with no-ops left out and the counts kept ---
  // A large session is built in key-range parts (session-build.ts), unless it drops a
  // type, whose removals come from the head rather than the runs.
  const plan =
    dropped.length === 0 ? await partPlan(ports, session, runs, view?.version ?? 0) : null
  const stats = emptyCommitStats()
  let files: BuiltFile[]
  let rows: number
  if (plan) {
    const parts = await trace.step('v3.parts', () =>
      buildParts(ports, session, plan, (detail, fields) => trace.progress(detail, fields, true)),
    )
    if (parts === 'waiting') return { status: 'parallel' }
    await setPhase(ports, session.id, null)
    const refs = new Set(parts.flatMap((p) => p.refs))
    const assetRows = await trace.step('v3.assets', () =>
      assetChanges(ports, session, collection.id, view, read, trace, refs),
    )
    if ('missing' in assetRows) throw new MissingFilesError(assetRows.missing)
    reserved.push(...assetRows.rows)
    reserved.sort(v3.compareKey)
    // The reserved rows sort before every publisher type: their files come first.
    const head = await trace.step('v3.build', () =>
      buildChecked(ports, session.id, view, read, reserved, stats, assetRows.sizes),
    )
    files = [...head.files, ...parts.flatMap((p) => p.files)]
    rows = head.rows
    for (const p of parts) {
      addStats(stats, p.stats)
      rows += p.rows
    }
  } else {
    const assetRows = await trace.step('v3.assets', () =>
      assetChanges(ports, session, collection.id, view, read, trace),
    )
    if ('missing' in assetRows) throw new MissingFilesError(assetRows.missing)
    reserved.push(...assetRows.rows)
    reserved.sort(v3.compareKey)
    // How far the pass has got: rows read from the runs, rows kept, and the files it has
    // finished, in the session's status and the logs every `traceConfig.progressMs`.
    // (The removals of a dropped type's records are not counted ahead.)
    const total = reserved.length + runs.reduce((n, r) => n + runCount(r), 0)
    const report = (p: BuildProgress, force = false) =>
      trace.progress(
        `${fmt(p.read)} of ${fmt(total)} rows read, ${fmt(p.rows)} changed, ${p.files} files`,
        { rows_read: p.read, rows_total: total, rows_changed: p.rows, files: p.files },
        force,
      )
    let last: BuildProgress = { read: 0, rows: 0, files: 0 }
    const built = await trace.step('v3.build', async () => {
      const out = await buildChecked(
        ports,
        session.id,
        view,
        read,
        allRows(ports, session, runs, reserved, dropped, view, read),
        stats,
        assetRows.sizes,
        (p) => {
          last = p
          return report(p)
        },
      )
      await report({ ...last, files: out.files.length }, true)
      return out
    })
    files = built.files
    rows = built.rows
  }
  if (rows === 0) return { status: 'no_changes', versionHash: base?.hash ?? '' }

  const change = await v3.makeChange(cid, {
    files: files.map(refOf),
    base: base?.hash ?? null,
    message: session.message,
  })
  // The server built these files itself from rows it checked: install them now, so the
  // landing only commits.
  await trace.step('v3.install', () =>
    v3.inParallel(
      files.map((f) => () => v3.installUpload(store, session.id, f.id)),
      16,
    ),
  )
  const records = stats.changes.added + stats.changes.removed + stats.changes.updated
  const landing: Landing = {
    collectionId: cid,
    session: session.id,
    change,
    bump: schemaChanges.size > 0 ? 'major' : records > 0 ? 'minor' : 'patch',
    expectHead,
    stats,
    schemaChanges: [...schemaChanges],
    metadata,
    pushedBy: session.userId,
    appId: session.appId,
    actorId: session.actorId,
    pushSessionId: session.id,
  }
  // Records the head carries over under a tightened schema: scanned here, or in units.
  const tight = await tightenedTypes(ports, view, inputs.schemas)
  if (view && tight.length > 0) {
    const upload = { files: files.map(refOf), session: session.id }
    const units = await scanUnits(ports, view, tight)
    const records = tight.reduce((n, t) => n + (headCounts[t.type] ?? 0), 0)
    if (records <= scanConfig.inlineRecords) {
      const problems = await trace.step('v3.scan', () => scanInline(ports, view, upload, units))
      if (problems.length > 0) return invalid(problems)
    } else {
      await ports.stores.internal.put(landingKey(session.id), JSON.stringify(landing))
      await startScan(ports, {
        id: `push-${session.id}`,
        collectionId: cid,
        version: view.version,
        upload,
        units,
        then: { kind: 'push', sessionId: session.id },
      })
      return { status: 'parallel' }
    }
  }
  return { written: files.map((f) => f.id), landing }
}

const invalid = (problems: string[]): SessionCommitResult => ({
  status: 'invalid',
  errors: problems.map((p) => ({ recordId: '', type: '', errors: [p] })),
  total: problems.length,
})

const landingKey = (sessionId: string) => `v3-scans/push-${sessionId}-landing.json`

/** A push session's scan in units passed (or not): land its change, and settle the session. */
scanFinished.push = async (ports, state, problems) => {
  if (state.then.kind !== 'push') return
  const sessionId = state.then.sessionId
  const obj = await ports.stores.internal.get(landingKey(sessionId))
  const outcome = await commitOutcome(ports, sessionId, async () => {
    if (problems.length > 0) return invalid(problems)
    if (!obj) return invalid(['The prepared change is gone; push again'])
    const landing = JSON.parse(await obj.text()) as Landing
    const landed = await commitsOf(ports).land(ports, landing)
    return settled(
      ports,
      state.collectionId,
      landed,
      landing.change.files.map((f) => f.id),
    )
  })
  await settleSession(ports, sessionId, outcome)
  await ports.stores.internal.delete(landingKey(sessionId))
}

const compare = (a: string, b: string) => v3.compareKeys(a, '', b, '')
const canonical = (v: unknown) => (v === null || v === undefined ? null : jcs(v))

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
export async function ensureCollection(store: Ports['stores']['v3'], id: string) {
  if (await v3.readDescription(store, id)) return
  try {
    await v3.createCollection(store, id)
  } catch (err) {
    // Another commit wrote it first.
    if (!(err instanceof v3.CollectionError)) throw err
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
  trace: CommitTrace = noTrace,
  /** The files the session's records reference, if known (a build in parts collects them). */
  refs?: Set<string>,
): Promise<{ rows: v3.LineRow[]; sizes: Map<string, number> } | { missing: string[] }> {
  const store = ports.stores.v3
  const inputs = await loadInputs(ports, session.id)
  const wanted = new Set(inputs.files && 'add' in inputs.files ? inputs.files.add : [])
  for (const h of refs ?? []) wanted.add(h)
  // Files the session's records reference (`r` on each run entry, read at upload).
  const recordRuns = refs ? [] : await sessionRuns(ports, session.id, 'records')
  const total = recordRuns.reduce((n, r) => n + runCount(r), 0)
  let seen = 0
  for (const ix of recordRuns) {
    for await (const e of mergeRuns(ports.stores.internal, session.id, [ix])) {
      for (const h of e.r ?? []) wanted.add(h)
      if (++seen % 4096 === 0)
        await trace.progress(`${fmt(seen)} of ${fmt(total)} rows read for files`, {
          rows_read: seen,
          rows_total: total,
        })
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

/**
 * An asset a client-built upload names, copied into the v3 area from bytes uploaded to this
 * collection through the file routes. False if none were (the upload must send them first).
 */
export async function copyAssetFromUpload(
  ports: Ports,
  collectionId: string,
  hash: string,
): Promise<boolean> {
  const [u] = await ports.db
    .select({ size: schema.files.size, storageKey: schema.files.storageKey })
    .from(schema.files)
    .innerJoin(schema.fileUploads, eq(schema.fileUploads.hash, schema.files.hash))
    .where(
      and(
        eq(schema.files.hash, hash),
        eq(schema.fileUploads.collectionId, collectionId),
        eq(schema.fileUploads.status, 'verified'),
      ),
    )
    .limit(1)
  if (!u) return false
  await copyAsset(ports, u.storageKey, hash, u.size)
  return true
}

/** Copy an uploaded file's bytes to `assets/<sha256>` in the v3 area, unless already there. */
export async function copyAsset(ports: Ports, storageKey: string, hash: string, size: number) {
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
  const store = ports.stores.v3
  for (let attempt = 0; attempt < 5; attempt++) {
    await syncCatalog(ports, collectionId)
    const head = await v3.findHead(store, collectionId)
    const view = head ? await headView(store, collectionId) : null
    if (canonical(metadata) === canonical(await metadataOf(store, view))) return null
    const row =
      metadata === null
        ? v3.removalRow(v3.META_ID, v3.META_TYPE)
        : v3.rowFromRecord(v3.META_ID, v3.META_TYPE, metadata)
    const session = v3.newSession()
    const files = await v3.buildFiles([row], v3.uploadTarget(store, session))
    await v3.installUpload(store, session, files[0]!.id)
    const landed = await commitsOf(ports).land(ports, {
      collectionId,
      session,
      bump: 'patch',
      change: await v3.makeChange(collectionId, {
        files: files.map(refOf),
        base: head?.id ?? null,
        message: 'Metadata update',
      }),
      expectHead: head?.id ?? null,
      stats: emptyCommitStats(),
      schemaChanges: [],
      metadata,
      pushedBy,
      appId: null,
      actorId: null,
      pushSessionId: null,
    })
    if (landed.status === 'base_moved') continue
    if (landed.status === 'invalid') throw new Error(landed.problems.join('; '))
    const [version] = await ports.db
      .select()
      .from(schema.versions)
      .where(eq(schema.versions.id, landed.versionId))
    return { status: 'committed', version: version! }
  }
  throw new Error(`Metadata of ${collectionId}: other commits kept landing first`)
}
