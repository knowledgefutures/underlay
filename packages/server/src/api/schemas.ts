/**
 * Schema reads and labels (v1 shapes, with the schema hash as the id).
 *
 *   GET    /api/collections/:owner/:slug/schemas?version&raw
 *   GET    /api/schemas?label|slug|schema_hash|q&limit&offset
 *   GET    /api/schemas/:id                       id = schema hash
 *   POST   /api/schemas/:id/labels                {label}
 *   DELETE /api/schemas/:id/labels/:label         admin keys only
 *
 * Visibility comes from schema_usage: a schema is visible when it is used in
 * the public set of a public collection, or by a collection in one of the
 * caller's orgs. `q` matches labels and type slugs; schema bodies live in the
 * repository, not SQLite, so there is no full-text search over them.
 */
import { and, desc, eq, inArray, isNull, or, type SQL, sql } from 'drizzle-orm'
import { type Context, Hono } from 'hono'

import type { AppEnv } from '../app.js'
import { chunks } from '../db/chunks.js'
import * as schema from '../db/schema.js'
import { findVersion, loadView } from '../versions/view.js'
import { jsonError, requireCollection } from './access.js'

const MAX_LABEL_LENGTH = 100

/**
 * The caller's orgs as a SQL subquery (null for none). A subquery rather than a
 * list: D1 binds at most 100 parameters, and a user can belong to more orgs.
 */
function callerOrgs(c: Context<AppEnv>): SQL | null {
  const p = c.var.principal
  if (!p || p.collectionIds) return null
  if (p.orgId) return sql`(${p.orgId})`
  return sql`(SELECT ${schema.member.organizationId} FROM ${schema.member} WHERE ${schema.member.userId} = ${p.userId})`
}

/** A SQL condition: this schema hash is visible to the caller. */
function visibleSchema(hashCol: unknown, orgs: SQL | null) {
  return sql`EXISTS (
    SELECT 1 FROM ${schema.schemaUsage} u
    JOIN ${schema.collections} c ON c.id = u.collection_id
    WHERE u.schema_hash = ${hashCol}
      AND ((c.public = 1 AND u."set" = 'public')
        ${orgs ? sql`OR c.organization_id IN ${orgs}` : sql``})
  )`
}

async function labelsFor(c: Context<AppEnv>, hashes: string[]) {
  if (hashes.length === 0) return new Map<string, { label: string; createdAt: Date }[]>()
  const rows = []
  for (const part of chunks(hashes)) {
    rows.push(
      ...(await c.var.ports.db
        .select()
        .from(schema.schemaLabels)
        .where(inArray(schema.schemaLabels.schemaHash, part))),
    )
  }
  const out = new Map<string, { label: string; createdAt: Date }[]>()
  for (const r of rows) {
    if (!out.has(r.schemaHash)) out.set(r.schemaHash, [])
    out.get(r.schemaHash)!.push({ label: r.label, createdAt: r.createdAt })
  }
  return out
}

/** Schema bodies come from a repository that holds them: any collection using the schema. */
async function schemaBody(
  c: Context<AppEnv>,
  hash: string,
): Promise<Record<string, unknown> | null> {
  const [u] = await c.var.ports.db
    .select({ collectionId: schema.schemaUsage.collectionId })
    .from(schema.schemaUsage)
    .where(eq(schema.schemaUsage.schemaHash, hash))
    .limit(1)
  if (!u) return null
  const repo = await c.var.ports.stores.forCollection(u.collectionId)
  return repo.schema(hash)
}

export function schemaRoutes() {
  const app = new Hono<AppEnv>()

  app.get('/api/collections/:owner/:slug/schemas', async (c) => {
    const access = await requireCollection(c, 'read')
    if (access instanceof Response) return access
    const v = await findVersion(
      c.var.ports.db,
      access.collection.id,
      c.req.query('version') ?? 'latest',
      access.collection.headVersionId,
    )
    if (!v) return jsonError(c, 404, 'No versions found')
    const repo = await c.var.ports.stores.forCollection(access.collection.id)
    const view = await loadView(repo, v, access.isMember)
    const raw = c.req.query('raw') === 'true'
    const labels = raw
      ? new Map()
      : await labelsFor(
          c,
          view.types.map((t) => t.schemaHash),
        )
    const schemas = await Promise.all(
      view.types.map(async (t) => {
        const body = await repo.schema(t.schemaHash)
        const l = labels.get(t.schemaHash)
        return {
          slug: t.slug,
          schemaId: t.schemaHash,
          schemaHash: t.schemaHash,
          schema: l?.length
            ? { ...body, 'x-underlay-labels': l.map((x: { label: string }) => x.label) }
            : body,
        }
      }),
    )
    return c.json({ version: v.semver, semver: v.semver, schemas })
  })

  app.get('/api/schemas', async (c) => {
    const orgs = callerOrgs(c)
    const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 50) || 50))
    const offset = Math.max(0, Number(c.req.query('offset') ?? 0) || 0)
    const { db } = c.var.ports
    const one = c.req.query('schema_hash')
    if (one) {
      const [row] = await db
        .select()
        .from(schema.schemas)
        .where(and(eq(schema.schemas.hash, one), visibleSchema(schema.schemas.hash, orgs)))
      if (!row) return jsonError(c, 404, 'Schema not found')
      const [usage] = await db
        .select({ n: sql<number>`count(DISTINCT collection_id)` })
        .from(schema.schemaUsage)
        .where(eq(schema.schemaUsage.schemaHash, one))
      const labels = (await labelsFor(c, [one])).get(one) ?? []
      return c.json({
        id: one,
        schemaHash: one,
        schema: await schemaBody(c, one),
        createdAt: row.createdAt,
        labels: labels.map((l) => l.label),
        usageCount: usage?.n ?? 0,
      })
    }
    const label = c.req.query('label')
    const slug = c.req.query('slug')
    const q = c.req.query('q')
    const conds = [visibleSchema(schema.schemas.hash, orgs)]
    if (label)
      conds.push(
        sql`EXISTS (SELECT 1 FROM ${schema.schemaLabels} l WHERE l.schema_hash = ${schema.schemas.hash} AND l.label LIKE ${`%${label}%`})`,
      )
    if (slug)
      conds.push(
        sql`EXISTS (SELECT 1 FROM ${schema.schemaUsage} u WHERE u.schema_hash = ${schema.schemas.hash} AND u.type_slug = ${slug})`,
      )
    if (q) {
      conds.push(
        or(
          sql`EXISTS (SELECT 1 FROM ${schema.schemaLabels} l WHERE l.schema_hash = ${schema.schemas.hash} AND l.label LIKE ${`%${q}%`})`,
          sql`EXISTS (SELECT 1 FROM ${schema.schemaUsage} u WHERE u.schema_hash = ${schema.schemas.hash} AND u.type_slug LIKE ${`%${q}%`})`,
        )!,
      )
    }
    const rows = await db
      .select()
      .from(schema.schemas)
      .where(and(...conds))
      .orderBy(desc(schema.schemas.createdAt))
      .limit(limit)
      .offset(offset)
    const labels = await labelsFor(
      c,
      rows.map((r) => r.hash),
    )
    const out = await Promise.all(
      rows.map(async (r) => ({
        id: r.hash,
        schemaHash: r.hash,
        schema: await schemaBody(c, r.hash),
        createdAt: r.createdAt,
        labels: (labels.get(r.hash) ?? []).map((l) => l.label),
      })),
    )
    return c.json(out)
  })

  app.get('/api/schemas/:id', async (c) => {
    const orgs = callerOrgs(c)
    const hash = c.req.param('id')
    const { db } = c.var.ports
    const [row] = await db
      .select()
      .from(schema.schemas)
      .where(and(eq(schema.schemas.hash, hash), visibleSchema(schema.schemas.hash, orgs)))
    if (!row) return jsonError(c, 404, 'Schema not found')
    const usage = await db
      .select({
        slug: schema.schemaUsage.typeSlug,
        owner: schema.organization.slug,
        collection: schema.collections.slug,
        headSemver: schema.versions.semver,
      })
      .from(schema.schemaUsage)
      .innerJoin(schema.collections, eq(schema.collections.id, schema.schemaUsage.collectionId))
      .innerJoin(schema.organization, eq(schema.organization.id, schema.collections.organizationId))
      .leftJoin(schema.versions, eq(schema.versions.id, schema.collections.headVersionId))
      .where(
        and(
          eq(schema.schemaUsage.schemaHash, hash),
          isNull(schema.schemaUsage.toSeq),
          // Public use for everyone; members also see their own orgs' private use.
          orgs
            ? or(
                and(eq(schema.collections.public, true), eq(schema.schemaUsage.set, 'public')),
                sql`${schema.collections.organizationId} IN ${orgs}`,
              )
            : and(eq(schema.collections.public, true), eq(schema.schemaUsage.set, 'public')),
        ),
      )
      .limit(50)
    return c.json({
      id: hash,
      schemaHash: hash,
      schema: await schemaBody(c, hash),
      createdAt: row.createdAt,
      labels: (await labelsFor(c, [hash])).get(hash) ?? [],
      // A type used in both sets is one entry.
      usage: [
        ...new Map(
          usage.map((u) => [
            `${u.owner}/${u.collection}\u0000${u.slug}`,
            { slug: u.slug, semver: u.headSemver, collection: `${u.owner}/${u.collection}` },
          ]),
        ).values(),
      ],
    })
  })

  app.post('/api/schemas/:id/labels', async (c) => {
    const p = c.var.principal
    if (!p) return jsonError(c, 401, 'Authentication required')
    if (p.scope === 'read') return jsonError(c, 403, 'Write access required')
    const hash = c.req.param('id')
    const body = (await c.req.json().catch(() => ({}))) as { label?: unknown }
    const label = typeof body.label === 'string' ? body.label.trim() : ''
    if (!label) return jsonError(c, 400, 'Label is required')
    if (label.length > MAX_LABEL_LENGTH)
      return jsonError(c, 400, `Label must be at most ${MAX_LABEL_LENGTH} characters`)
    const [row] = await c.var.ports.db
      .select()
      .from(schema.schemas)
      .where(and(eq(schema.schemas.hash, hash), visibleSchema(schema.schemas.hash, callerOrgs(c))))
    if (!row) return jsonError(c, 404, 'Schema not found')
    const inserted = await c.var.ports.db
      .insert(schema.schemaLabels)
      .values({ schemaHash: hash, label })
      .onConflictDoNothing()
      .returning()
    return inserted.length
      ? c.json({ status: 'created', schemaId: hash, label }, 201)
      : c.json({ status: 'exists', schemaId: hash, label })
  })

  app.delete('/api/schemas/:id/labels/:label', async (c) => {
    if (c.var.principal?.scope !== 'admin') return jsonError(c, 403, 'Admin access required')
    await c.var.ports.db
      .delete(schema.schemaLabels)
      .where(
        and(
          eq(schema.schemaLabels.schemaHash, c.req.param('id')),
          eq(schema.schemaLabels.label, c.req.param('label')),
        ),
      )
    return c.json({ ok: true })
  })

  return app
}
