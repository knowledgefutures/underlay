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
 * orgs. Format 1 record hashes resolve through legacy_hashes.
 */
import { and, asc, eq, gte, inArray, lt } from 'drizzle-orm'
import { type Context, Hono } from 'hono'

import type { AppEnv } from '../app.js'
import * as schema from '../db/schema.js'
import { presignDownload } from '../files/files.js'
import { type Presence, presenceOf } from '../refs/log.js'
import { getRecord, loadView } from '../versions/view.js'
import { jsonError } from './access.js'

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

/** Presences the caller may see, with their collections. */
async function visiblePresence(c: Context<AppEnv>, hash: string) {
  const { db } = c.var.ports
  const [alias] = await db
    .select()
    .from(schema.legacyHashes)
    .where(eq(schema.legacyHashes.legacyHash, hash))
  const target = alias?.hash ?? hash
  const presence = await presenceOf(c.var.ports, target)
  if (presence.length === 0)
    return {
      target,
      items: [] as {
        p: Presence
        c: typeof schema.collections.$inferSelect
        owner: typeof schema.organization.$inferSelect
        member: boolean
      }[],
    }
  const ids = [...new Set(presence.map((p) => p.collectionId))]
  const cols = await db
    .select({ c: schema.collections, owner: schema.organization })
    .from(schema.collections)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.collections.organizationId))
    .where(inArray(schema.collections.id, ids))
  const orgs = await memberOrgs(c)
  const items = presence.flatMap((p) => {
    const col = cols.find((x) => x.c.id === p.collectionId)
    if (!col) return []
    const member = orgs.has(col.c.organizationId)
    const visible = member || (col.c.public && p.set === 'public')
    return visible ? [{ p, c: col.c, owner: col.owner, member }] : []
  })
  return { target, items }
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
  const view = await loadView(repo, v, item.member)
  const t = view.types.find((x) => x.slug === item.p.type)
  const rec = t ? await getRecord(view, t, item.p.id) : null
  return rec?.hash === hash ? rec : null
}

/** The body from the first of these presences that still has it. */
async function firstBody(
  c: Context<AppEnv>,
  items: { p: Presence; c: typeof schema.collections.$inferSelect; member: boolean }[],
  hash: string,
) {
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
    const { target, items } = await visiblePresence(c, hash)
    const records = items.filter((i) => i.p.kind === 'r')
    if (records.length === 0) return jsonError(c, 404, 'Record not found')
    const rec = await firstBody(c, records, target)
    if (!rec) return jsonError(c, 404, 'Record not found')
    const parsed = JSON.parse(rec.body!) as { id: string; type: string; data: unknown }
    const { db } = c.var.ports
    const references: {
      owner: string
      collection: string
      collectionName: string
      semver: string
      versionCreatedAt: Date
    }[] = []
    for (const i of records) {
      const versions = await db
        .select({ semver: schema.versions.semver, createdAt: schema.versions.createdAt })
        .from(schema.versions)
        .where(
          and(
            eq(schema.versions.collectionId, i.c.id),
            gte(schema.versions.seq, i.p.from),
            i.p.to === null ? undefined : lt(schema.versions.seq, i.p.to),
          ),
        )
        .orderBy(asc(schema.versions.seq))
        .limit(100)
      for (const v of versions) {
        references.push({
          owner: i.owner.slug,
          collection: i.c.slug,
          collectionName: i.c.name,
          semver: v.semver,
          versionCreatedAt: v.createdAt,
        })
      }
    }
    references.sort((a, b) => a.versionCreatedAt.getTime() - b.versionCreatedAt.getTime())
    return c.json({
      hash,
      recordHash: target,
      recordId: parsed.id,
      type: parsed.type,
      data: parsed.data,
      size: rec.size,
      firstSeen: references[0]?.versionCreatedAt ?? null,
      createdAt: references[0]?.versionCreatedAt ?? null,
      references,
    })
  })

  app.post('/api/records/batch', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { hashes?: unknown } | null
    const hashes = Array.isArray(body?.hashes)
      ? body.hashes.filter((h): h is string => typeof h === 'string')
      : null
    if (!hashes || hashes.length === 0 || hashes.length > 10_000)
      return jsonError(c, 400, '"hashes" must be 1–10,000 record hashes')
    const lines: string[] = []
    for (const h of hashes) {
      const { target, items } = await visiblePresence(c, h.replace(/^sha256:/, ''))
      const rec = await firstBody(
        c,
        items.filter((i) => i.p.kind === 'r'),
        target,
      )
      if (rec) lines.push(`${rec.body!.slice(0, -1)},"hash":"${rec.hash}"}`)
    }
    return new Response(lines.length ? lines.join('\n') + '\n' : '', {
      headers: { 'content-type': 'application/x-ndjson' },
    })
  })

  app.get('/api/collections/files/:hash', async (c) => {
    const hash = c.req.param('hash').replace(/^sha256:/, '')
    const { items } = await visiblePresence(c, hash)
    if (!items.some((i) => i.p.kind === 'f')) return jsonError(c, 404, 'File not found')
    const url = await presignDownload(c.var.ports, hash)
    return url ? c.redirect(url, 302) : jsonError(c, 404, 'File not found')
  })

  return app
}
