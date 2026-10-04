/**
 * v1 (Postgres) → v2 conversion (edge-redesign.md, "Migration").
 *
 * 1. Accounts and settings: better-auth tables, organizations, ARK tables and
 *    instance settings are copied row for row (same fields). v1's protocol
 *    comments (page_comments) are not: v2 dropped the feature.
 * 2. Files: the `files` table is copied with v1 storage keys; `copyFiles`
 *    (files.ts) then moves the objects to their v2 keys.
 * 3. Collections: each collection's ready versions are replayed oldest first
 *    through the v2 commit engine. Each version's changes are the diff between
 *    its v1 record set and the previous one, computed in Postgres and streamed
 *    in (type, id) order (COLLATE "C" = UTF-8 byte order, the trees' order), so
 *    the cost is O(changes) per version. Metadata-patch versions (shared record
 *    sets) produce no record changes. Versions keep their v1 semver and time.
 *
 * Records, schemas and versions are re-hashed under v2, and their v1 hashes are
 * not kept: nothing outside the platform refers to them. Field-level privacy is gone in v2:
 * a type with private fields becomes a wholly private type, and the report says
 * so (edge-redesign.md asks to check this is unused before migrating).
 */
import { createReadStream } from 'node:fs'
import { appendFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

import {
  type Change,
  hashRecord,
  hashSchema,
  newSalt,
  OUT_OF_LINE_BYTES,
  type RecordEntry,
  utf8ByteLength,
} from '@underlay/protocol'
import {
  type BaseVersion,
  commitVersion,
  dbSchema as schema,
  type Ports,
  type TypeInput,
} from '@underlay/server'
import { eq, getTableColumns, inArray } from 'drizzle-orm'

/** Anything that runs a parameterized query against the v1 database. */
export interface V1Db {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>
  /**
   * A server-side cursor over an ordered query, read `batch` rows at a time;
   * `next` returns [] at the end. Optional: without it, ordered reads page by key,
   * which re-sorts on every page when the order has no matching index (v1's
   * indexes use the database collation, the converter needs COLLATE "C").
   */
  cursor?<T = Record<string, unknown>>(
    text: string,
    params: unknown[],
    batch: number,
  ): Promise<V1Cursor<T>>
}

export interface V1Cursor<T> {
  next(): Promise<T[]>
  close(): Promise<void>
}

export interface MigrationReport {
  collections: number
  versions: number
  skippedVersions: { collection: string; semver: string; reason: string }[]
  recordUpserts: number
  fieldPrivateTypes: { collection: string; type: string }[]
  /**
   * v1 let a version hold one (type, id) twice with different data; v2 keys are
   * unique. The newest record object is kept (then the lower hash); these were dropped.
   */
  duplicateIds: { collection: string; semver: string; type: string; id: string; hash: string }[]
  copied: Record<string, number>
}

export const newReport = (): MigrationReport => ({
  collections: 0,
  versions: 0,
  skippedVersions: [],
  recordUpserts: 0,
  fieldPrivateTypes: [],
  duplicateIds: [],
  copied: {},
})

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())

/** Copy a table whose v1 and v2 columns have the same names. Unknown columns are dropped. */
// `any`: pnpm resolves drizzle-orm twice (different peers), so its table types don't unify.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function copyTable(
  v1: V1Db,
  ports: Ports,
  v1Table: string,
  v2: any,
  report: MigrationReport,
  map?: (row: Record<string, unknown>) => Record<string, unknown> | null,
) {
  const columns = new Set(Object.keys(getTableColumns(v2) as object))
  const rows = await v1.query(`SELECT * FROM "${v1Table}"`)
  let n = 0
  for (let i = 0; i < rows.length; i += 50) {
    const values = rows
      .slice(i, i + 50)
      .map((r) => {
        const out: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(r)) if (columns.has(camel(k))) out[camel(k)] = v
        return map ? map(out) : out
      })
      .filter((r): r is Record<string, unknown> => r !== null)
    if (values.length === 0) continue
    await ports.db
      .insert(v2)
      .values(values as never)
      .onConflictDoNothing()
    n += values.length
  }
  report.copied[v1Table] = n
}

export async function migrateAccounts(
  v1: V1Db,
  ports: Ports,
  report: MigrationReport,
): Promise<void> {
  // Order follows foreign keys.
  await copyTable(v1, ports, 'user', schema.user, report)
  await copyTable(v1, ports, 'organization', schema.organization, report)
  await copyTable(v1, ports, 'member', schema.member, report)
  await copyTable(v1, ports, 'account', schema.account, report)
  await copyTable(v1, ports, 'session', schema.session, report)
  await copyTable(v1, ports, 'verification', schema.verification, report)
  await copyTable(v1, ports, 'invitation', schema.invitation, report)
  await copyTable(v1, ports, 'apikey', schema.apikey, report)
  await copyTable(v1, ports, 'instance_settings', schema.instanceSettings, report)
  await copyTable(v1, ports, 'files', schema.files, report, (r) => ({
    ...r,
    verifiedAt: r.createdAt,
  }))
}

/** Collection-scoped tables, after the collections exist. */
/**
 * A verified upload row per file the collection's versions held: the proof of
 * possession a commit needs to reference a file it no longer holds (B2), so a
 * migrated collection can re-add a record whose file it once had without
 * uploading the bytes again.
 */
export async function recordPossession(
  ports: Ports,
  collectionId: string,
  hashes: Iterable<string>,
): Promise<number> {
  const all = [...hashes]
  let n = 0
  for (let i = 0; i < all.length; i += 50) {
    const rows = await ports.db
      .select()
      .from(schema.files)
      .where(inArray(schema.files.hash, all.slice(i, i + 50)))
    const values = rows.map((f) => ({
      collectionId,
      hash: f.hash,
      size: f.size,
      mimeType: f.mimeType,
      storageKey: ports.stores.canonicalFileKey(f.hash),
      status: 'verified' as const,
    }))
    for (let j = 0; j < values.length; j += 10) {
      await ports.db.insert(schema.fileUploads).values(values.slice(j, j + 10))
    }
    n += values.length
  }
  return n
}

export async function migrateCollectionSettings(
  v1: V1Db,
  ports: Ports,
  report: MigrationReport,
  /** Only these collections' rows (all when absent). */
  only?: Set<string>,
): Promise<void> {
  const ours = (r: Record<string, unknown>) =>
    !only || only.has(String(r.collectionId)) ? r : null
  await copyTable(v1, ports, 'collection_webhooks', schema.collectionWebhooks, report, ours)
  await copyTable(v1, ports, 'ark_shoulders', schema.arkShoulders, report)
  await copyTable(v1, ports, 'ark_collections', schema.arkCollections, report, ours)
  await copyTable(v1, ports, 'ark_record_types', schema.arkRecordTypes, report, ours)
  // Labels move from v1 schema ids to v2 schema hashes.
  const labels = await v1.query<{ label: string; schema: unknown; created_at: Date }>(
    'SELECT l.label, s.schema, l.created_at FROM schema_labels l JOIN schemas s ON s.id = l.schema_id',
  )
  for (const l of labels) {
    await ports.db
      .insert(schema.schemaLabels)
      .values({ schemaHash: hashSchema(l.schema), label: l.label, createdAt: l.created_at })
      .onConflictDoNothing()
  }
  report.copied.schema_labels = labels.length
}

interface V1Version {
  id: string
  semver: string
  hash: string
  public_hash: string | null
  base_semver: string | null
  message: string | null
  metadata: Record<string, unknown> | null
  pushed_by: string | null
  app_id: string | null
  actor_id: string | null
  records_from_version_id: string | null
  created_at: Date
}

/**
 * Protocol v2 refuses field-level privacy. A type that used it becomes a private
 * type: its private fields are never exposed, at the cost of the public ones.
 */
function fixFieldPrivacy(s: Record<string, unknown>): {
  schema: Record<string, unknown>
  changed: boolean
} {
  const props = s.properties as Record<string, Record<string, unknown>> | undefined
  if (!props || !Object.values(props).some((p) => p && p.private === true))
    return { schema: s, changed: false }
  const cleaned: Record<string, unknown> = {}
  for (const [k, p] of Object.entries(props)) {
    const { private: _drop, ...rest } = p
    void _drop
    cleaned[k] = rest
  }
  return { schema: { ...s, properties: cleaned, private: true }, changed: true }
}

const PAGE = 2000
/** Rows per cursor fetch: one sort, then one round trip per batch. */
const CURSOR_BATCH = 10_000

/**
 * An ordered read by record id, a batch at a time: through a cursor where the
 * reader has one, else keyset pages. `sql` takes `params`; `key` names the
 * ordered id column, and `tiebreak` orders rows sharing an id. Paging appends
 * `AND key > after` and a LIMIT, so it needs ids to be unique (it would skip a
 * duplicate split across pages); cursors don't.
 */
async function idBatches<T extends { id: string }>(
  v1: V1Db,
  sql: (keyClause: string) => string,
  params: unknown[],
  key: string,
  tiebreak = '',
): Promise<V1Cursor<T>> {
  const order = ` ORDER BY ${key} COLLATE "C"${tiebreak}`
  if (v1.cursor) return v1.cursor<T>(sql('') + order, params, CURSOR_BATCH)
  let after = ''
  let done = false
  const n = params.length
  return {
    next: async () => {
      if (done) return []
      const rows = await v1.query<T>(
        sql(` AND ${key} COLLATE "C" > $${n + 1}`) + `${order} LIMIT $${n + 2}`,
        [...params, after, PAGE],
      )
      if (rows.length < PAGE) done = true
      if (rows.length) after = rows[rows.length - 1]!.id
      return rows
    },
    close: async () => {},
  }
}

type Routed = { public?: Change<RecordEntry>; private?: Change<RecordEntry> }

export const migrateConfig = {
  /** Held private changes past this many go to a temp file rather than memory. */
  holdInMemory: 50_000,
}

/**
 * Private changes read while the public side is being consumed, kept for the
 * private side: in memory up to `migrateConfig.holdInMemory`, then in a temp file.
 */
class Held {
  #mem: Change<RecordEntry>[] = []
  #file: string | null = null

  async push(c: Change<RecordEntry>) {
    this.#mem.push(c)
    if (this.#mem.length < migrateConfig.holdInMemory) return
    this.#file ??= join(await mkdtemp(join(tmpdir(), 'ul-migrate-')), 'held.ndjson')
    await appendFile(this.#file, this.#mem.map((x) => JSON.stringify(x)).join('\n') + '\n')
    this.#mem = []
  }

  async *drain(): AsyncGenerator<Change<RecordEntry>> {
    if (this.#file) {
      const lines = createInterface({ input: createReadStream(this.#file), crlfDelay: Infinity })
      for await (const l of lines) if (l) yield JSON.parse(l) as Change<RecordEntry>
      await rm(dirname(this.#file), { recursive: true, force: true })
      this.#file = null
    }
    yield* this.#mem
    this.#mem = []
  }
}

/**
 * A type's changes, read from v1 once and split into the public and private
 * streams buildVersion takes. It merges the public side to the end before
 * starting the private side, so private changes met on the way are held until
 * then. With `withPublic` false (a private type), the private side reads alone.
 */
function splitBySet(
  source: AsyncGenerator<Routed>,
  withPublic: boolean,
): {
  public: AsyncGenerator<Change<RecordEntry>> | null
  private: AsyncGenerator<Change<RecordEntry>>
} {
  const held = new Held()
  let publicDone = !withPublic
  async function* pub() {
    for await (const r of source) {
      if (r.private) await held.push(r.private)
      if (r.public) yield r.public
    }
    publicDone = true
  }
  async function* priv() {
    if (!publicDone) throw new Error('splitBySet: the private side was read before the public side')
    yield* held.drain()
    if (!withPublic) for await (const r of source) if (r.private) yield r.private
  }
  return { public: withPublic ? pub() : null, private: priv() }
}

/** One type's record changes between two v1 record sets, in id order. */
async function* typeDelta(
  v1: V1Db,
  prev: string | null,
  cur: string,
  type: string,
  onDuplicate: (id: string, hash: string) => void,
): AsyncGenerator<{
  id: string
  upsert: { data: unknown; private: boolean; hash: string } | null
}> {
  const upserts = await idBatches<{ id: string; private: boolean; h: string; data: unknown }>(
    v1,
    (keyClause) =>
      `SELECT vr.record_id AS id, vr.private, vr.record_hash AS h, ro.data
       FROM version_records vr JOIN record_objects ro ON ro.hash = vr.record_hash
       WHERE vr.version_id = $1 AND vr.type = $2${keyClause}
         ${
           prev
             ? `AND NOT EXISTS (SELECT 1 FROM version_records p WHERE p.version_id = $3
              AND p.type = vr.type AND p.record_id = vr.record_id AND p.record_hash = vr.record_hash
              AND p.private = vr.private)`
             : ''
         }`,
    prev ? [cur, type, prev] : [cur, type],
    'vr.record_id',
    // Duplicate ids (v1 allowed them): the kept one first.
    ', ro.created_at DESC, vr.record_hash',
  )
  const deletes = prev
    ? await idBatches<{ id: string }>(
        v1,
        (keyClause) =>
          `SELECT p.record_id AS id FROM version_records p
           WHERE p.version_id = $1 AND p.type = $2${keyClause}
             AND NOT EXISTS (SELECT 1 FROM version_records vr WHERE vr.version_id = $3
                  AND vr.type = p.type AND vr.record_id = p.record_id)`,
        [prev, type, cur],
        'p.record_id',
      )
    : null
  let ups: { id: string; private: boolean; h: string; data: unknown }[] = []
  let dels: { id: string }[] = []
  let doneU = false
  let doneD = deletes === null
  const fillU = async () => {
    if (doneU || ups.length) return
    ups = await upserts.next()
    if (ups.length === 0) doneU = true
  }
  const fillD = async () => {
    if (doneD || dels.length) return
    dels = await deletes!.next()
    if (dels.length === 0) doneD = true
  }
  // Byte order, to match COLLATE "C".
  const lt = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b)) < 0
  // A duplicated id (v1 allowed them) comes twice in a stream: use it once.
  let lastUp: string | null = null
  let lastDel: string | null = null
  try {
    for (;;) {
      await fillU()
      await fillD()
      const u = ups[0]
      const d = dels[0]
      if (!u && !d) return
      if (u && u.id === lastUp) {
        ups.shift()
        onDuplicate(u.id, u.h)
      } else if (u && (!d || lt(u.id, d.id))) {
        ups.shift()
        lastUp = u.id
        yield { id: u.id, upsert: { data: u.data, private: u.private, hash: u.h } }
      } else if (d!.id === lastDel) {
        dels.shift()
      } else {
        dels.shift()
        lastDel = d!.id
        yield { id: d!.id, upsert: null }
      }
    }
  } finally {
    await upserts.close()
    await deletes?.close()
  }
}

export async function migrateCollection(
  v1: V1Db,
  ports: Ports,
  collectionId: string,
  report: MigrationReport,
): Promise<void> {
  const [col] = await v1.query<{
    id: string
    organization_id: string
    slug: string
    name: string
    public: boolean
    created_at: Date
    updated_at: Date
  }>('SELECT * FROM collections WHERE id = $1', [collectionId])
  if (!col) throw new Error(`v1 collection ${collectionId} not found`)
  await ports.db.batch([
    ports.db.insert(schema.collections).values({
      id: col.id,
      organizationId: col.organization_id,
      slug: col.slug,
      name: col.name,
      public: col.public,
      privateSalt: newSalt(),
      createdAt: col.created_at,
      updatedAt: col.updated_at,
    }),
    ports.db.insert(schema.placements).values({
      collectionId: col.id,
      locationId: schema.PLATFORM_LOCATION_ID,
      role: 'primary',
      sets: 'public+private',
    }),
  ])
  report.collections++
  const repo = await ports.stores.forCollection(col.id)

  const versions = await v1.query<V1Version>(
    `SELECT id::text, semver, hash, public_hash, base_semver, message, metadata, pushed_by, app_id,
            actor_id, records_from_version_id::text, created_at
     FROM versions WHERE collection_id = $1 AND status = 'ready'
     ORDER BY created_at, major, minor, patch`,
    [collectionId],
  )

  let base: BaseVersion | null = null
  let prevRecords: string | null = null
  let prevFiles = new Set<string>()
  const everFiles = new Set<string>()

  for (const v of versions) {
    const recordsId = v.records_from_version_id ?? v.id
    const schemaRows = await v1.query<{ slug: string; schema: Record<string, unknown> }>(
      'SELECT vs.slug, s.schema FROM version_schemas vs JOIN schemas s ON s.id = vs.schema_id WHERE vs.version_id = $1',
      [v.id],
    )
    const root = base ? await repo.root(base.hash) : null
    const basePriv = root?.private ? await repo.privateSet(root.private) : null
    const fileRows = await v1.query<{ file_hash: string }>(
      'SELECT file_hash FROM version_files WHERE version_id = $1',
      [v.id],
    )
    const files = new Set(fileRows.map((f) => f.file_hash))
    for (const h of files) everFiles.add(h)

    const types: TypeInput[] = schemaRows.map((row) => {
      const fixed = fixFieldPrivacy(row.schema)
      if (
        fixed.changed &&
        !report.fieldPrivateTypes.some((t) => t.collection === col.id && t.type === row.slug)
      ) {
        report.fieldPrivateTypes.push({ collection: col.id, type: row.slug })
      }
      const s = fixed.schema
      const privateType = s.private === true
      const hasPub = !!root?.public.types[row.slug]?.root
      const hasPriv = !!basePriv?.types[row.slug]?.root
      const unchanged = prevRecords === recordsId
      const onDuplicate = (id: string, hash: string) =>
        report.duplicateIds.push({
          collection: col.slug,
          semver: v.semver,
          type: row.slug,
          id,
          hash,
        })
      /** One v1 change, as a change in each set it touches. */
      const routed = async function* (): AsyncGenerator<Routed> {
        for await (const d of typeDelta(v1, prevRecords, recordsId, row.slug, onDuplicate)) {
          if (!d.upsert) {
            yield {
              ...(hasPub && { public: { key: d.id, entry: null } }),
              ...(hasPriv && { private: { key: d.id, entry: null } }),
            }
            continue
          }
          const target = privateType || d.upsert.private ? 'private' : 'public'
          const { hash, canonical } = hashRecord(d.id, row.slug, d.upsert.data)
          report.recordUpserts++
          const size = utf8ByteLength(canonical)
          const body =
            size > OUT_OF_LINE_BYTES ? await repo.putOutOfLine(hash, canonical) : canonical
          const upsert = { key: d.id, entry: { key: d.id, hash, size, body } }
          // Leaving the other set, if the type is there.
          const gone = { key: d.id, entry: null }
          yield target === 'public'
            ? { public: upsert, ...(hasPriv && { private: gone }) }
            : { private: upsert, ...(hasPub && { public: gone }) }
        }
      }
      const split = unchanged ? null : splitBySet(routed(), !privateType)
      return {
        slug: row.slug,
        schema: s,
        schemaHash: hashSchema(s),
        public: split?.public ?? null,
        private: split?.private ?? null,
      }
    })

    const r = await commitVersion(ports, {
      collectionId: col.id,
      base,
      types,
      metadata: v.metadata,
      declaredFiles: {
        add: [...files].filter((h) => !prevFiles.has(h)),
        remove: [...prevFiles].filter((h) => !files.has(h)),
      },
      message: v.message,
      pushedBy: v.pushed_by,
      appId: v.app_id,
      actorId: v.actor_id,
      migrated: { semver: v.semver, createdAt: v.created_at },
    })
    if (r.status === 'committed') {
      report.versions++
      const nv = r.version
      base = {
        id: nv.id,
        seq: nv.seq,
        semver: nv.semver,
        hash: nv.hash,
        publicRefsRoot: nv.publicRefsRoot,
        privateRefsRoot: nv.privateRefsRoot,
      }
      prevRecords = recordsId
      prevFiles = files
    } else {
      // e.g. two v1 versions that differ only in what v2 no longer records.
      report.skippedVersions.push({ collection: col.slug, semver: v.semver, reason: r.status })
      prevRecords = recordsId
      prevFiles = files
    }
  }

  await recordPossession(ports, col.id, everFiles)
  // Publishing the replayed versions stamped the conversion time; keep v1's.
  await ports.db
    .update(schema.collections)
    .set({ updatedAt: col.updated_at })
    .where(eq(schema.collections.id, col.id))
}

/** Everything: accounts, collections (each with its history), then collection settings. */
export async function migrateAll(
  v1: V1Db,
  ports: Ports,
  opts: {
    onCollection?: (slug: string) => void
    /** Convert only these collections, named by id or `owner/slug` (accounts are always copied). */
    collections?: string[]
  } = {},
): Promise<MigrationReport> {
  const report = newReport()
  await migrateAccounts(v1, ports, report)
  const all = await v1.query<{ id: string; slug: string; owner: string }>(
    `SELECT c.id::text, c.slug, o.slug AS owner FROM collections c
     JOIN organization o ON o.id = c.organization_id ORDER BY c.created_at`,
  )
  const wanted = opts.collections ? new Set(opts.collections) : null
  const cols = wanted
    ? all.filter((c) => wanted.has(c.id) || wanted.has(`${c.owner}/${c.slug}`))
    : all
  if (wanted && cols.length !== wanted.size) {
    const found = new Set(cols.flatMap((c) => [c.id, `${c.owner}/${c.slug}`]))
    throw new Error(`No v1 collection: ${[...wanted].filter((w) => !found.has(w)).join(', ')}`)
  }
  for (const c of cols) {
    opts.onCollection?.(c.slug)
    await migrateCollection(v1, ports, c.id, report)
  }
  await migrateCollectionSettings(
    v1,
    ports,
    report,
    wanted ? new Set(cols.map((c) => c.id)) : undefined,
  )
  return report
}
