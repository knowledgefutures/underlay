/**
 * Records and files by hash, through the reference log (v1 shapes).
 *
 *   GET  /api/records/:hash/provenance
 *   POST /api/records/batch                    {hashes} → NDJSON {id,type,data,hash}
 *   GET  /api/collections/files/:hash          302, from any collection the caller may read
 *
 * Results are filtered by the caller's access before anything is returned,
 * counts included (edge-redesign.md, Security notes): a presence counts only if
 * it is in a public collection's public set, or in a collection of the caller's
 * orgs.
 */
import { and, eq, gte, inArray, lt, lte, or, sql } from 'drizzle-orm'
import { type Context, Hono } from 'hono'

import type { AppEnv } from '../app.js'
import { meter } from '../billing/usage.js'
import { chunks } from '../db/chunks.js'
import * as schema from '../db/schema.js'
import { cleanHash, isHash, presignDownload } from '../files/files.js'
import { deniedHashes, isDenied } from '../lib/limits.js'
import { eventsFor, type Presence, presenceOf } from '../refs/log.js'
import { fileSizes } from '../versions/file-refs.js'
import { getRecord, loadView } from '../versions/view.js'
import { jsonError } from './access.js'

/** Hashes one batch request may ask for: each costs a few queries, and D1 allows 1,000. */
export const MAX_BATCH_HASHES = 100
/** Presences a provenance answer lists versions for. */
const MAX_PROVENANCE_PRESENCES = 300
/** Versions listed per collection in a provenance answer. */
const VERSIONS_PER_COLLECTION = 100

type Item = {
  p: Presence
  c: typeof schema.collections.$inferSelect
  owner: typeof schema.organization.$inferSelect
  member: boolean
}

async function memberOrgs(c: Context<AppEnv>): Promise<Set<string>> {
  const p = c.var.principal
  if (!p || p.collectionIds) return new Set()
  if (p.orgId) return new Set([p.orgId])
  const rows = await c.var.ports.db
    .select({ id: schema.member.organizationId })
    .from(schema.member)
    .where(eq(schema.member.userId, p.userId))
  return new Set(rows.map((r) => r.id))
}

/**
 * Presences the caller may see, with their collections. `orgs` is the caller's
 * orgs, looked up once per request; `cols` caches collection rows across hashes.
 */
async function visiblePresence(
  c: Context<AppEnv>,
  hash: string,
  orgs: Set<string>,
  cols = new Map<string, { c: Item['c']; owner: Item['owner'] }>(),
) {
  const { db } = c.var.ports
  const presence = await presenceOf(c.var.ports, hash)
  const missing = [...new Set(presence.map((p) => p.collectionId))].filter((id) => !cols.has(id))
  for (const part of chunks(missing)) {
    const rows = await db
      .select({ c: schema.collections, owner: schema.organization })
      .from(schema.collections)
      .innerJoin(schema.organization, eq(schema.organization.id, schema.collections.organizationId))
      .where(inArray(schema.collections.id, part))
    for (const r of rows) cols.set(r.c.id, r)
  }
  const items: Item[] = presence.flatMap((p) => {
    const col = cols.get(p.collectionId)
    if (!col) return []
    const member = orgs.has(col.c.organizationId)
    const visible = member || (col.c.public && p.set === 'public')
    return visible ? [{ p, c: col.c, owner: col.owner, member }] : []
  })
  return items
}

/**
 * The versions each presence covers, up to VERSIONS_PER_COLLECTION per
 * collection: one query per 30 presences (3 bound parameters each), not one per
 * presence.
 */
async function versionsOf(c: Context<AppEnv>, items: Item[]) {
  const { db } = c.var.ports
  const v = schema.versions
  const out: { collectionId: string; semver: string; createdAt: Date }[] = []
  for (const part of chunks(items.slice(0, MAX_PROVENANCE_PRESENCES), 30)) {
    const rn = sql<number>`row_number() OVER (PARTITION BY ${v.collectionId} ORDER BY ${v.seq})`.as(
      'rn',
    )
    const sub = db
      .select({ collectionId: v.collectionId, semver: v.semver, createdAt: v.createdAt, rn })
      .from(v)
      .where(
        or(
          ...part.map((i) =>
            and(
              eq(v.collectionId, i.c.id),
              gte(v.seq, i.p.from),
              i.p.to === null ? undefined : lt(v.seq, i.p.to),
            ),
          ),
        ),
      )
      .as('sub')
    out.push(
      ...(await db
        .select({ collectionId: sub.collectionId, semver: sub.semver, createdAt: sub.createdAt })
        .from(sub)
        .where(lte(sub.rn, VERSIONS_PER_COLLECTION))),
    )
  }
  return out
}

/**
 * The record body at a version where it was present, only if it is the record
 * asked for: the log can lag the head, and an id can hold another record there.
 */
async function bodyAt(
  c: Context<AppEnv>,
  item: { p: Presence; c: typeof schema.collections.$inferSelect; member: boolean },
  hash: string,
) {
  const seq = item.p.to === null ? null : item.p.to - 1
  const [v] =
    seq === null
      ? await c.var.ports.db
          .select()
          .from(schema.versions)
          .where(eq(schema.versions.id, item.c.headVersionId ?? ''))
      : await c.var.ports.db
          .select()
          .from(schema.versions)
          .where(and(eq(schema.versions.collectionId, item.c.id), eq(schema.versions.seq, seq)))
  if (!v) return null
  const repo = await c.var.ports.stores.forCollection(item.c.id)
  const view = await loadView(repo, v, item.member, await deniedHashes(c.var.ports.db))
  const t = view.types.find((x) => x.slug === item.p.type)
  const rec = t ? await getRecord(view, t, item.p.id) : null
  return rec?.hash === hash ? rec : null
}

/** The body from the first of these presences that still has it. */
async function firstBody(c: Context<AppEnv>, items: Item[], hash: string) {
  for (const item of items) {
    const rec = await bodyAt(c, item, hash)
    if (rec) return rec
  }
  return null
}

export function recordRoutes() {
  const app = new Hono<AppEnv>()

  app.get('/api/records/:hash/provenance', async (c) => {
    const hash = c.req.param('hash').replace(/^sha256:/, '')
    const items = await visiblePresence(c, hash, await memberOrgs(c))
    const records = items.filter((i) => i.p.kind === 'r')
    if (records.length === 0) return jsonError(c, 404, 'Record not found')
    const rec = await firstBody(c, records, hash)
    if (!rec) return jsonError(c, 404, 'Record not found')
    const parsed = JSON.parse(rec.body!) as { id: string; type: string; data: unknown }
    const byId = new Map(records.map((i) => [i.c.id, i]))
    const seen = new Set<string>()
    const references: {
      owner: string
      collection: string
      collectionName: string
      semver: string
      versionCreatedAt: Date
    }[] = []
    for (const v of await versionsOf(c, records)) {
      // A collection can hold the record in both sets at once (a move between them).
      const key = `${v.collectionId}\u0000${v.semver}`
      if (seen.has(key)) continue
      seen.add(key)
      const i = byId.get(v.collectionId)!
      references.push({
        owner: i.owner.slug,
        collection: i.c.slug,
        collectionName: i.c.name,
        semver: v.semver,
        versionCreatedAt: v.createdAt,
      })
    }
    references.sort((a, b) => a.versionCreatedAt.getTime() - b.versionCreatedAt.getTime())
    return c.json({
      hash,
      recordHash: hash,
      recordId: parsed.id,
      type: parsed.type,
      data: parsed.data,
      size: rec.size,
      firstSeen: references[0]?.versionCreatedAt ?? null,
      createdAt: references[0]?.versionCreatedAt ?? null,
      references,
    })
  })

  /**
   * Where a record or file first appeared, among the collections the caller may
   * read: the earliest "+" event (edge-redesign.md, Provenance: the cheap
   * answer most callers want). It reads only that hash's events and the versions
   * they name, with no interval folding or fork expansion.
   */
  app.get('/api/records/:hash/first', async (c) => {
    const hash = c.req.param('hash').replace(/^sha256:/, '')
    const { db } = c.var.ports
    const adds = (await eventsFor(c.var.ports, hash)).filter((e) => e[5] === '+')
    if (adds.length === 0) return jsonError(c, 404, 'Not found')
    const orgs = await memberOrgs(c)
    const cols = new Map<string, { c: Item['c']; owner: Item['owner'] }>()
    for (const part of chunks([...new Set(adds.map((e) => e[2]))])) {
      const rows = await db
        .select({ c: schema.collections, owner: schema.organization })
        .from(schema.collections)
        .innerJoin(
          schema.organization,
          eq(schema.organization.id, schema.collections.organizationId),
        )
        .where(inArray(schema.collections.id, part))
      for (const r of rows) cols.set(r.c.id, r)
    }
    const visible = adds.filter((e) => {
      const col = cols.get(e[2])
      return !!col && (orgs.has(col.c.organizationId) || (col.c.public && e[3] === 'public'))
    })
    // The earliest of the versions the visible additions name, in one query.
    if (visible.length === 0) return jsonError(c, 404, 'Not found')
    const pairs = JSON.stringify(visible.map((e) => [e[2], e[4]]))
    const [earliest] = (await db.all(sql`
      SELECT v.id AS id FROM ${schema.versions} v
      JOIN json_each(${pairs}) p
        ON v.collection_id = json_extract(p.value, '$[0]') AND v.seq = json_extract(p.value, '$[1]')
      ORDER BY v.created_at, v.seq LIMIT 1
    `)) as { id: string }[]
    const [v] = earliest
      ? await db.select().from(schema.versions).where(eq(schema.versions.id, earliest.id))
      : []
    const e = v && visible.find((x) => x[2] === v.collectionId && x[4] === v.seq)
    const first = v && e ? { e, v } : null
    if (!first) return jsonError(c, 404, 'Not found')
    const col = cols.get(first.e[2])!
    return c.json({
      hash,
      kind: first.e[1] === 'r' ? 'record' : 'file',
      owner: col.owner.slug,
      collection: col.c.slug,
      semver: first.v.semver,
      createdAt: first.v.createdAt,
      ...(first.e[1] === 'r' ? { type: first.e[6], id: first.e[7] } : {}),
    })
  })

  app.post('/api/records/batch', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { hashes?: unknown } | null
    const hashes = Array.isArray(body?.hashes)
      ? body.hashes.filter((h): h is string => typeof h === 'string')
      : null
    if (!hashes || hashes.length === 0 || hashes.length > MAX_BATCH_HASHES)
      return jsonError(c, 400, `"hashes" must be 1–${MAX_BATCH_HASHES} record hashes`)
    const orgs = await memberOrgs(c)
    const cols = new Map<string, { c: Item['c']; owner: Item['owner'] }>()
    const lines: string[] = []
    for (const h of hashes) {
      const hash = h.replace(/^sha256:/, '')
      const items = await visiblePresence(c, hash, orgs, cols)
      const rec = await firstBody(
        c,
        items.filter((i) => i.p.kind === 'r'),
        hash,
      )
      if (rec) lines.push(`${rec.body!.slice(0, -1)},"hash":"${rec.hash}"}`)
    }
    return new Response(lines.length ? lines.join('\n') + '\n' : '', {
      headers: { 'content-type': 'application/x-ndjson' },
    })
  })

  app.get('/api/collections/files/:hash', async (c) => {
    const hash = cleanHash(c.req.param('hash'))
    if (!isHash(hash)) return jsonError(c, 404, 'File not found')
    const items = await visiblePresence(c, hash, await memberOrgs(c))
    const found = items.find((i) => i.p.kind === 'f')
    if (!found) return jsonError(c, 404, 'File not found')
    // After the access check: a 451 would confirm the file exists to anyone.
    if (await isDenied(c.var.ports.db, hash)) return jsonError(c, 451, 'This file is unavailable')
    const url = await presignDownload(c.var.ports, hash)
    if (!url) return jsonError(c, 404, 'File not found')
    // Billed to the first collection the caller may read it from.
    const on = { id: found.c.id, accountId: found.c.organizationId }
    const [size] = (await fileSizes(c.var.ports.db, [hash])).values()
    meter(c.var.meter, 'file_downloads', 1, on)
    meter(c.var.meter, 'file_bytes', size ?? 0, on)
    return c.redirect(url, 302)
  })

  return app
}
