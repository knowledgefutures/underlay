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
  diffTrees,
  fileTree,
  iterate,
  type RecordEntry,
  recordTree,
} from '@underlay/core'
import { RepoSource } from '@underlay/repo'
import { desc, eq, inArray } from 'drizzle-orm'
import { type Context, Hono } from 'hono'

import type { AppEnv } from '../app.js'
import * as schema from '../db/schema.js'
import {
  findVersion,
  getRecord,
  loadView,
  type TypeView,
  typeRecords,
  type VersionView,
} from '../versions/view.js'
import { type CollectionAccess, jsonError, requireCollection } from './access.js'
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
  return loadView(repo, v, access.isMember)
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

export function versionRoutes() {
  const app = new Hono<AppEnv>()

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
    return c.json(rows.map((v) => versionSummary(v, access.isMember)))
  })

  app.get('/:owner/:slug/versions/:n', async (c) => {
    const access = await requireCollection(c, 'read')
    if (access instanceof Response) return access
    const view = await viewFor(c, access)
    if (view instanceof Response) return view
    const schemas: Record<string, unknown> = {}
    await Promise.all(
      view.types.map(async (t) => (schemas[t.slug] = await view.repo.schema(t.schemaHash))),
    )
    return c.json({
      ...versionSummary(view.version, view.owner),
      metadata: view.root.metadata,
      typeCounts: Object.fromEntries(view.types.map((t) => [t.slug, t.count])),
      schemas,
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
    const limit = clamp(c.req.query('limit'), 10_000, 100_000)
    const cursor = decodeCursor(c.req.query('cursor'), undefined)
    const schemas = Object.fromEntries(view.types.map((t) => [t.slug, t.schemaHash]))
    const since = c.req.query('since')

    if (since) {
      const from = await findVersion(c.var.ports.db, access.collection.id, since, null)
      if (!from) return jsonError(c, 404, `Version ${since} not found`)
      const fromView = await loadView(view.repo, from, view.owner)
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
        files: await visibleFiles(view, 100_000),
        pagination: { limit, hasMore: next !== null, nextCursor: next },
        truncated: next !== null,
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
      files: cursor ? [] : await visibleFiles(view, 100_000),
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
    const fromView = from ? await loadView(view.repo, from, view.owner) : null
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
    for await (const d of diffAll(fromView, view, cursor)) {
      if (n === limit) {
        next = encodeCursor(last!.type, last!.key)
        break
      }
      n++
      last = d
      if (!d.before) added.push(await body(view, d))
      else if (!d.after) removed.push(d.key)
      else updated.push(await body(view, d))
    }
    const schemaChanged =
      !fromView ||
      JSON.stringify(fromView.types.map((t) => [t.slug, t.schemaHash])) !==
        JSON.stringify(view.types.map((t) => [t.slug, t.schemaHash]))
    const fileDelta = fromView ? await fileCounts(fromView, view) : { added: 0, removed: 0 }
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
    const rows = hashes.length
      ? await c.var.ports.db.select().from(schema.files).where(inHashes(hashes))
      : []
    const byHash = new Map(rows.map((r) => [r.hash, r]))
    // References aren't indexed per file in v2; the listing returns none.
    return c.json(
      hashes.map((h) => ({
        hash: h,
        size: byHash.get(h)?.size ?? null,
        mimeType: byHash.get(h)?.mimeType ?? null,
        createdAt: byHash.get(h)?.createdAt ?? null,
        references: [],
      })),
    )
  })

  return app
}

const inHashes = (hashes: string[]) => inArray(schema.files.hash, hashes)

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
  const slugs = new Set([...(from?.types.map((t) => t.slug) ?? []), ...to.types.map((t) => t.slug)])
  for (const slug of [...slugs].sort(compareUtf8)) {
    if (cursor && compareUtf8(slug, cursor.t) < 0) continue
    const a = from?.types.find((t) => t.slug === slug)
    const b = to.types.find((t) => t.slug === slug)
    const changes = new Map<string, TypedDiff>()
    const collect = async (
      x: TypeView | undefined,
      y: TypeView | undefined,
      set: 'public' | 'private',
    ) => {
      const xr = x?.[set]?.root ?? null
      const yr = y?.[set]?.root ?? null
      if (set === 'private' && !to.owner) return
      for await (const d of diffTrees(source, xr, yr)) {
        const prev = changes.get(d.key)
        if (prev) {
          // The same id changed in both sets: a move. Combine the halves.
          const before = prev.before ?? d.before
          const after = prev.after ?? d.after
          if (before && after && before.hash === after.hash) changes.delete(d.key)
          else changes.set(d.key, { type: slug, key: d.key, before, after })
        } else {
          changes.set(d.key, { type: slug, key: d.key, before: d.before, after: d.after })
        }
      }
    }
    await collect(a, b, 'public')
    await collect(a, b, 'private')
    const keys = [...changes.keys()].sort(compareUtf8)
    for (const k of keys) {
      if (cursor && slug === cursor.t && compareUtf8(k, cursor.k) <= 0) continue
      yield changes.get(k)!
    }
  }
}
