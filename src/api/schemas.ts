import { and, eq, ilike, inArray, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { openApi } from 'hono-zod-openapi'
import { z } from 'zod'

import { db, schema } from '../db/client.server.js'
import type { AuthEnv } from './auth.server.js'
import { requireAuth } from './auth.server.js'

async function getUsageCount(schemaId: string): Promise<number> {
  const [result] = await db
    .select({ count: sql<number>`count(distinct ${schema.versionSchemas.versionId})::int` })
    .from(schema.versionSchemas)
    .where(eq(schema.versionSchemas.schemaId, schemaId))
  return result?.count ?? 0
}

const app = new Hono<AuthEnv>()
  .get(
    '/schemas',
    openApi({
      tags: ['Schemas'],
      summary: 'Search and list schemas',
      responses: { 200: z.any() },
    }),
    async (c) => {
      const q = c.req.query('q')
      const slugFilter = c.req.query('slug')
      const label = c.req.query('label')
      const schema_hash = c.req.query('schema_hash')
      const limit = c.req.query('limit')
      const offset = c.req.query('offset')

      const pageLimit = Math.min(parseInt(limit ?? '50', 10), 100)
      const pageOffset = parseInt(offset ?? '0', 10)

      if (schema_hash) {
        const [row] = await db
          .select()
          .from(schema.schemas)
          .where(eq(schema.schemas.schemaHash, schema_hash))
          .limit(1)

        if (!row) return c.json({ error: 'Schema not found', statusCode: 404 }, 404)

        const labels = await db
          .select({ label: schema.schemaLabels.label })
          .from(schema.schemaLabels)
          .where(eq(schema.schemaLabels.schemaId, row.id))

        const usageCount = await getUsageCount(row.id)

        return c.json({
          ...row,
          labels: labels.map((l) => l.label),
          usageCount,
        })
      }

      if (slugFilter) {
        const vsRows = await db
          .select({ schemaId: schema.versionSchemas.schemaId })
          .from(schema.versionSchemas)
          .where(eq(schema.versionSchemas.slug, slugFilter))
          .groupBy(schema.versionSchemas.schemaId)
          .limit(pageLimit)
          .offset(pageOffset)

        if (vsRows.length === 0) return c.json([])

        const schemaIds = vsRows.map((r) => r.schemaId)
        const schemaRows = await db
          .select()
          .from(schema.schemas)
          .where(inArray(schema.schemas.id, schemaIds))

        const allLabels = await db
          .select({ schemaId: schema.schemaLabels.schemaId, label: schema.schemaLabels.label })
          .from(schema.schemaLabels)
          .where(inArray(schema.schemaLabels.schemaId, schemaIds))

        const labelsMap = new Map<string, string[]>()
        for (const l of allLabels) {
          if (!labelsMap.has(l.schemaId)) labelsMap.set(l.schemaId, [])
          labelsMap.get(l.schemaId)!.push(l.label)
        }

        return c.json(
          schemaRows.map((s) => ({
            ...s,
            labels: labelsMap.get(s.id) ?? [],
          })),
        )
      }

      if (label) {
        const labelRows = await db
          .select({
            schemaId: schema.schemaLabels.schemaId,
            label: schema.schemaLabels.label,
          })
          .from(schema.schemaLabels)
          .where(ilike(schema.schemaLabels.label, `%${label}%`))
          .limit(pageLimit)
          .offset(pageOffset)

        if (labelRows.length === 0) return c.json([])

        const schemaIds = [...new Set(labelRows.map((r) => r.schemaId))]
        const schemaRows = await db
          .select()
          .from(schema.schemas)
          .where(inArray(schema.schemas.id, schemaIds))

        const allLabels = await db
          .select({ schemaId: schema.schemaLabels.schemaId, label: schema.schemaLabels.label })
          .from(schema.schemaLabels)
          .where(inArray(schema.schemaLabels.schemaId, schemaIds))

        const labelsMap = new Map<string, string[]>()
        for (const l of allLabels) {
          if (!labelsMap.has(l.schemaId)) labelsMap.set(l.schemaId, [])
          labelsMap.get(l.schemaId)!.push(l.label)
        }

        return c.json(
          schemaRows.map((s) => ({
            ...s,
            labels: labelsMap.get(s.id) ?? [],
          })),
        )
      }

      if (q) {
        const rows = await db
          .select()
          .from(schema.schemas)
          .where(sql`${schema.schemas.schema}::text ILIKE ${'%' + q + '%'}`)
          .limit(pageLimit)
          .offset(pageOffset)

        const schemaIds = rows.map((r) => r.id)
        const allLabels =
          schemaIds.length > 0
            ? await db
                .select({
                  schemaId: schema.schemaLabels.schemaId,
                  label: schema.schemaLabels.label,
                })
                .from(schema.schemaLabels)
                .where(inArray(schema.schemaLabels.schemaId, schemaIds))
            : []

        const labelsMap = new Map<string, string[]>()
        for (const l of allLabels) {
          if (!labelsMap.has(l.schemaId)) labelsMap.set(l.schemaId, [])
          labelsMap.get(l.schemaId)!.push(l.label)
        }

        return c.json(
          rows.map((s) => ({
            ...s,
            labels: labelsMap.get(s.id) ?? [],
          })),
        )
      }

      const rows = await db
        .select()
        .from(schema.schemas)
        .orderBy(sql`${schema.schemas.createdAt} desc`)
        .limit(pageLimit)
        .offset(pageOffset)

      const schemaIds = rows.map((r) => r.id)
      const allLabels =
        schemaIds.length > 0
          ? await db
              .select({
                schemaId: schema.schemaLabels.schemaId,
                label: schema.schemaLabels.label,
              })
              .from(schema.schemaLabels)
              .where(inArray(schema.schemaLabels.schemaId, schemaIds))
          : []

      const labelsMap = new Map<string, string[]>()
      for (const l of allLabels) {
        if (!labelsMap.has(l.schemaId)) labelsMap.set(l.schemaId, [])
        labelsMap.get(l.schemaId)!.push(l.label)
      }

      return c.json(
        rows.map((s) => ({
          ...s,
          labels: labelsMap.get(s.id) ?? [],
        })),
      )
    },
  )
  .get(
    '/schemas/:id',
    openApi({
      tags: ['Schemas'],
      summary: 'Get a schema by ID',
      request: { param: z.object({ id: z.string() }) },
      responses: { 200: z.any() },
    }),
    async (c) => {
      const { id } = c.req.valid('param')

      const [row] = await db.select().from(schema.schemas).where(eq(schema.schemas.id, id)).limit(1)

      if (!row) return c.json({ error: 'Schema not found', statusCode: 404 }, 404)

      const labels = await db
        .select({ label: schema.schemaLabels.label, createdAt: schema.schemaLabels.createdAt })
        .from(schema.schemaLabels)
        .where(eq(schema.schemaLabels.schemaId, id))

      const usage = await db
        .select({
          slug: schema.versionSchemas.slug,
          semver: schema.versions.semver,
          collectionSlug: schema.collections.slug,
          owner: schema.organization.slug,
          isPublic: schema.collections.public,
        })
        .from(schema.versionSchemas)
        .innerJoin(schema.versions, eq(schema.versionSchemas.versionId, schema.versions.id))
        .innerJoin(schema.collections, eq(schema.versions.collectionId, schema.collections.id))
        .innerJoin(
          schema.organization,
          eq(schema.collections.organizationId, schema.organization.id),
        )
        .where(and(eq(schema.versionSchemas.schemaId, id), eq(schema.collections.public, true)))
        .orderBy(sql`${schema.versions.createdAt} desc`)
        .limit(50)

      return c.json({
        ...row,
        labels: labels.map((l) => ({ label: l.label, createdAt: l.createdAt })),
        usage: usage.map((u) => ({
          slug: u.slug,
          semver: u.semver,
          collection: `${u.owner}/${u.collectionSlug}`,
        })),
      })
    },
  )
  .get(
    '/collections/:owner/:slug/schemas',
    openApi({
      tags: ['Schemas'],
      summary: 'Get schemas for a collection version',
      request: { param: z.object({ owner: z.string(), slug: z.string() }) },
      responses: { 200: z.any() },
    }),
    async (c) => {
      const { owner, slug } = c.req.valid('param')
      const versionParam = c.req.query('version')
      const raw = c.req.query('raw')

      const [collection] = await db
        .select({
          id: schema.collections.id,
          organizationId: schema.collections.organizationId,
          public: schema.collections.public,
        })
        .from(schema.collections)
        .innerJoin(
          schema.organization,
          eq(schema.collections.organizationId, schema.organization.id),
        )
        .where(and(eq(schema.organization.slug, owner), eq(schema.collections.slug, slug)))
        .limit(1)

      if (!collection) return c.json({ error: 'Collection not found', statusCode: 404 }, 404)

      if (!collection.public && c.get('userId') !== collection.organizationId) {
        return c.json({ error: 'Collection not found', statusCode: 404 }, 404)
      }

      const versionConditions = [
        eq(schema.versions.collectionId, collection.id),
        eq(schema.versions.status, 'ready'),
      ]
      if (versionParam) {
        const { parseSemver } = await import('../lib/version-helpers.server.js')
        const { semver: vSemver } = parseSemver(versionParam)
        versionConditions.push(eq(schema.versions.semver, vSemver))
      }

      const [version] = await db
        .select({
          id: schema.versions.id,
          semver: schema.versions.semver,
        })
        .from(schema.versions)
        .where(and(...versionConditions))
        .orderBy(
          sql`${schema.versions.major} desc, ${schema.versions.minor} desc, ${schema.versions.patch} desc`,
        )
        .limit(1)

      if (!version) return c.json({ error: 'No versions found', statusCode: 404 }, 404)

      const entries = await db
        .select({
          slug: schema.versionSchemas.slug,
          schemaId: schema.versionSchemas.schemaId,
          schemaBody: schema.schemas.schema,
          schemaHash: schema.schemas.schemaHash,
        })
        .from(schema.versionSchemas)
        .innerJoin(schema.schemas, eq(schema.versionSchemas.schemaId, schema.schemas.id))
        .where(eq(schema.versionSchemas.versionId, version.id))

      let labelsMap = new Map<string, string[]>()
      if (raw !== 'true' && entries.length > 0) {
        const schemaIds = entries.map((e) => e.schemaId)
        const allLabels = await db
          .select({ schemaId: schema.schemaLabels.schemaId, label: schema.schemaLabels.label })
          .from(schema.schemaLabels)
          .where(inArray(schema.schemaLabels.schemaId, schemaIds))

        for (const l of allLabels) {
          if (!labelsMap.has(l.schemaId)) labelsMap.set(l.schemaId, [])
          labelsMap.get(l.schemaId)!.push(l.label)
        }
      }

      return c.json({
        version: version.semver,
        semver: version.semver,
        schemas: entries.map((e) => {
          const labels = labelsMap.get(e.schemaId) ?? []
          const body =
            raw === 'true'
              ? e.schemaBody
              : labels.length > 0
                ? { ...(e.schemaBody as object), 'x-underlay-labels': labels }
                : e.schemaBody

          return {
            slug: e.slug,
            schemaId: e.schemaId,
            schemaHash: e.schemaHash,
            schema: body,
          }
        }),
      })
    },
  )
  .post(
    '/schemas/:id/labels',
    requireAuth('write'),
    openApi({
      tags: ['Schemas'],
      summary: 'Add a label to a schema',
      request: { param: z.object({ id: z.string() }) },
      responses: { 200: z.any(), 201: z.any() },
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      const { label } = await c.req.json()

      if (!label || typeof label !== 'string' || label.trim().length === 0) {
        return c.json({ error: 'Label is required', statusCode: 400 }, 400)
      }

      const [existing] = await db
        .select({ id: schema.schemas.id })
        .from(schema.schemas)
        .where(eq(schema.schemas.id, id))
        .limit(1)

      if (!existing) {
        return c.json({ error: 'Schema not found', statusCode: 404 }, 404)
      }

      try {
        const [inserted] = await db
          .insert(schema.schemaLabels)
          .values({ schemaId: id, label: label.trim() })
          .onConflictDoNothing()
          .returning()

        if (!inserted) {
          return c.json({ status: 'exists', schemaId: id, label: label.trim() })
        }

        return c.json({ status: 'created', schemaId: id, label: label.trim() }, 201)
      } catch {
        return c.json({ error: 'Failed to add label', statusCode: 500 }, 500)
      }
    },
  )
  .delete(
    '/schemas/:id/labels/:label',
    requireAuth('admin'),
    openApi({
      tags: ['Schemas'],
      summary: 'Remove a label from a schema',
      request: { param: z.object({ id: z.string(), label: z.string() }) },
      responses: { 200: z.any() },
    }),
    async (c) => {
      const { id, label } = c.req.valid('param')

      const result = await db
        .delete(schema.schemaLabels)
        .where(and(eq(schema.schemaLabels.schemaId, id), eq(schema.schemaLabels.label, label)))
        .returning()

      if (result.length === 0) {
        return c.json({ error: 'Label not found', statusCode: 404 }, 404)
      }

      return c.json({ status: 'deleted', schemaId: id, label })
    },
  )

export default app
