/**
 * A v3 collection's state as the server needs it, and its rows in D1.
 *
 * The log in the bucket is the truth (docs/protocol-v3.md); D1 is a catalog and cache of
 * it: one `versions` row a commit, the head pointer, `schema_usage`, and the collection's
 * history totals. `recordCommit` writes them after a commit lands, and `syncCatalog`
 * writes any the bucket has and D1 lacks (a commit whose D1 write never happened).
 *
 * Counts on a row come from the row before it plus what the commit changed (`CommitStats`),
 * so recording a commit costs what the commit wrote, not what the collection holds. Only
 * a row `syncCatalog` writes for a commit D1 lacks is counted from the files (`fullStats`).
 */
import { hashSchema, parseSemver, parseStrict, v3 } from '@underlay/protocol'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'

import * as schema from '../db/schema.js'
import type { Ports, Store } from '../ports.js'
import { summarize } from '../versions/commit.js'

const dec = new TextDecoder()

/** The data of a record line, parsed. */
export const dataOf = (line: Uint8Array): unknown =>
  (parseStrict(dec.decode(line), 1_000) as { data: unknown }).data

/** The collection's newest version, or null before its first commit. */
export async function headView(store: Store, collectionId: string): Promise<v3.View | null> {
  if ((await v3.headNumber(store, collectionId)) === 0) return null
  return v3.openView(store, collectionId)
}

/** A version of the collection, by commit number; null if there is none. */
export async function viewOf(
  store: Store,
  collectionId: string,
  number: number,
): Promise<v3.View | null> {
  if (number < 1) return null
  try {
    return await v3.openView(store, collectionId, { version: number })
  } catch (err) {
    if (err instanceof v3.VersionError) return null
    throw err
  }
}

/** Every record of one type in a version, in key order. */
export async function* rowsOfType(
  store: Store,
  view: v3.View,
  type: string,
  opts: v3.ReadOptions = {},
): AsyncGenerator<v3.RecordRead> {
  yield* v3.exportAll(store, view, { type }, { readAhead: 256 * 1024, ...opts })
}

/** A version's schemas, by type: its `$schema` rows. */
export async function schemasOf(
  store: Store,
  view: v3.View | null,
  opts: v3.ReadOptions = {},
): Promise<Record<string, Record<string, unknown>>> {
  const out: Record<string, Record<string, unknown>> = {}
  if (!view) return out
  for await (const r of rowsOfType(store, view, v3.SCHEMA_TYPE, opts)) {
    if (r.line) out[r.id] = dataOf(r.line) as Record<string, unknown>
  }
  return out
}

/** A version's metadata: its `$meta` row's data, or null. */
export async function metadataOf(
  store: Store,
  view: v3.View | null,
  opts: v3.ReadOptions = {},
): Promise<Record<string, unknown> | null> {
  if (!view) return null
  const r = await v3.getRecord(store, view, v3.META_TYPE, v3.META_ID, opts)
  return r?.line ? (dataOf(r.line) as Record<string, unknown>) : null
}

/** An asset's `$asset` data. */
export interface AssetData {
  size: number
  mediaType: string | null
}

/** A version's assets: its `$asset` rows, by SHA-256. */
export async function assetsOf(
  store: Store,
  view: v3.View | null,
  opts: v3.ReadOptions = {},
): Promise<Map<string, AssetData>> {
  const out = new Map<string, AssetData>()
  if (!view) return out
  for await (const r of rowsOfType(store, view, v3.ASSET_TYPE, opts)) {
    if (r.line) out.set(r.id, dataOf(r.line) as AssetData)
  }
  return out
}

/**
 * What a version holds, as a `versions` row counts it: records and line bytes of each
 * publisher type, and assets with their bytes. Reserved types are not records here.
 */
export interface VersionStats {
  typeCounts: Record<string, number>
  recordBytes: number
  assets: number
  assetBytes: number
}

/** What one commit changed, against the version before it. */
export interface CommitStats {
  /** Per type: records added minus removed. */
  typeDelta: Record<string, number>
  recordBytesDelta: number
  assetsDelta: number
  assetBytesDelta: number
  changes: { added: number; removed: number; updated: number }
}

export const emptyCommitStats = (): CommitStats => ({
  typeDelta: {},
  recordBytesDelta: 0,
  assetsDelta: 0,
  assetBytesDelta: 0,
  changes: { added: 0, removed: 0, updated: 0 },
})

export const emptyStats = (): VersionStats => ({
  typeCounts: {},
  recordBytes: 0,
  assets: 0,
  assetBytes: 0,
})

/** A version's stats from its files: every key entry, so O(collection). For repair only. */
export async function fullStats(store: Store, view: v3.View): Promise<VersionStats> {
  const out = emptyStats()
  for (const [type, c] of await v3.counts(store, view)) {
    if (type.startsWith('$')) continue
    out.typeCounts[type] = c.records
    out.recordBytes += c.bytes
  }
  for (const a of (await assetsOf(store, view)).values()) {
    out.assets++
    out.assetBytes += a.size
  }
  return out
}

/** The stats after a commit: those before it, plus what it changed. */
export function applyStats(before: VersionStats, c: CommitStats): VersionStats {
  const typeCounts = { ...before.typeCounts }
  for (const [t, d] of Object.entries(c.typeDelta)) {
    const n = (typeCounts[t] ?? 0) + d
    if (n > 0) typeCounts[t] = n
    else delete typeCounts[t]
  }
  return {
    typeCounts,
    recordBytes: before.recordBytes + c.recordBytesDelta,
    assets: before.assets + c.assetsDelta,
    assetBytes: before.assetBytes + c.assetBytesDelta,
  }
}

type VersionRow = typeof schema.versions.$inferSelect

/** A recorded version's stats, read back from its row (`total_bytes` is records and assets). */
export function statsOfRow(v: VersionRow): VersionStats {
  const assetBytes = v.assetBytes ?? 0
  return {
    typeCounts: v.typeCounts,
    recordBytes: v.totalBytes - assetBytes,
    assets: v.fileCount,
    assetBytes,
  }
}

export interface RecordInput {
  collectionId: string
  stored: v3.StoredCommit
  stats: VersionStats
  changes: CommitStats['changes']
  /** Types whose schema the commit set, with the schema's hash, or null where it removed it. */
  schemaChanges: Map<string, string | null>
  /** The version's metadata, for the collection's summary. */
  metadata: Record<string, unknown> | null
  pushedBy: string | null
  appId: string | null
  actorId: string | null
  pushSessionId: string | null
}

/**
 * Record a commit in D1: its `versions` row, the head (moved only forward, so rows
 * written out of order still leave it on the newest), the collection's totals, and
 * `schema_usage`. Idempotent: a row for this number already there is left as it is.
 */
export async function recordCommit(ports: Ports, r: RecordInput): Promise<VersionRow> {
  const db = ports.db
  const c = r.stored.commit
  const [existing] = await db
    .select()
    .from(schema.versions)
    .where(and(eq(schema.versions.collectionId, r.collectionId), eq(schema.versions.seq, c.number)))
    .limit(1)
  if (existing) return existing

  const [before] = await db
    .select({ semver: schema.versions.semver })
    .from(schema.versions)
    .where(
      and(eq(schema.versions.collectionId, r.collectionId), eq(schema.versions.seq, c.number - 1)),
    )
    .limit(1)
  const sv = parseSemver(c.semver)
  const id = crypto.randomUUID()
  const records = Object.values(r.stats.typeCounts).reduce((a, b) => a + b, 0)
  const total = r.stats.recordBytes + r.stats.assetBytes
  const createdAt = new Date(c.createdAt)
  const change = c.changes[0]
  const versionExists = sql`EXISTS (SELECT 1 FROM ${schema.versions} WHERE ${schema.versions.id} = ${id})`
  const headSeq = sql`(SELECT ${schema.versions.seq} FROM ${schema.versions} WHERE ${schema.versions.id} = ${schema.collections.headVersionId})`

  const statements = [
    db
      .insert(schema.versions)
      .values({
        id,
        collectionId: r.collectionId,
        seq: c.number,
        semver: sv.semver,
        major: sv.major,
        minor: sv.minor,
        patch: sv.patch,
        hash: r.stored.id,
        baseSemver: before?.semver ?? null,
        message: change?.message ?? null,
        pushedBy: r.pushedBy,
        appId: r.appId,
        actorId: r.actorId,
        signature: c.sig,
        recordCount: records,
        publicRecordCount: records,
        fileCount: r.stats.assets,
        totalBytes: total,
        publicFileCount: r.stats.assets,
        publicTotalBytes: total,
        typeCounts: r.stats.typeCounts,
        publicTypeCounts: r.stats.typeCounts,
        hasPrivate: false,
        // No reference index on v3 yet (decision 6): marked indexed so nothing waits on it.
        refsIndexed: true,
        refEvents: 0,
        refBytes: 0,
        assetBytes: r.stats.assetBytes,
        changes: r.changes,
        createdAt,
        publishedAt: new Date(),
        pushSessionId: r.pushSessionId,
      })
      .onConflictDoNothing(),
    db
      .update(schema.collections)
      .set({
        headVersionId: id,
        updatedAt: new Date(),
        summary: c.number === 1 ? undefined : summarize(r.metadata),
        lastPushAt: sql`max(coalesce(${schema.collections.lastPushAt}, 0), ${createdAt.getTime()})`,
      })
      .where(
        and(
          eq(schema.collections.id, r.collectionId),
          versionExists,
          sql`(${schema.collections.headVersionId} IS NULL OR ${headSeq} < ${c.number})`,
        ),
      ),
    db
      .update(schema.collections)
      .set({
        versionCount: sql`${schema.collections.versionCount} + 1`,
        historyBytes: sql`${schema.collections.historyBytes} + ${total}`,
      })
      .where(and(eq(schema.collections.id, r.collectionId), versionExists)),
    ...[...r.schemaChanges.values()]
      .filter((h): h is string => h !== null)
      .map((h) => db.insert(schema.schemas).values({ hash: h }).onConflictDoNothing()),
    ...[...r.schemaChanges].flatMap(([type, hash]) => [
      db
        .update(schema.schemaUsage)
        .set({ toSeq: c.number })
        .where(
          and(
            eq(schema.schemaUsage.collectionId, r.collectionId),
            eq(schema.schemaUsage.typeSlug, type),
            eq(schema.schemaUsage.set, 'public'),
            isNull(schema.schemaUsage.toSeq),
            versionExists,
          ),
        ),
      ...(hash === null
        ? []
        : [
            db
              .insert(schema.schemaUsage)
              .values({
                schemaHash: hash,
                collectionId: r.collectionId,
                typeSlug: type,
                set: 'public' as const,
                fromSeq: c.number,
              })
              .onConflictDoNothing(),
          ]),
    ]),
  ]
  // The first commit's summary: the metadata's, keeping a description given at creation.
  if (c.number === 1) {
    const [col] = await db
      .select({ summary: schema.collections.summary })
      .from(schema.collections)
      .where(eq(schema.collections.id, r.collectionId))
    const made = col?.summary ?? null
    const out = summarize(r.metadata)
    statements.push(
      db
        .update(schema.collections)
        .set({
          summary:
            made?.description && !out?.description
              ? { ...out, description: made.description }
              : out,
        })
        .where(and(eq(schema.collections.id, r.collectionId), versionExists)),
    )
  }
  await db.batch(statements as unknown as Parameters<typeof db.batch>[0])
  const [row] = await db
    .select()
    .from(schema.versions)
    .where(and(eq(schema.versions.collectionId, r.collectionId), eq(schema.versions.seq, c.number)))
    .limit(1)
  return row!
}

/** The newest `versions` row D1 has for a collection. */
export async function lastRow(ports: Ports, collectionId: string): Promise<VersionRow | null> {
  const [row] = await ports.db
    .select()
    .from(schema.versions)
    .where(eq(schema.versions.collectionId, collectionId))
    .orderBy(desc(schema.versions.seq))
    .limit(1)
  return row ?? null
}

/**
 * Write the rows of any commits the bucket has and D1 lacks: a commit whose D1 write
 * never happened (the process stopped between the two). They are counted from their
 * files, since the row before may be missing too. Returns how many it wrote.
 */
export async function syncCatalog(ports: Ports, collectionId: string): Promise<number> {
  const store = ports.stores.v3
  const head = await v3.headNumber(store, collectionId)
  const last = (await lastRow(ports, collectionId))?.seq ?? 0
  let wrote = 0
  for (let n = last + 1; n <= head; n++) {
    const stored = await v3.readCommit(store, collectionId, n)
    if (!stored) break
    const view = (await viewOf(store, collectionId, n))!
    const prevView = await viewOf(store, collectionId, n - 1)
    const now = await schemasOf(store, view)
    const was = await schemasOf(store, prevView)
    const schemaChanges = new Map<string, string | null>()
    for (const [t, s] of Object.entries(now)) {
      const h = hashSchema(s)
      if (!was[t] || hashSchema(was[t]) !== h) schemaChanges.set(t, h)
    }
    for (const t of Object.keys(was)) if (!now[t]) schemaChanges.set(t, null)
    await recordCommit(ports, {
      collectionId,
      stored,
      stats: await fullStats(store, view),
      changes: { added: 0, removed: 0, updated: 0 },
      schemaChanges,
      metadata: await metadataOf(store, view),
      pushedBy: null,
      appId: null,
      actorId: null,
      pushSessionId: null,
    })
    wrote++
  }
  return wrote
}

/** A record's data and hash at a version, or null; reserved types are not records. */
export async function recordAt(
  store: Store,
  collectionId: string,
  seq: number,
  type: string,
  id: string,
): Promise<{ data: unknown; hash: string } | null> {
  if (type.startsWith('$')) return null
  const view = await viewOf(store, collectionId, seq)
  const rec = view && (await v3.getRecord(store, view, type, id))
  return rec?.line ? { data: dataOf(rec.line), hash: rec.hash } : null
}

/** A type's schema at a version, or null. */
export async function schemaAt(
  store: Store,
  collectionId: string,
  seq: number,
  type: string,
): Promise<Record<string, unknown> | null> {
  const view = await viewOf(store, collectionId, seq)
  const rec = view && (await v3.getRecord(store, view, v3.SCHEMA_TYPE, type))
  return rec?.line ? (dataOf(rec.line) as Record<string, unknown>) : null
}
