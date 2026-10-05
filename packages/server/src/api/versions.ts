/**
 * Version reads (v1 shapes: docs/v1-read-api.md), mounted at /api/collections.
 *
 *   GET /:owner/:slug/versions                       list (SQLite)
 *   GET /:owner/:slug/versions/:n                    detail (+ root metadata, visible schemas)
 *   GET /:owner/:slug/versions/:n/records            page by key or offset; O(height) seeks
 *   GET /:owner/:slug/versions/:n/records.ndjson     stream
 *   GET /:owner/:slug/versions/:n/manifest           ids and hashes from nodes; ?since= delta
 *   GET /:owner/:slug/versions/:n/diff               ?from=; O(changes)
 *   GET /:owner/:slug/versions/:n/files              from the visible file trees
 *
 * Privacy is decided once: the view holds the sets the caller may read.
 * Records list order: by id within a type; without ?type=, types in slug order
 * then id, with a (type, id) cursor (a deliberate change from v1).
 */
import {
  compareUtf8,
  type DiffEntry,
  diffTrees,
  fileTree,
  gzip,
  iterate,
  leaves,
  OUT_OF_LINE_BYTES,
  type RecordEntry,
  recordTree,
  referenceCounts,
  RepoSource,
} from '@underlay/protocol'
import { desc, eq } from 'drizzle-orm'
import { type Context, Hono } from 'hono'

import type { AppEnv } from '../app.js'
import { chunks, inJson, JSON_CHUNK } from '../db/chunks.js'
import * as schema from '../db/schema.js'
import { deniedHashes } from '../lib/limits.js'
import {
  findVersion,
  getRecord,
  loadView,
  typeRecords,
  type VersionView,
} from '../versions/view.js'
import { type CollectionAccess, jsonError, requireCollection } from './access.js'
import { collectionArk } from './ark.js'
import { versionSummary } from './collections.js'

const encodeCursor = (t: string, k: string) =>
  Buffer.from(JSON.stringify({ t, k })).toString('base64url')
function decodeCursor(
  s: string | undefined,
  type: string | undefined,
): { t: string; k: string } | null {
  if (!s) return null
  try {
    const v = JSON.parse(Buffer.from(s, 'base64url').toString()) as {
      t?: unknown
      k?: unknown
      r?: unknown
    }
    if (typeof v.t === 'string' && typeof v.k === 'string') return { t: v.t, k: v.k }
    // v1 cursors: {r: [recordId, recordHash]} within a type.
    if (Array.isArray(v.r) && typeof v.r[0] === 'string' && type) return { t: type, k: v.r[0] }
  } catch {
    // Not a cursor: a bare record id within ?type= (v1 accepted that).
  }
  return type ? { t: type, k: s } : null
}

const clamp = (v: string | undefined, def: number, max: number) =>
  Math.min(max, Math.max(1, Number(v ?? def) || def))

async function viewFor(
  c: Context<AppEnv>,
  access: CollectionAccess,
): Promise<VersionView | Response> {
  const n = c.req.param('n') ?? 'latest'
  const v = await findVersion(
    c.var.ports.db,
    access.collection.id,
    n,
    access.collection.headVersionId,
  )
  if (!v) return jsonError(c, 404, n === 'latest' ? 'No versions' : 'Version not found')
  const repo = await c.var.ports.stores.forCollection(access.collection.id)
  return loadView(repo, v, access.isMember, await deniedHashes(c.var.ports.db))
}

/** Add the record hash to a canonical record line: `{"id",…,"data":…,"hash":"…"}`. */
const withHash = (body: string, hash: string) => `${body.slice(0, -1)},"hash":"${hash}"}`

function recordJson(e: RecordEntry & { type: string }) {
  const r = JSON.parse(e.body!) as { id: string; type: string; data: unknown }
  return { id: r.id, type: r.type, data: r.data, hash: e.hash }
}

/** Records across visible types from a (type, id) position, in (type, id) order. */
async function* allRecords(
  view: VersionView,
  from: { t: string; k: string } | null,
  offset: number,
  bodies: boolean,
) {
  let skip = offset
  for (const t of view.types) {
    if (from && compareUtf8(t.slug, from.t) < 0) continue
    if (skip >= t.count) {
      skip -= t.count
      continue
    }
    const opts: { after?: string; offset?: number; bodies: boolean } = { bodies }
    if (from && t.slug === from.t) opts.after = from.k
    else if (skip > 0) opts.offset = skip
    skip = 0
    yield* typeRecords(view, t, opts)
  }
}

/**
 * Caching for a version's data: a published version never changes, so anything
 * addressed by its semver or hash may be cached; `latest` moves. Anonymous
 * reads are public for ten minutes, and stale for a minute more while a cache
 * revalidates: a collection made private, or a blocked record, stops being
 * served within about eleven minutes (accepted, decision D2 of alignment review
 * 2; the settings page says so). Members' reads are private. Only 200s are
 * cached, so a collection made public is readable as soon as the database says
 * so.
 */
function versionCaching(c: Context<AppEnv>) {
  const n = c.req.param('n')
  if (!n || n === 'latest' || c.req.method !== 'GET' || c.res.status !== 200) return
  if (c.res.headers.has('cache-control')) return
  c.res.headers.set(
    'cache-control',
    c.var.principal ? 'private, max-age=3600' : 'public, max-age=600, stale-while-revalidate=60',
  )
}

export function versionRoutes() {
  const app = new Hono<AppEnv>()
  app.use('/:owner/:slug/versions/:n/*', async (c, next) => {
    await next()
    versionCaching(c)
  })
  app.use('/:owner/:slug/versions/:n', async (c, next) => {
    await next()
    versionCaching(c)
  })

  app.get('/:owner/:slug/versions', async (c) => {
    const access = await requireCollection(c, 'read')
    if (access instanceof Response) return access
    const limit = clamp(c.req.query('limit'), 50, 100)
    const offset = Math.max(0, Number(c.req.query('offset') ?? 0) || 0)
    const rows = await c.var.ports.db
      .select()
      .from(schema.versions)
      .where(eq(schema.versions.collectionId, access.collection.id))
      .orderBy(desc(schema.versions.seq))
      .limit(limit)
      .offset(offset)
    const ark = await collectionArk(c.var.ports.db, access.collection.id, access.owner)
    return c.json(rows.map((v) => versionSummary(v, access.isMember, ark)))
  })

  app.get('/:owner/:slug/versions/:n', async (c) => {
    const access = await requireCollection(c, 'read')
    if (access instanceof Response) return access
    const view = await viewFor(c, access)
    if (view instanceof Response) return view
    // ?records=<type> (empty: the first type) is a records page's one call: the
    // version, a page of that type's records, and only that type's schema.
    const pageType = c.req.query('records')
    const shown =
      pageType === undefined
        ? view.types
        : view.types.filter((t) => t.slug === (pageType || view.types[0]?.slug))
    const schemas: Record<string, unknown> = {}
    await Promise.all(
      shown.map(async (t) => (schemas[t.slug] = await view.repo.schema(t.schemaHash))),
    )
    const t = pageType === undefined ? null : (shown[0] ?? null)
    let recordsPage = null
    if (pageType !== undefined) {
      const limit = clamp(c.req.query('limit'), 100, 2000)
      const offset = Math.max(0, Number(c.req.query('offset') ?? 0) || 0)
      const records: (RecordEntry & { type: string })[] = []
      if (t) {
        for await (const e of typeRecords(view, t, { offset, bodies: true })) {
          records.push(e)
          if (records.length === limit) break
        }
      }
      recordsPage = {
        type: t?.slug ?? null,
        records: records.map(recordJson),
        total: t?.count ?? 0,
      }
    }
    return c.json({
      ...versionSummary(
        view.version,
        view.owner,
        await collectionArk(c.var.ports.db, access.collection.id, access.owner),
      ),
      metadata: view.root.metadata,
      typeCounts: Object.fromEntries(view.types.map((t) => [t.slug, t.count])),
      schemas,
      ...(recordsPage ? { recordsPage } : {}),
    })
  })

  app.get('/:owner/:slug/versions/:n/records', async (c) => {
    const access = await requireCollection(c, 'read')
    if (access instanceof Response) return access
    const view = await viewFor(c, access)
    if (view instanceof Response) return view
    const type = c.req.query('type')
    const limit = clamp(c.req.query('limit'), 100, 2000)
    const cursor = decodeCursor(c.req.query('cursor') ?? c.req.query('after'), type)
    const offset = cursor ? 0 : Math.max(0, Number(c.req.query('offset') ?? 0) || 0)
    let source: AsyncIterable<RecordEntry & { type: string }>
    let total: number
    if (type) {
      const t = view.types.find((x) => x.slug === type)
      if (!t)
        return c.json({
          records: [],
          pagination: { limit, hasMore: false, nextCursor: null, total: 0 },
        })
      total = t.count
      const opts: { after?: string; offset?: number; bodies: boolean } = { bodies: true }
      if (cursor) opts.after = cursor.k
      else opts.offset = offset
      source = typeRecords(view, t, opts)
    } else {
      total = view.types.reduce((n, t) => n + t.count, 0)
      source = allRecords(view, cursor, offset, true)
    }
    const page: (RecordEntry & { type: string })[] = []
    let hasMore = false
    for await (const e of source) {
      if (page.length === limit) {
        hasMore = true
        break
      }
      page.push(e)
    }
    const last = page[page.length - 1]
    return c.json({
      records: page.map(recordJson),
      pagination: {
        limit,
        hasMore,
        nextCursor: hasMore && last ? encodeCursor(last.type, last.key) : null,
        total,
      },
    })
  })

  /** One record by type and id, at a version (v1 had this only through ARK). */
  app.get('/:owner/:slug/versions/:n/records/:type/:id', async (c) => {
    const access = await requireCollection(c, 'read')
    if (access instanceof Response) return access
    const view = await viewFor(c, access)
    if (view instanceof Response) return view
    const t = view.types.find((x) => x.slug === c.req.param('type'))
    const rec = t ? await getRecord(view, t, c.req.param('id')) : null
    if (!rec) return jsonError(c, 404, 'Record not found')
    return c.json({ ...recordJson(rec), semver: view.version.semver })
  })

  /**
   * A record's history in this collection: every version where it was added,
   * changed or removed, oldest first, in the sets the caller may read. One
   * lookup per version, O(versions × tree height); the newest MAX_HISTORY versions.
   */
  app.get('/:owner/:slug/records/:type/:id/history', async (c) => {
    const access = await requireCollection(c, 'read')
    if (access instanceof Response) return access
    const { db } = c.var.ports
    const versions = (
      await db
        .select()
        .from(schema.versions)
        .where(eq(schema.versions.collectionId, access.collection.id))
        .orderBy(desc(schema.versions.seq))
        .limit(MAX_HISTORY)
    ).reverse()
    const repo = await c.var.ports.stores.forCollection(access.collection.id)
    const withheld = await deniedHashes(db)
    const source = new RepoSource(recordTree, repo)
    const type = c.req.param('type')
    const id = c.req.param('id')
    const changes: {
      seq: number
      semver: string
      createdAt: Date
      change: 'added' | 'updated' | 'removed'
      hash: string | null
    }[] = []
    let last: string | null = null
    // Consecutive versions share most of the path to the record: a node seen
    // before gives the same answer, so a lookup stops at the first shared node.
    const memo = new Map<string, RecordEntry | null>()
    for (const v of versions) {
      const view = await loadView(repo, v, access.isMember, withheld)
      const t = view.types.find((x) => x.slug === type)
      let hash: string | null = null
      for (const tree of [t?.public, t?.private]) {
        if (!tree?.root) continue
        const hit = await lookupShared(source, tree.root, id, memo)
        if (hit) hash = hit.hash
      }
      if (hash === last) continue
      changes.push({
        seq: v.seq,
        semver: v.semver,
        createdAt: v.createdAt,
        change: hash === null ? 'removed' : last === null ? 'added' : 'updated',
        hash,
      })
      last = hash
    }
    if (changes.length === 0) return jsonError(c, 404, 'Record not found')
    return c.json({ type, id, changes, truncated: versions.length === MAX_HISTORY })
  })

  /**
   * A type's public records as one gzip file: the stored leaf bodies concatenated
   * (gzip allows several members), so a public read is copied, not re-encoded.
   * Lines are canonical records, `{"id":…,"type":…,"data":…}`, without the
   * `hash` records.ndjson adds (it's the SHA-256 of the line). Only the public
   * set: a member's private records interleave by id, so they need records.ndjson.
   * A leaf holding out-of-line or blocked records is re-encoded. Some gzip readers
   * (browsers' DecompressionStream) stop after the first member.
   */
  app.get('/:owner/:slug/versions/:n/records.ndjson.gz', async (c) => {
    const access = await requireCollection(c, 'read')
    if (access instanceof Response) return access
    const view = await viewFor(c, access)
    if (view instanceof Response) return view
    const want = c.req.query('type')
    const types = view.types.filter((t) => t.public?.root && (!want || t.slug === want))
    if (want && types.length === 0) return jsonError(c, 404, `No public records of type ${want}`)
    const source = new RepoSource(recordTree, view.repo)
    const body = new ReadableStream<Uint8Array>({
      async start(ctl) {
        try {
          for (const t of types) {
            for await (const leaf of leaves(source, t.public!.root)) {
              const node = await source.node(leaf.hash)
              const entries = (node.kind === 'leaf' ? node.entries : []) as RecordEntry[]
              const plain = entries.every(
                (e) => e.size <= OUT_OF_LINE_BYTES && !view.withheld.has(e.hash),
              )
              // Billed as the NDJSON it decompresses to: a line and a newline per record.
              c.var.meter.logicalBytes =
                (c.var.meter.logicalBytes ?? 0) +
                entries.reduce((n, e) => (view.withheld.has(e.hash) ? n : n + e.size + 1), 0)
              if (plain) {
                ctl.enqueue(await view.repo.rawBody(leaf.hash))
                continue
              }
              const lines = (await view.repo.bodyLines({ hash: leaf.hash, entries })).filter(
                (_, i) => !view.withheld.has(entries[i]!.hash),
              )
              if (lines.length) ctl.enqueue(await gzip(lines.join('\n') + '\n'))
            }
          }
          ctl.close()
        } catch (err) {
          ctl.error(err)
        }
      },
    })
    return new Response(body, {
      headers: {
        'content-type': 'application/gzip',
        'content-disposition': `attachment; filename="${access.owner.slug}-${access.collection.slug}-${view.version.semver}${want ? `-${want}` : ''}.ndjson.gz"`,
      },
    })
  })

  app.get('/:owner/:slug/versions/:n/records.ndjson', async (c) => {
    const access = await requireCollection(c, 'read')
    if (access instanceof Response) return access
    const view = await viewFor(c, access)
    if (view instanceof Response) return view
    const type = c.req.query('type')
    const after = c.req.query('after')
    const types = type ? view.types.filter((t) => t.slug === type) : view.types
    const count = types.reduce((n, t) => n + t.count, 0)
    const enc = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for (const t of types) {
            const opts = after && type ? { after, bodies: true } : { bodies: true }
            let batch: string[] = []
            for await (const e of typeRecords(view, t, opts)) {
              batch.push(withHash(e.body!, e.hash))
              if (batch.length >= 512) {
                controller.enqueue(enc.encode(batch.join('\n') + '\n'))
                batch = []
              }
            }
            if (batch.length) controller.enqueue(enc.encode(batch.join('\n') + '\n'))
          }
          controller.close()
        } catch (err) {
          controller.error(err)
        }
      },
    })
    return new Response(stream, {
      headers: { 'content-type': 'application/x-ndjson', 'x-underlay-record-count': String(count) },
    })
  })

  app.get('/:owner/:slug/versions/:n/manifest', async (c) => {
    const access = await requireCollection(c, 'read')
    if (access instanceof Response) return access
    const view = await viewFor(c, access)
    if (view instanceof Response) return view
    // Pages and the file list are bounded for a 128 MB isolate: tens of MB of JSON otherwise.
    const limit = clamp(c.req.query('limit'), 10_000, MANIFEST_MAX)
    const cursor = decodeCursor(c.req.query('cursor'), undefined)
    const schemas = Object.fromEntries(view.types.map((t) => [t.slug, t.schemaHash]))
    const since = c.req.query('since')
    const fileList = async () => {
      if (cursor) return {}
      const files = await visibleFiles(view, MANIFEST_MAX + 1)
      return files.length > MANIFEST_MAX
        ? { files: files.slice(0, MANIFEST_MAX), filesTruncated: true }
        : { files }
    }

    if (since) {
      const from = await findVersion(c.var.ports.db, access.collection.id, since, null)
      if (!from) return jsonError(c, 404, `Version ${since} not found`)
      const fromView = await loadView(view.repo, from, view.owner, view.withheld)
      const delta = { added: [] as object[], updated: [] as object[], removed: [] as object[] }
      let n = 0
      let next: string | null = null
      let last: { type: string; key: string } | null = null
      for await (const d of diffAll(fromView, view, cursor)) {
        // Resuming skips up to and including the cursor: it names the last entry returned.
        if (n === limit) {
          next = encodeCursor(last!.type, last!.key)
          break
        }
        n++
        last = d
        if (!d.before) delta.added.push({ id: d.key, type: d.type, hash: d.after!.hash })
        else if (!d.after) delta.removed.push({ id: d.key, type: d.type, hash: d.before.hash })
        else
          delta.updated.push({
            id: d.key,
            type: d.type,
            hash: d.after.hash,
            previousHash: d.before.hash,
          })
      }
      return c.json({
        semver: view.version.semver,
        hash: view.version.hash,
        since: from.semver,
        schemas,
        delta,
        // The file list rides on the first page only, as for a full manifest.
        files: [],
        ...(await fileList()),
        pagination: { limit, hasMore: next !== null, nextCursor: next },
      })
    }

    const records: object[] = []
    let next: string | null = null
    // Nodes only: ids and hashes, no bodies.
    // Resuming starts after the cursor, so it names the last entry returned.
    for await (const e of allRecords(view, cursor, 0, false)) {
      if (records.length === limit) {
        const last = records[records.length - 1] as { id: string; type: string }
        next = encodeCursor(last.type, last.id)
        break
      }
      records.push({
        id: e.key,
        type: e.type,
        hash: e.hash,
        ...(e.set === 'private' ? { private: true } : {}),
      })
    }
    return c.json({
      semver: view.version.semver,
      hash: view.version.hash,
      schemas,
      records,
      files: [],
      ...(await fileList()),
      pagination: { limit, hasMore: next !== null, nextCursor: next },
    })
  })

  app.get('/:owner/:slug/versions/:n/diff', async (c) => {
    const access = await requireCollection(c, 'read')
    if (access instanceof Response) return access
    const view = await viewFor(c, access)
    if (view instanceof Response) return view
    const limit = clamp(c.req.query('limit'), 500, 5000)
    const cursor = decodeCursor(c.req.query('cursor'), undefined)
    const fromParam = c.req.query('from')
    const from = fromParam
      ? await findVersion(c.var.ports.db, access.collection.id, fromParam, null)
      : null
    if (fromParam && !from) return jsonError(c, 404, `Version ${fromParam} not found`)
    const fromView = from ? await loadView(view.repo, from, view.owner, view.withheld) : null
    const added: object[] = []
    const updated: object[] = []
    const removed: string[] = []
    let n = 0
    let next: string | null = null
    let last: { type: string; key: string } | null = null
    const body = async (side: VersionView, d: { type: string; key: string }) => {
      const t = side.types.find((x) => x.slug === d.type)!
      const r = await getRecord(side, t, d.key)
      return { id: d.key, type: d.type, data: (JSON.parse(r!.body!) as { data: unknown }).data }
    }
    const page: TypedDiff[] = []
    for await (const d of diffAll(fromView, view, cursor)) {
      if (n === limit) {
        next = encodeCursor(last!.type, last!.key)
        break
      }
      n++
      last = d
      page.push(d)
    }
    // A page's bodies are read BODY_READS at a time, not one after another.
    const bodies = await mapConcurrent(page, BODY_READS, (d) =>
      d.after ? body(view, d) : Promise.resolve(null),
    )
    page.forEach((d, i) => {
      if (!d.before) added.push(bodies[i]!)
      else if (!d.after) removed.push(d.key)
      else updated.push(bodies[i]!)
    })
    const schemaChanged =
      !fromView ||
      JSON.stringify(fromView.types.map((t) => [t.slug, t.schemaHash])) !==
        JSON.stringify(view.types.map((t) => [t.slug, t.schemaHash]))
    // File counts re-diff both file trees: on the first page only, not every page.
    const fileDelta =
      fromView && !cursor ? await fileCounts(fromView, view) : { added: 0, removed: 0 }
    return c.json({
      from: from?.semver ?? null,
      to: view.version.semver,
      added,
      updated,
      removed,
      pagination: { limit, hasMore: next !== null, nextCursor: next },
      meta: {
        schemaChanged,
        metadataChanged:
          JSON.stringify(fromView?.root.metadata ?? null) !== JSON.stringify(view.root.metadata),
        filesAdded: fileDelta.added,
        filesRemoved: fileDelta.removed,
      },
    })
  })

  app.get('/:owner/:slug/versions/:n/files', async (c) => {
    const access = await requireCollection(c, 'read')
    if (access instanceof Response) return access
    const view = await viewFor(c, access)
    if (view instanceof Response) return view
    const hashes = await visibleFiles(view, 10_000)
    const rows = []
    for (const part of chunks(hashes, JSON_CHUNK)) {
      rows.push(
        ...(await c.var.ports.db
          .select()
          .from(schema.files)
          .where(inJson(schema.files.hash, part))),
      )
    }
    const byHash = new Map(rows.map((r) => [r.hash, r]))
    // Which records reference a file isn't indexed in v2 (it would take a scan of
    // every body); how many do is, in each set's count tree. A caller who reads
    // only the public set sees only public references, as in v1.
    // Only the listed hashes' range of each count tree, not the whole tree.
    const range = hashes.length ? { from: hashes[0]!, through: hashes.at(-1)! } : undefined
    const counts = range
      ? await referenceCounts(view.repo, view.version.publicRefsRoot, range)
      : new Map<string, number>()
    if (view.private && range) {
      for (const [h, n] of await referenceCounts(view.repo, view.version.privateRefsRoot, range))
        counts.set(h, (counts.get(h) ?? 0) + n)
    }
    return c.json(
      hashes.map((h) => ({
        hash: h,
        size: byHash.get(h)?.size ?? null,
        mimeType: byHash.get(h)?.mimeType ?? null,
        createdAt: byHash.get(h)?.createdAt ?? null,
        referenceCount: counts.get(h) ?? 0,
        references: [],
      })),
    )
  })

  return app
}

/** Most manifest records per page, and files in its list (underlay.org's caps; spec 11.3). */
const MANIFEST_MAX = 25_000

/**
 * A key's entry in a record tree, remembering the answer for every node on the
 * path: a later lookup that reaches a node already seen (an unchanged subtree)
 * stops there.
 */
async function lookupShared(
  source: RepoSource<RecordEntry>,
  root: string,
  key: string,
  memo: Map<string, RecordEntry | null>,
): Promise<RecordEntry | null> {
  const path: string[] = []
  let at: string | null = root
  let found: RecordEntry | null = null
  while (at !== null) {
    const known = memo.get(at)
    if (known !== undefined) {
      found = known
      break
    }
    path.push(at)
    const node = await source.node(at)
    if (node.kind === 'leaf') {
      found = (node.entries as RecordEntry[]).find((e) => e.key === key) ?? null
      break
    }
    at = node.children.find((ch) => compareUtf8(key, ch.lastKey) <= 0)?.hash ?? null
  }
  for (const h of path) memo.set(h, found)
  return found
}

/** Versions a record history looks back over. */
const MAX_HISTORY = 500

/** Concurrent body reads per diff page. */
const BODY_READS = 16

/** `f` over `items`, at most `limit` at a time, results in order. */
async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  f: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await f(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/** File hashes in the sets this view may read (deduplicated, sorted). */
async function visibleFiles(view: VersionView, max: number): Promise<string[]> {
  const source = new RepoSource(fileTree, view.repo)
  const roots = [view.public.files.root, view.private?.files.root ?? null]
  const out = new Set<string>()
  for (const r of roots) {
    for await (const f of iterate(source, r)) {
      out.add(f.key)
      if (out.size >= max) break
    }
  }
  return [...out].sort()
}

async function fileCounts(a: VersionView, b: VersionView) {
  const source = new RepoSource(fileTree, b.repo)
  let added = 0
  let removed = 0
  for (const [x, y] of [
    [a.public.files.root, b.public.files.root],
    [a.private?.files.root ?? null, b.private?.files.root ?? null],
  ] as const) {
    for await (const d of diffTrees(source, x, y)) {
      if (!d.before) added++
      else if (!d.after) removed++
    }
  }
  return { added, removed }
}

type TypedDiff = {
  type: string
  key: string
  before: RecordEntry | null
  after: RecordEntry | null
}

/**
 * Differences between two views, by (type, id), resuming after a cursor. A
 * record moving between sets with the same hash isn't a change to a reader who
 * sees both; to a public reader it appears or disappears.
 */
async function* diffAll(
  from: VersionView | null,
  to: VersionView,
  cursor: { t: string; k: string } | null,
): AsyncGenerator<TypedDiff> {
  const source = new RepoSource(recordTree, to.repo)
  // A change to a blocked record (the denylist) isn't served.
  const shown = (d: TypedDiff) => !(d.after && to.withheld.has(d.after.hash))
  const slugs = new Set([...(from?.types.map((t) => t.slug) ?? []), ...to.types.map((t) => t.slug)])
  for (const slug of [...slugs].sort(compareUtf8)) {
    if (cursor && compareUtf8(slug, cursor.t) < 0) continue
    const a = from?.types.find((t) => t.slug === slug)
    const b = to.types.find((t) => t.slug === slug)
    // Each set's diff resumes past the cursor, and the two are joined in key
    // order as they stream: memory is O(1) per type and a page costs that page.
    const after = cursor && slug === cursor.t ? { after: cursor.k } : {}
    const side = (set: 'public' | 'private') =>
      set === 'private' && !to.owner
        ? null
        : diffTrees(source, a?.[set]?.root ?? null, b?.[set]?.root ?? null, after)[
            Symbol.asyncIterator
          ]()
    const pub = side('public')
    const priv = side('private')
    let x = pub ? await pub.next() : null
    let y = priv ? await priv.next() : null
    const live = (r: IteratorResult<DiffEntry<RecordEntry>> | null) =>
      r && !r.done ? r.value : null
    for (;;) {
      const p = live(x)
      const q = live(y)
      if (!p && !q) break
      const order = p && q ? compareUtf8(p.key, q.key) : p ? -1 : 1
      if (order < 0) {
        const d = { type: slug, key: p!.key, before: p!.before, after: p!.after }
        if (shown(d)) yield d
        x = await pub!.next()
      } else if (order > 0) {
        const d = { type: slug, key: q!.key, before: q!.before, after: q!.after }
        if (shown(d)) yield d
        y = await priv!.next()
      } else {
        // The same id changed in both sets: a move. Combine the halves; one
        // that keeps its hash isn't a change to a reader of both sets.
        const before = p!.before ?? q!.before
        const after_ = p!.after ?? q!.after
        const d = { type: slug, key: p!.key, before, after: after_ }
        if (!(before && after_ && before.hash === after_.hash) && shown(d)) yield d
        x = await pub!.next()
        y = await priv!.next()
      }
    }
  }
}
