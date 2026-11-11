/**
 * The read routes for a v3 collection (v3-deploy-plan.md, Phase 1), in the shapes the v2
 * routes in api/versions.ts answer with. Each v2 route hands a v3 collection here.
 *
 *   detail      the D1 row, the `$meta` row, the `$schema` rows, a page of one type
 *   records     a page in key order (`mergeGroups`; an offset skips key entries only)
 *   one record  `getRecord`
 *   history     `history`: one key's rows across commits, read from the files
 *   ndjson      `exportAll`, streamed
 *   diff        `changes` with before-states, paged by key and capped by bytes
 *   files       the version's `$asset` rows
 *
 * A v3 collection has no private records: a reader sees all of it or none of it, and
 * access decides which (api/access.ts). Records on the deny list are left out, as in v2.
 * Reserved types (`$schema`, `$asset`, `$meta`) are never listed as records.
 */
import { compareUtf8, v3 } from '@underlay/protocol'
import { and, eq, inArray } from 'drizzle-orm'
import type { Context } from 'hono'

import type { CollectionAccess } from '../api/access.js'
import { jsonError } from '../api/access.js'
import { collectionArk } from '../api/ark.js'
import { versionSummary, withPusherNames } from '../api/collections.js'
import type { AppEnv } from '../app.js'
import { chunks, inJson, JSON_CHUNK } from '../db/chunks.js'
import * as schema from '../db/schema.js'
import { deniedHashes } from '../lib/limits.js'
import { pullStream } from '../lib/streams.js'
import { findVersion, type VersionRow } from '../versions/view.js'
import { assetsOf, dataOf, metadataOf, schemasOf, viewOf } from './catalog.js'

const dec = new TextDecoder()
const enc = new TextEncoder()

/** The first key after every reserved type: publisher types never begin with `$`. */
const PAST_RESERVED: v3.Key = { type: '$\u{10FFFF}', id: '' }

/** A page's records stop at this many bytes of lines as well as at its count. */
export const v3ReadLimits = { pageBytes: 4 * 1024 * 1024 }

export interface V3Version {
  row: VersionRow
  view: v3.View
}

/** The version a route names (`latest`, a semver, a `ulv3:` id, or a `ulv2:` alias). */
export async function v3VersionFor(
  c: Context<AppEnv>,
  access: CollectionAccess,
  n = c.req.param('n') ?? 'latest',
): Promise<V3Version | Response> {
  const row = await findVersion(
    c.var.ports.db,
    access.collection.id,
    n,
    access.collection.headVersionId,
  )
  if (!row) return jsonError(c, 404, n === 'latest' ? 'No versions' : 'Version not found')
  const view = await viewOf(c.var.ports.stores.v3, access.collection.id, row.seq)
  if (!view) return jsonError(c, 404, 'Version not found')
  return { row, view }
}

/** A record line as the API returns it: the record and its hash. */
function recordJson(line: Uint8Array, hash: string) {
  const r = JSON.parse(dec.decode(line)) as { id: string; type: string; data: unknown }
  return { id: r.id, type: r.type, data: r.data, hash }
}

/** A record line with its hash added, as records.ndjson has it. */
const withHash = (line: Uint8Array, hash: string) =>
  `${dec.decode(line).slice(0, -1)},"hash":"${hash}"}`

/** The live publisher records of a version from a key on, with what reads their lines. */
async function* liveRecords(
  c: Context<AppEnv>,
  view: v3.View,
  range: v3.KeyRange,
  readAhead = 0,
): AsyncGenerator<v3.Found> {
  const store = c.var.ports.stores.v3
  const denied = await deniedHashes(c.var.ports.db)
  const from = range.type === undefined && !range.after && !range.from ? PAST_RESERVED : range.from
  for await (const group of v3.mergeGroups(
    store,
    view,
    { ...range, ...(from ? { from } : {}) },
    { readAhead },
  )) {
    const w = group[group.length - 1]!
    if (w.entry.kind !== 'r' || w.entry.type.startsWith('$')) continue
    if (denied.has(w.entry.hash!)) continue
    yield w
  }
}

/** A page of records: after a cursor or an offset, at most `limit` and `pageBytes`. */
async function recordPage(
  c: Context<AppEnv>,
  view: v3.View,
  opts: { type?: string; after?: v3.Key; offset: number; limit: number },
) {
  const range: v3.KeyRange = {
    ...(opts.type !== undefined ? { type: opts.type } : {}),
    ...(opts.after ? { after: opts.after } : {}),
  }
  const out: { line: Uint8Array; hash: string; type: string; id: string }[] = []
  let skip = opts.offset
  let bytes = 0
  let hasMore = false
  for await (const w of liveRecords(c, view, range)) {
    if (skip > 0) {
      skip--
      continue
    }
    if (
      out.length === opts.limit ||
      (out.length > 0 && bytes + w.entry.size > v3ReadLimits.pageBytes)
    ) {
      hasMore = true
      break
    }
    out.push({
      line: await w.reader.line(w.entry),
      hash: w.entry.hash!,
      type: w.entry.type,
      id: w.entry.id,
    })
    bytes += w.entry.size
  }
  return { records: out, hasMore }
}

/** The version's types: those with a schema, in key order, with their counts. */
function typesOf(row: VersionRow, schemas: Record<string, unknown>) {
  return Object.keys(schemas)
    .sort(compareUtf8)
    .map((t) => ({ slug: t, count: row.typeCounts[t] ?? 0 }))
}

export async function v3Detail(
  c: Context<AppEnv>,
  access: CollectionAccess,
  limitOf: () => number,
) {
  const v = await v3VersionFor(c, access)
  if (v instanceof Response) return v
  const store = c.var.ports.stores.v3
  const all = await schemasOf(store, v.view)
  const types = typesOf(v.row, all)
  const pageType = c.req.query('records')
  const shown =
    pageType === undefined ? types : types.filter((t) => t.slug === (pageType || types[0]?.slug))
  const schemas = Object.fromEntries(shown.map((t) => [t.slug, all[t.slug]]))
  let recordsPage = null
  if (pageType !== undefined) {
    const t = shown[0] ?? null
    const offset = Math.max(0, Number(c.req.query('offset') ?? 0) || 0)
    const page = t ? await recordPage(c, v.view, { type: t.slug, offset, limit: limitOf() }) : null
    recordsPage = {
      type: t?.slug ?? null,
      records: (page?.records ?? []).map((r) => recordJson(r.line, r.hash)),
      total: t?.count ?? 0,
    }
  }
  return c.json({
    ...(
      await withPusherNames(c.var.ports.db, [
        versionSummary(
          v.row,
          access.isMember,
          await collectionArk(c.var.ports.db, access.collection.id, access.owner),
        ),
      ])
    )[0],
    metadata: await metadataOf(store, v.view),
    typeCounts: Object.fromEntries(types.map((t) => [t.slug, t.count])),
    schemas,
    ...(recordsPage ? { recordsPage } : {}),
  })
}

export async function v3Records(
  c: Context<AppEnv>,
  access: CollectionAccess,
  q: { type?: string; cursor: { t: string; k: string } | null; offset: number; limit: number },
  encodeCursor: (t: string, k: string) => string,
) {
  const v = await v3VersionFor(c, access)
  if (v instanceof Response) return v
  const total = q.type
    ? (v.row.typeCounts[q.type] ?? 0)
    : Object.values(v.row.typeCounts).reduce((a, b) => a + b, 0)
  const page = await recordPage(c, v.view, {
    ...(q.type ? { type: q.type } : {}),
    ...(q.cursor ? { after: { type: q.cursor.t, id: q.cursor.k } } : {}),
    offset: q.cursor ? 0 : q.offset,
    limit: q.limit,
  })
  const last = page.records[page.records.length - 1]
  return c.json({
    records: page.records.map((r) => recordJson(r.line, r.hash)),
    pagination: {
      limit: q.limit,
      hasMore: page.hasMore,
      nextCursor: page.hasMore && last ? encodeCursor(last.type, last.id) : null,
      total,
    },
  })
}

export async function v3Record(c: Context<AppEnv>, access: CollectionAccess) {
  const v = await v3VersionFor(c, access)
  if (v instanceof Response) return v
  const type = c.req.param('type')!
  const id = c.req.param('id')!
  const rec = type.startsWith('$')
    ? null
    : await v3.getRecord(c.var.ports.stores.v3, v.view, type, id)
  const denied = await deniedHashes(c.var.ports.db)
  if (!rec?.line || denied.has(rec.hash)) return jsonError(c, 404, 'Record not found')
  return c.json({ ...recordJson(rec.line, rec.hash), semver: v.row.semver })
}

/** A record's changes across the collection's versions, oldest first, from its rows. */
export async function v3History(c: Context<AppEnv>, access: CollectionAccess) {
  const v = await v3VersionFor(c, access, 'latest')
  if (v instanceof Response) return v
  const type = c.req.param('type')!
  const id = c.req.param('id')!
  const rows = type.startsWith('$')
    ? []
    : (await v3.history(c.var.ports.stores.v3, v.view, type, id)).reverse()
  const seqs = [...new Set(rows.map((r) => r.commit))]
  const byseq = new Map<number, VersionRow>()
  for (const part of chunks(seqs, 90)) {
    const found = await c.var.ports.db
      .select()
      .from(schema.versions)
      .where(
        and(
          eq(schema.versions.collectionId, access.collection.id),
          inArray(schema.versions.seq, part),
        ),
      )
    for (const r of found) byseq.set(r.seq, r)
  }
  const changes: {
    seq: number
    semver: string
    createdAt: Date
    change: 'added' | 'updated' | 'removed'
    hash: string | null
  }[] = []
  let last: string | null = null
  for (const r of rows) {
    const hash = r.kind === 'x' ? null : r.hash
    if (hash === last) continue
    const ver = byseq.get(r.commit)
    if (!ver) continue
    changes.push({
      seq: ver.seq,
      semver: ver.semver,
      createdAt: ver.createdAt,
      change: hash === null ? 'removed' : last === null ? 'added' : 'updated',
      hash,
    })
    last = hash
  }
  if (changes.length === 0) return jsonError(c, 404, 'Record not found')
  return c.json({ type, id, changes, truncated: false })
}

export async function v3Ndjson(
  c: Context<AppEnv>,
  access: CollectionAccess,
  q: { type?: string; from: { t: string; k: string } | null },
) {
  const v = await v3VersionFor(c, access)
  if (v instanceof Response) return v
  const range: v3.KeyRange = {
    ...(q.type ? { type: q.type } : {}),
    ...(q.from ? { after: { type: q.from.t, id: q.from.k } } : {}),
  }
  let count: number
  if (!q.from) {
    count = q.type
      ? (v.row.typeCounts[q.type] ?? 0)
      : Object.values(v.row.typeCounts).reduce((a, b) => a + b, 0)
  } else {
    // A resume counts what is left: key entries only, no lines.
    count = 0
    for await (const _ of liveRecords(c, v.view, range)) count++
  }
  const lines = async function* () {
    let batch: string[] = []
    let bytes = 0
    for await (const w of liveRecords(c, v.view, range, 4 * 1024 * 1024)) {
      batch.push(withHash(await w.reader.line(w.entry), w.entry.hash!))
      bytes += w.entry.size
      if (batch.length >= 512 || bytes >= 1 << 20) {
        yield enc.encode(batch.join('\n') + '\n')
        batch = []
        bytes = 0
      }
    }
    if (batch.length) yield enc.encode(batch.join('\n') + '\n')
  }
  return new Response(pullStream(lines()), {
    headers: { 'content-type': 'application/x-ndjson', 'x-underlay-record-count': String(count) },
  })
}

export async function v3Diff(
  c: Context<AppEnv>,
  access: CollectionAccess,
  q: { fromParam?: string; cursor: { t: string; k: string } | null; limit: number },
  encodeCursor: (t: string, k: string) => string,
) {
  const v = await v3VersionFor(c, access)
  if (v instanceof Response) return v
  const store = c.var.ports.stores.v3
  let since = v.row.seq - 1
  let fromSemver: string | null = null
  if (q.fromParam) {
    const from = await findVersion(c.var.ports.db, access.collection.id, q.fromParam, null)
    if (!from) return jsonError(c, 404, `Version ${q.fromParam} not found`)
    if (from.seq > v.row.seq)
      return jsonError(c, 400, '`from` must be at or before the version read')
    since = from.seq
    fromSemver = from.semver
  } else if (since > 0) {
    const [prev] = await c.var.ports.db
      .select({ semver: schema.versions.semver })
      .from(schema.versions)
      .where(
        and(eq(schema.versions.collectionId, access.collection.id), eq(schema.versions.seq, since)),
      )
    fromSemver = prev?.semver ?? null
  }
  // The reserved rows first, for the page's `meta`: they sort before every publisher type.
  const meta = {
    schemaChanged: since === 0,
    metadataChanged: false,
    filesAdded: 0,
    filesRemoved: 0,
  }
  for await (const ch of v3.changes(store, v.view, since, { to: PAST_RESERVED, before: true })) {
    if (ch.type === v3.SCHEMA_TYPE) meta.schemaChanged = true
    else if (ch.type === v3.META_TYPE) meta.metadataChanged = true
    else if (ch.type === v3.ASSET_TYPE) {
      if (!ch.before && ch.after) meta.filesAdded++
      else if (ch.before && !ch.after) meta.filesRemoved++
    }
  }
  const after = q.cursor ? { type: q.cursor.t, id: q.cursor.k } : null
  const added: string[] = []
  const updated: string[] = []
  const removed: { id: string; type: string }[] = []
  let n = 0
  let bytes = 0
  let next: string | null = null
  let last: { type: string; id: string } | null = null
  const range = after ? { after, before: true } : { from: PAST_RESERVED, before: true }
  for await (const ch of v3.changes(store, v.view, since, range)) {
    if (ch.type.startsWith('$')) continue
    const line = ch.after ? await ch.line() : null
    const size = line?.byteLength ?? 0
    if (n === q.limit || (n > 0 && bytes + size > v3ReadLimits.pageBytes)) {
      next = encodeCursor(last!.type, last!.id)
      break
    }
    n++
    bytes += size
    last = { type: ch.type, id: ch.id }
    if (!ch.after) removed.push({ id: ch.id, type: ch.type })
    else if (!ch.before) added.push(dec.decode(line!))
    else updated.push(dec.decode(line!))
  }
  const rest = JSON.stringify({
    removed,
    pagination: { limit: q.limit, hasMore: next !== null, nextCursor: next },
    meta,
  })
  const head = JSON.stringify({ from: fromSemver, to: v.row.semver })
  return c.body(
    `${head.slice(0, -1)},"added":[${added.join(',')}],"updated":[${updated.join(',')}],${rest.slice(1)}`,
    200,
    { 'content-type': 'application/json' },
  )
}

/** The version's files: its `$asset` rows. Which records reference each is not indexed on v3. */
export async function v3Files(c: Context<AppEnv>, access: CollectionAccess) {
  const v = await v3VersionFor(c, access)
  if (v instanceof Response) return v
  const assets = await assetsOf(c.var.ports.stores.v3, v.view)
  const hashes = [...assets.keys()].sort(compareUtf8).slice(0, 10_000)
  const created = new Map<string, Date>()
  for (const part of chunks(hashes, JSON_CHUNK)) {
    const rows = await c.var.ports.db
      .select({ hash: schema.files.hash, createdAt: schema.files.createdAt })
      .from(schema.files)
      .where(inJson(schema.files.hash, part))
    for (const r of rows) created.set(r.hash, r.createdAt)
  }
  return c.json(
    hashes.map((h) => ({
      hash: h,
      size: assets.get(h)!.size,
      mimeType: assets.get(h)!.mediaType,
      createdAt: created.get(h) ?? null,
      referenceCount: 0,
      references: [],
    })),
  )
}

/** A route v3 does not offer yet (v3-deploy-plan.md, Phase 3). */
export const notOnV3 = (c: Context<AppEnv>, what: string) =>
  c.json(
    {
      error: `${what} is not available for v3 collections yet`,
      code: 'not_on_v3',
      statusCode: 501,
    },
    501,
  )

export { dataOf }
