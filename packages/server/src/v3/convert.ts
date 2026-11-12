/**
 * Converting a v2 collection to v3 (v3-deploy-plan.md, Phase 4).
 *
 * A job a version, in order: read what the version changed from v2 (the first whole, the
 * rest by v2's diff against the one before), write it as rows (records and removals,
 * `$schema`, `$meta`, `$asset`), build files, and commit them with the version's time,
 * message, and base. The semver v3 derives must be the one v2 recorded. Then the version
 * is checked against v2: per type, the count and a digest of every (type, id, record hash);
 * the schemas; the assets with their sizes; the metadata. Anything that differs stops the
 * conversion with the reason. Only the v3 area is written (asset bytes are copied into it);
 * nothing of v2's changes.
 *
 * Once every version is converted, and with `flip`, one D1 batch flips the collection:
 * `record_layout` to `v3` only if its head is still the last version converted and no push
 * session is open, and then each version row takes its v3 id, keeping the v2 id as the
 * alias (decision 2). Until then the collection stays live on v2, and a version that
 * arrives meanwhile is converted on the next pass. A collection with a private record or
 * type in any version becomes private (decision 1), and only once a steward has said its
 * owner was told (`allowPrivate`). The way back puts every row as it was, while no v3
 * commit follows.
 */
import {
  type BumpType,
  compareUtf8,
  fileTree,
  hashSchema,
  iterate,
  jcs,
  parseSemver,
  RepoSource,
  sha256Hex,
  v3,
} from '@underlay/protocol'
import { and, asc, eq, lt, or, sql } from 'drizzle-orm'

import { diffAll, type TypedDiff } from '../api/versions.js'
import { chunks, inJson, JSON_CHUNK } from '../db/chunks.js'
import * as schema from '../db/schema.js'
import { registerJob } from '../jobs.js'
import type { Ports } from '../ports.js'
import { loadView, recordBodies, typeRecords, type VersionView } from '../versions/view.js'
import { assetsOf, metadataOf, schemasOf, viewOf } from './catalog.js'
import { copyAsset, ensureCollection } from './commit.js'

type VersionRow = typeof schema.versions.$inferSelect
type CollectionRow = typeof schema.collections.$inferSelect
type ConversionRow = typeof schema.v3Conversions.$inferSelect
type Converted = schema.ConvertedVersion

export const convertConfig = {
  /** Records whose bodies are read at once. */
  bodyBatch: 512,
  /** A conversion not moved for this long is queued again by the cron. */
  staleMs: 15 * 60 * 1000,
  /** Conversions the cron queues at once. */
  perCron: 20,
}

/** A conversion that cannot go on: it stops, with this as the reason. */
export class ConvertError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConvertError'
  }
}

const PAST_RESERVED: v3.Key = { type: '$\u{10FFFF}', id: '' }
const canonical = (v: unknown) => (v === null || v === undefined ? null : jcs(v))
const MOD = 1n << 256n
const entryDigest = (type: string, id: string, hash: string) =>
  BigInt(`0x${sha256Hex(`${type}\u0000${id}\u0000${hash}`)}`)

function bumpBetween(previous: string | null, next: string): BumpType {
  if (previous === null) return 'major'
  const a = parseSemver(previous)
  const b = parseSemver(next)
  return b.major !== a.major ? 'major' : b.minor !== a.minor ? 'minor' : 'patch'
}

/** A version's files, both sets: hash → size. Private files are ordinary assets on v3. */
async function filesOf(view: VersionView): Promise<Map<string, number>> {
  const source = new RepoSource(fileTree, view.repo)
  const out = new Map<string, number>()
  for (const root of [view.public.files.root, view.private?.files.root ?? null]) {
    for await (const f of iterate(source, root)) out.set(f.key, f.size)
  }
  return out
}

/** Whether a version has a private record or a private type (decision 1). */
const hasPrivate = (view: VersionView) =>
  view.types.some((t) => t.privateType || (t.private?.count ?? 0) > 0)

/** The rows a version adds to the one before it, in key order. */
async function* versionRows(
  ports: Ports,
  prev: VersionView | null,
  now: VersionView,
): AsyncGenerator<v3.LineRow> {
  // `$asset`: files added (their bytes copied into the v3 area) and removed.
  const nowFiles = await filesOf(now)
  const prevFiles = prev ? await filesOf(prev) : new Map<string, number>()
  const added = [...nowFiles.keys()].filter((h) => !prevFiles.has(h))
  const stored = new Map<string, { size: number; mimeType: string; storageKey: string }>()
  for (const part of chunks(added, JSON_CHUNK)) {
    const rows = await ports.db
      .select({
        hash: schema.files.hash,
        size: schema.files.size,
        mimeType: schema.files.mimeType,
        storageKey: schema.files.storageKey,
      })
      .from(schema.files)
      .where(inJson(schema.files.hash, part))
    for (const r of rows) stored.set(r.hash, r)
  }
  const assets: v3.LineRow[] = []
  for (const h of added) {
    const f = stored.get(h)
    if (!f) throw new ConvertError(`File ${h} of ${now.version.semver} has no row in files`)
    await copyAsset(ports, f.storageKey, h, f.size)
    assets.push(v3.rowFromRecord(h, v3.ASSET_TYPE, { size: f.size, mediaType: f.mimeType }))
  }
  for (const h of prevFiles.keys())
    if (!nowFiles.has(h)) assets.push(v3.removalRow(h, v3.ASSET_TYPE))
  yield* assets.sort((a, b) => compareUtf8(a.id, b.id))

  // `$meta`.
  const meta = now.root.metadata ?? null
  if (canonical(meta) !== canonical(prev?.root.metadata ?? null)) {
    yield meta === null
      ? v3.removalRow(v3.META_ID, v3.META_TYPE)
      : v3.rowFromRecord(v3.META_ID, v3.META_TYPE, meta)
  }

  // `$schema`: a type's schema when it is new or changed; a removal when the type is gone.
  const schemaRows: v3.LineRow[] = []
  for (const t of now.types) {
    if (prev?.types.find((p) => p.slug === t.slug)?.schemaHash === t.schemaHash) continue
    schemaRows.push(v3.rowFromRecord(t.slug, v3.SCHEMA_TYPE, await now.repo.schema(t.schemaHash)))
  }
  for (const t of prev?.types ?? []) {
    if (!now.types.some((n) => n.slug === t.slug))
      schemaRows.push(v3.removalRow(t.slug, v3.SCHEMA_TYPE))
  }
  yield* schemaRows.sort((a, b) => compareUtf8(a.id, b.id))

  // Records, by v2's diff over both sets: a record that only moved between sets is no change.
  let batch: TypedDiff[] = []
  const flush = async function* (): AsyncGenerator<v3.LineRow> {
    const bodies = await recordBodies(
      now,
      batch.filter((d) => d.after).map((d) => ({ type: d.type, key: d.key, set: d.afterSet })),
    )
    for (const d of batch) {
      if (!d.after) {
        yield v3.removalRow(d.key, d.type)
        continue
      }
      const body = bodies.get(`${d.type}\u0000${d.key}`)
      if (body === undefined) throw new ConvertError(`${d.type}/${d.key} has no body in v2`)
      const row = v3.rowFromRecord(d.key, d.type, (JSON.parse(body) as { data: unknown }).data)
      if (sha256Hex(row.line) !== d.after.hash)
        throw new ConvertError(`${d.type}/${d.key}: the v3 line does not hash to v2's record hash`)
      yield row
    }
    batch = []
  }
  for await (const d of diffAll(prev, now, null)) {
    batch.push(d)
    if (batch.length >= convertConfig.bodyBatch) yield* flush()
  }
  if (batch.length > 0) yield* flush()
}

/** Rows as given, refused if any is not after the one before (files need key order). */
async function* inKeyOrder(rows: AsyncIterable<v3.LineRow>): AsyncGenerator<v3.LineRow> {
  let last: v3.LineRow | null = null
  for await (const r of rows) {
    if (last && v3.compareKeys(last.type, last.id, r.type, r.id) >= 0)
      throw new ConvertError(`Rows out of key order at ${r.type}/${r.id}`)
    yield r
    last = r
  }
}

interface TypeTally {
  count: number
  digest: bigint
}

function tally(m: Map<string, TypeTally>, type: string, id: string, hash: string) {
  let t = m.get(type)
  if (!t) m.set(type, (t = { count: 0, digest: 0n }))
  t.count++
  t.digest = (t.digest + entryDigest(type, id, hash)) % MOD
}

/**
 * Check a converted version against v2's, and give its counts. Throws a ConvertError naming
 * what differs.
 */
async function checkVersion(
  ports: Ports,
  collectionId: string,
  seq: number,
  v2: VersionView,
): Promise<Pick<Converted, 'typeCounts' | 'recordBytes' | 'assets' | 'assetBytes'>> {
  const store = ports.stores.v3
  const view = await viewOf(store, collectionId, seq)
  if (!view) throw new ConvertError(`No v3 commit ${seq}`)
  const problems: string[] = []

  const mine = new Map<string, TypeTally>()
  let recordBytes = 0
  for await (const g of v3.mergeGroups(store, view, { from: PAST_RESERVED })) {
    const e = g[g.length - 1]!.entry
    if (e.kind !== 'r' || e.type.startsWith('$')) continue
    tally(mine, e.type, e.id, e.hash!)
    recordBytes += e.size
  }
  const theirs = new Map<string, TypeTally>()
  for (const t of v2.types) {
    for await (const r of typeRecords(v2, t)) tally(theirs, t.slug, r.key, r.hash)
  }
  for (const type of new Set([...mine.keys(), ...theirs.keys()])) {
    const a = mine.get(type)
    const b = theirs.get(type)
    if (a?.count !== b?.count)
      problems.push(`${type}: ${b?.count ?? 0} records on v2, ${a?.count ?? 0} on v3`)
    else if (a?.digest !== b?.digest) problems.push(`${type}: the same count, different records`)
  }

  const schemas = await schemasOf(store, view)
  for (const t of v2.types) {
    const s = schemas[t.slug]
    if (!s) problems.push(`${t.slug}: no schema on v3`)
    else if (hashSchema(s) !== t.schemaHash) problems.push(`${t.slug}: a different schema on v3`)
  }
  for (const type of Object.keys(schemas))
    if (!v2.types.some((t) => t.slug === type)) problems.push(`${type}: a schema only on v3`)

  const assets = await assetsOf(store, view)
  const files = await filesOf(v2)
  for (const [hash, size] of files) {
    const a = assets.get(hash)
    if (!a) problems.push(`File ${hash}: not an asset on v3`)
    else if (a.size !== size) problems.push(`File ${hash}: ${size} bytes on v2, ${a.size} on v3`)
  }
  for (const hash of assets.keys())
    if (!files.has(hash)) problems.push(`Asset ${hash}: not a file on v2`)

  if (canonical(await metadataOf(store, view)) !== canonical(v2.root.metadata ?? null))
    problems.push('The metadata differs')

  if (problems.length > 0)
    throw new ConvertError(
      `${v2.version.semver} does not match v2: ${problems.slice(0, 10).join('; ')}${problems.length > 10 ? ` (and ${problems.length - 10} more)` : ''}`,
    )
  const typeCounts = Object.fromEntries([...mine].map(([t, x]) => [t, x.count]))
  return {
    typeCounts,
    recordBytes,
    assets: assets.size,
    assetBytes: [...assets.values()].reduce((n, a) => n + a.size, 0),
  }
}

/** Convert one version, on top of those converted before it. */
async function convertVersion(
  ports: Ports,
  collection: CollectionRow,
  v: VersionRow,
  prevRow: VersionRow | null,
  done: Converted[],
): Promise<{ converted: Converted; private: boolean }> {
  const store = ports.stores.v3
  const cid = collection.id
  const repo = await ports.stores.forCollection(cid)
  const now = await loadView(repo, v, true)
  const prev = prevRow ? await loadView(repo, prevRow, true) : null
  const head = await v3.headNumber(store, cid)
  let stored: v3.StoredCommit | null
  if (head >= v.seq) {
    // Committed by a job that stopped before recording it: the commit is the conversion.
    stored = await v3.readCommit(store, cid, v.seq)
  } else {
    if (head !== v.seq - 1)
      throw new ConvertError(
        `The v3 log is at commit ${head}, not ${v.seq - 1}, before ${v.semver}`,
      )
    await ensureCollection(store, cid)
    const session = v3.newSession()
    const built = await v3.buildFiles(
      inKeyOrder(versionRows(ports, prev, now)),
      v3.uploadTarget(store, session),
    )
    await v3.inParallel(
      built.map((f) => () => v3.installUpload(store, session, f.id)),
      16,
    )
    const base = v.baseSemver ? done.find((d) => d.semver === v.baseSemver) : undefined
    const files = built.map(({ size: _s, labeled: _l, commits: _c, ...ref }) => ref)
    const change = await v3.makeChange(cid, {
      files,
      base: base?.id ?? null,
      message: v.message,
    })
    stored = await v3.createCommit(
      store,
      cid,
      {
        change,
        bump: bumpBetween(prevRow?.semver ?? null, v.semver),
        ...(base ? { baseNumber: base.seq } : {}),
      },
      { signer: await ports.signer(), now: () => v.createdAt, attempts: 1 },
    )
  }
  if (!stored) throw new ConvertError(`The v3 log has no commit ${v.seq}`)
  if (stored.commit.semver !== v.semver)
    throw new ConvertError(`${v.semver} on v2 is ${stored.commit.semver} on v3`)
  const counts = await checkVersion(ports, cid, v.seq, now)
  return {
    private: hasPrivate(now),
    converted: {
      seq: v.seq,
      semver: v.semver,
      v2Hash: v.hash,
      id: stored.id,
      signature: stored.commit.sig,
      ...counts,
      v2: {
        recordCount: v.recordCount,
        publicRecordCount: v.publicRecordCount,
        fileCount: v.fileCount,
        totalBytes: v.totalBytes,
        publicFileCount: v.publicFileCount,
        publicTotalBytes: v.publicTotalBytes,
        typeCounts: v.typeCounts,
        publicTypeCounts: v.publicTypeCounts,
        hasPrivate: v.hasPrivate,
        signature: v.signature,
        assetBytes: v.assetBytes,
      },
    },
  }
}

async function setConversion(
  ports: Ports,
  collectionId: string,
  set: Partial<typeof schema.v3Conversions.$inferInsert>,
  where?: ReturnType<typeof sql>,
) {
  await ports.db
    .update(schema.v3Conversions)
    .set({ ...set, updatedAt: new Date() })
    .where(and(eq(schema.v3Conversions.collectionId, collectionId), where))
}

/** One step of a conversion: the next version, or the flip once every one is done. */
export async function convertStep(ports: Ports, collectionId: string): Promise<void> {
  const [conv] = await ports.db
    .select()
    .from(schema.v3Conversions)
    .where(eq(schema.v3Conversions.collectionId, collectionId))
  if (!conv || !['queued', 'converting', 'converted'].includes(conv.status)) return
  const [collection] = await ports.db
    .select()
    .from(schema.collections)
    .where(eq(schema.collections.id, collectionId))
  if (!collection) return
  if (collection.recordLayout === 'v3') return
  if (conv.status === 'queued' || !conv.fromLayout) {
    await setConversion(ports, collectionId, {
      status: 'converting',
      fromLayout: collection.recordLayout,
      fromPublic: collection.public,
      fromHistoryBytes: collection.historyBytes,
      error: null,
    })
  }
  const rows = await ports.db
    .select()
    .from(schema.versions)
    .where(eq(schema.versions.collectionId, collectionId))
    .orderBy(asc(schema.versions.seq))
  const done = conv.versions
  const next = rows.find((r) => r.seq > (done.at(-1)?.seq ?? 0))
  try {
    if (rows.some((r, i) => r.seq !== i + 1))
      throw new ConvertError('The versions are not numbered 1 to n')
    if (next) {
      const prevRow = rows.find((r) => r.seq === next.seq - 1) ?? null
      const r = await convertVersion(ports, collection, next, prevRow, done)
      // Written only if no other job recorded a version meanwhile.
      await setConversion(
        ports,
        collectionId,
        {
          status: 'converting',
          versions: [...done, r.converted],
          private: conv.private || r.private,
        },
        sql`json_array_length(${schema.v3Conversions.versions}) = ${done.length}`,
      )
      await ports.jobs.enqueue({ type: 'v3.convert', collectionId })
      return
    }
  } catch (err) {
    if (!(err instanceof ConvertError) && (err as Error).name !== 'InputRuleError') throw err
    console.error(`[v3.convert] ${collectionId} stopped:`, (err as Error).message)
    await setConversion(ports, collectionId, { status: 'failed', error: (err as Error).message })
    return
  }
  if (!conv.flip) {
    await setConversion(ports, collectionId, { status: 'converted', error: null })
    return
  }
  const fresh = { ...conv, fromLayout: conv.fromLayout ?? collection.recordLayout }
  const outcome = await flipToV3(ports, fresh, collection, rows)
  if (outcome === 'flipped') {
    await setConversion(ports, collectionId, { status: 'flipped', error: null })
    // Many small commits from the conversion: let the rebuild policy merge them.
    await ports.jobs.enqueue({ type: 'v3.rebuild', collectionId })
    console.log(`[v3.convert] ${collectionId} flipped to v3 at ${rows.at(-1)?.semver}`)
    return
  }
  await setConversion(ports, collectionId, {
    status: 'converted',
    error:
      outcome === 'private'
        ? 'It has private records or types: tell its owner it becomes private, then allow it'
        : 'Waiting: a push session is open, or a version arrived; the cron tries again',
  })
}

/**
 * Flip a converted collection to v3 in one D1 batch. Every statement after the first holds
 * only if the first flipped it, so a refused flip changes nothing.
 */
async function flipToV3(
  ports: Ports,
  conv: ConversionRow & { fromLayout: 'today' | 'f' | 'v3' },
  collection: CollectionRow,
  rows: VersionRow[],
): Promise<'flipped' | 'private' | 'waiting'> {
  if (conv.private && collection.public && !conv.allowPrivate) return 'private'
  const head = rows.at(-1)
  if (!head || conv.versions.at(-1)?.seq !== head.seq) return 'waiting'
  const db = ports.db
  const cid = collection.id
  const C = schema.collections
  const V = schema.versions
  const U = schema.schemaUsage
  const P = schema.pushSessions
  const flipped = sql`EXISTS (SELECT 1 FROM ${C} WHERE ${C.id} = ${cid} AND ${C.recordLayout} = 'v3')`
  const statements = [
    db
      .update(C)
      .set({
        recordLayout: 'v3',
        ...(conv.private ? { public: false } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(C.id, cid),
          eq(C.recordLayout, conv.fromLayout),
          eq(C.headVersionId, head.id),
          sql`NOT EXISTS (SELECT 1 FROM ${P} WHERE ${P.collectionId} = ${cid} AND ${P.status} IN ('open', 'committing'))`,
        ),
      ),
    ...conv.versions.map((c) => {
      const records = Object.values(c.typeCounts).reduce((a, b) => a + b, 0)
      const total = c.recordBytes + c.assetBytes
      return db
        .update(V)
        .set({
          v2Hash: sql`${V.hash}`,
          hash: c.id,
          signature: c.signature,
          recordCount: records,
          publicRecordCount: records,
          fileCount: c.assets,
          publicFileCount: c.assets,
          totalBytes: total,
          publicTotalBytes: total,
          typeCounts: c.typeCounts,
          publicTypeCounts: c.typeCounts,
          hasPrivate: false,
          assetBytes: c.assetBytes,
        })
        .where(and(eq(V.collectionId, cid), eq(V.seq, c.seq), eq(V.hash, c.v2Hash), flipped))
    }),
    // Schema usage is one set on v3: a type used in both keeps its public row.
    db
      .delete(U)
      .where(
        and(
          eq(U.collectionId, cid),
          eq(U.set, 'private'),
          sql`EXISTS (SELECT 1 FROM ${U} AS twin WHERE twin.collection_id = ${cid} AND twin.type_slug = ${U.typeSlug} AND twin."set" = 'public' AND twin.from_seq = ${U.fromSeq})`,
          flipped,
        ),
      ),
    db
      .update(U)
      .set({ set: 'public' })
      .where(and(eq(U.collectionId, cid), eq(U.set, 'private'), flipped)),
    db
      .update(C)
      .set({
        historyBytes: sql`(SELECT coalesce(sum(${V.totalBytes}), 0) FROM ${V} WHERE ${V.collectionId} = ${cid})`,
      })
      .where(and(eq(C.id, cid), flipped)),
  ]
  await db.batch(statements as never)
  const [after] = await db.select({ layout: C.recordLayout }).from(C).where(eq(C.id, cid))
  return after?.layout === 'v3' ? 'flipped' : 'waiting'
}

/**
 * Put a flipped collection back on v2: its layout, visibility, and every version row as
 * they were. Only while no v3 commit follows the conversion (one would be lost). The v3
 * objects stay; converting again reuses them.
 */
export async function revertToV2(ports: Ports, collectionId: string): Promise<string | null> {
  const [conv] = await ports.db
    .select()
    .from(schema.v3Conversions)
    .where(eq(schema.v3Conversions.collectionId, collectionId))
  if (!conv || conv.status !== 'flipped' || !conv.fromLayout)
    return 'The collection was not flipped'
  const last = conv.versions.at(-1)?.seq ?? 0
  const db = ports.db
  const C = schema.collections
  const V = schema.versions
  const back = sql`EXISTS (SELECT 1 FROM ${C} WHERE ${C.id} = ${collectionId} AND ${C.recordLayout} = ${conv.fromLayout})`
  await db.batch([
    db
      .update(C)
      .set({
        recordLayout: conv.fromLayout,
        public: conv.fromPublic ?? false,
        historyBytes: conv.fromHistoryBytes ?? 0,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(C.id, collectionId),
          eq(C.recordLayout, 'v3'),
          sql`NOT EXISTS (SELECT 1 FROM ${V} WHERE ${V.collectionId} = ${collectionId} AND ${V.seq} > ${last})`,
        ),
      ),
    ...conv.versions.map((c) =>
      db
        .update(V)
        .set({ ...c.v2, hash: c.v2Hash, v2Hash: null })
        .where(and(eq(V.collectionId, collectionId), eq(V.seq, c.seq), eq(V.hash, c.id), back)),
    ),
  ] as never)
  const [after] = await db.select({ layout: C.recordLayout }).from(C).where(eq(C.id, collectionId))
  if (after?.layout !== conv.fromLayout) return 'A v3 commit follows the conversion'
  await setConversion(ports, collectionId, { status: 'reverted', error: null })
  return null
}

/** Ask for a conversion (or take one up again after it failed or was reverted). */
export async function requestConversion(
  ports: Ports,
  collectionId: string,
  opts: { flip: boolean; allowPrivate: boolean },
): Promise<void> {
  await ports.db
    .insert(schema.v3Conversions)
    .values({ collectionId, flip: opts.flip, allowPrivate: opts.allowPrivate })
    .onConflictDoUpdate({
      target: schema.v3Conversions.collectionId,
      set: {
        flip: opts.flip,
        allowPrivate: opts.allowPrivate,
        status: sql`CASE WHEN ${schema.v3Conversions.status} IN ('failed', 'reverted') THEN 'converting' ELSE ${schema.v3Conversions.status} END`,
        error: null,
        updatedAt: new Date(),
      },
    })
  await ports.jobs.enqueue({ type: 'v3.convert', collectionId })
}

/** The cron: conversions asked for, stalled, or converted and waiting to flip. */
export async function queueConversions(ports: Ports): Promise<number> {
  const T = schema.v3Conversions
  const due = await ports.db
    .select({ id: T.collectionId })
    .from(T)
    .where(
      or(
        eq(T.status, 'queued'),
        and(
          eq(T.status, 'converting'),
          lt(T.updatedAt, new Date(Date.now() - convertConfig.staleMs)),
        ),
        and(eq(T.status, 'converted'), eq(T.flip, true)),
      ),
    )
    .limit(convertConfig.perCron)
  if (due.length > 0)
    await ports.jobs.enqueueBatch(due.map((d) => ({ type: 'v3.convert', collectionId: d.id })))
  return due.length
}

registerJob('v3.convert', async (job, ports) => convertStep(ports, String(job.collectionId)))
