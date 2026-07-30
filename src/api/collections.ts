import { createGzip } from 'node:zlib'

import { and, desc, eq, ilike, inArray, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { openApi } from 'hono-zod-openapi'
import { pack as tarPack } from 'tar-stream'
import { v4 as uuidv4 } from 'uuid'
import { z } from 'zod'

import { db, schema } from '../db/client.server.js'
import { buildArkUrl, collectionToArkId, DEFAULT_NAAN, getOrMintShoulder } from '../lib/ark.js'
import { downloadFromS3 } from '../lib/s3.js'
import { getLatestReadyVersion, getOrgRole, hasOrgAccess } from '../lib/version-helpers.server.js'
import { type AuthEnv } from './auth.server.js'
import { requireAuth } from './auth.server.js'

const app = new Hono<AuthEnv>()
  // Browse collections — public by default, or the caller's own with ?mine=true
  .get(
    '/collections',
    openApi({
      tags: ['Collections'],
      summary: 'Browse collections',
      description:
        'Lists public collections. Pass `mine=true` (authenticated) to list collections belonging ' +
        'to the organizations the caller is a member of instead, including private ones.',
      responses: { 200: z.any() },
    }),
    async (c) => {
      const q = c.req.query('q')
      const owner = c.req.query('owner')
      const tag = c.req.query('tag')
      const sort = c.req.query('sort')
      const mine = c.req.query('mine') === 'true'
      const take = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 100)
      const skip = parseInt(c.req.query('offset') ?? '0', 10)

      // Visibility scope. Public collections by default; with ?mine=true, every
      // collection owned by an org the caller belongs to — private ones included,
      // since org membership is what grants access elsewhere (hasOrgAccess).
      if (mine && !c.get('userId')) {
        return c.json(
          { error: 'Unauthorized — mine=true requires a session', statusCode: 401 },
          401,
        )
      }
      const visibility = mine
        ? inArray(
            schema.collections.organizationId,
            db
              .select({ id: schema.member.organizationId })
              .from(schema.member)
              .where(eq(schema.member.userId, c.get('userId')!)),
          )
        : eq(schema.collections.public, true)

      const conditions = [visibility]
      if (q) {
        conditions.push(ilike(schema.collections.name, `%${q}%`))
      }
      if (owner) {
        conditions.push(eq(schema.organization.slug, owner))
      }

      const results = await db
        .select({
          id: schema.collections.id,
          slug: schema.collections.slug,
          name: schema.collections.name,
          public: schema.collections.public,
          ownerSlug: schema.organization.slug,
          ownerName: schema.organization.name,
          createdAt: schema.collections.createdAt,
          updatedAt: schema.collections.updatedAt,
        })
        .from(schema.collections)
        .innerJoin(
          schema.organization,
          eq(schema.collections.organizationId, schema.organization.id),
        )
        .where(and(...conditions))
        .limit(take + 200)
        .offset(skip)
        .orderBy(sort === 'name' ? schema.collections.name : desc(schema.collections.updatedAt))

      const ids = results.map((r) => r.id)
      const statsMap = new Map<
        string,
        {
          collectionId: string
          semver: string
          metadata: unknown
          recordCount: number
          fileCount: number
          totalBytes: number
          lastPushAt: Date
        }
      >()

      if (ids.length > 0) {
        const allVersions = await db
          .select({
            collectionId: schema.versions.collectionId,
            semver: schema.versions.semver,
            metadata: schema.versions.metadata,
            recordCount: schema.versions.recordCount,
            fileCount: schema.versions.fileCount,
            totalBytes: schema.versions.totalBytes,
            lastPushAt: schema.versions.createdAt,
          })
          .from(schema.versions)
          .where(
            and(inArray(schema.versions.collectionId, ids), eq(schema.versions.status, 'ready')),
          )
          .orderBy(
            sql`${schema.versions.major} desc, ${schema.versions.minor} desc, ${schema.versions.patch} desc`,
          )

        for (const v of allVersions) {
          if (!statsMap.has(v.collectionId)) {
            statsMap.set(v.collectionId, v)
          }
        }
      }

      // Build enriched results with tags, then apply tag filter
      const enriched = results.map((r) => {
        const stats = statsMap.get(r.id)
        const meta = stats?.metadata as Record<string, unknown> | null | undefined
        const tags = Array.isArray(meta?.tags) ? (meta.tags as string[]) : []
        return {
          ...r,
          description: (meta?.description as string) ?? null,
          tags,
          latestVersion: stats?.semver ?? null,
          recordCount: stats?.recordCount ?? null,
          fileCount: stats?.fileCount ?? null,
          totalBytes: stats?.totalBytes ?? null,
          lastPushAt: stats?.lastPushAt ?? null,
        }
      })

      const filtered = tag ? enriched.filter((c) => c.tags.includes(tag)) : enriched

      // Compute tag facets from all visible collections (before tag filter, after search/owner)
      const tagCounts = new Map<string, number>()
      for (const c of enriched) {
        for (const t of c.tags) {
          tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1)
        }
      }
      const tagFacets = [...tagCounts.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)

      // Facets must describe the same scope as the results, or ?mine=true would
      // show owner counts for collections the caller can't see.
      const facetConditions = [visibility]
      if (q) {
        facetConditions.push(ilike(schema.collections.name, `%${q}%`))
      }

      const ownerFacets = await db
        .select({
          slug: schema.organization.slug,
          name: schema.organization.name,
          count: sql<number>`count(*)::int`,
        })
        .from(schema.collections)
        .innerJoin(
          schema.organization,
          eq(schema.collections.organizationId, schema.organization.id),
        )
        .where(and(...facetConditions))
        .groupBy(schema.organization.slug, schema.organization.name)
        .orderBy(sql`count(*) DESC`)

      // Load instance settings for explore page
      const settingsRows = await db
        .select({ key: schema.instanceSettings.key, value: schema.instanceSettings.value })
        .from(schema.instanceSettings)
        .where(
          inArray(schema.instanceSettings.key, [
            'explore_featured_tags',
            'explore_featured_collections',
          ]),
        )
      const settingsMap = new Map(settingsRows.map((r) => [r.key, r.value]))
      const featuredTags = Array.isArray(settingsMap.get('explore_featured_tags'))
        ? (settingsMap.get('explore_featured_tags') as string[])
        : []
      const featuredSlugs = Array.isArray(settingsMap.get('explore_featured_collections'))
        ? (settingsMap.get('explore_featured_collections') as string[])
        : []

      // Apply sort to the full filtered set, then slice for pagination
      if (sort === 'records') {
        filtered.sort((a, b) => (b.recordCount ?? 0) - (a.recordCount ?? 0))
      } else if (sort === 'featured') {
        const featuredSet = new Set(featuredSlugs)
        filtered.sort((a, b) => {
          const aFeat = featuredSet.has(`${a.ownerSlug}/${a.slug}`) ? 0 : 1
          const bFeat = featuredSet.has(`${b.ownerSlug}/${b.slug}`) ? 0 : 1
          if (aFeat !== bFeat) return aFeat - bFeat
          return (a.name ?? '').localeCompare(b.name ?? '')
        })
      }

      const page = filtered.slice(0, take)

      // Build featured collections list from the enriched set
      const featuredCollections = featuredSlugs
        .map((s) => enriched.find((c) => `${c.ownerSlug}/${c.slug}` === s))
        .filter(Boolean)

      return c.json({
        collections: page,
        facets: { owners: ownerFacets, tags: tagFacets },
        featuredTags,
        featuredCollections,
      })
    },
  )
  // Create collection
  .post(
    '/accounts/:owner/collections',
    requireAuth('write'),
    openApi({
      tags: ['Collections'],
      summary: 'Create a collection',
      request: {
        param: z.object({ owner: z.string() }),
        json: z.object({
          slug: z.string(),
          name: z.string().optional(),
          public: z.boolean().optional(),
        }),
      },
      responses: { 200: z.any() },
    }),
    async (c) => {
      const { owner } = c.req.valid('param')
      const { slug, name: rawName, public: isPublic } = c.req.valid('json')
      const name = rawName || slug

      // Resolve owner org
      const [org] = await db
        .select()
        .from(schema.organization)
        .where(eq(schema.organization.slug, owner))
        .limit(1)

      if (!org) {
        return c.json({ error: 'Org not found', statusCode: 404 }, 404)
      }

      // Check permission: user must be a member of the org
      const [membership] = await db
        .select()
        .from(schema.member)
        .where(
          and(eq(schema.member.organizationId, org.id), eq(schema.member.userId, c.get('userId')!)),
        )
        .limit(1)
      if (!membership) {
        return c.json({ error: 'Forbidden', statusCode: 403 }, 403)
      }

      // Check for existing collection with same slug under this owner
      const [existing] = await db
        .select({ id: schema.collections.id })
        .from(schema.collections)
        .where(
          and(eq(schema.collections.organizationId, org.id), eq(schema.collections.slug, slug)),
        )
        .limit(1)

      if (existing) {
        return c.json({ error: 'Collection already exists', statusCode: 409 }, 409)
      }

      const id = uuidv4()
      await db.insert(schema.collections).values({
        id,
        organizationId: org.id,
        slug,
        name,
        public: isPublic ?? false,
      })

      // Auto-mint ARK for the new collection
      try {
        const shoulder = await getOrMintShoulder(org.id)
        const arkId = collectionToArkId(id)
        await db.insert(schema.arkCollections).values({ collectionId: id, arkId, enabled: true })
        const naan = org.arkNaan ?? DEFAULT_NAAN
        const arkUrl = buildArkUrl(naan, shoulder, arkId)
        return c.json({ id, owner, slug, name, ark: arkUrl }, 201)
      } catch (err) {
        // ARK minting failure is non-fatal
        console.error(`[ark] Failed to mint ARK for new collection ${owner}/${slug}:`, err)
        return c.json({ id, owner, slug, name }, 201)
      }
    },
  )
  // Get collection
  .get(
    '/collections/:owner/:slug',
    openApi({
      tags: ['Collections'],
      summary: 'Get a collection',
      request: { param: z.object({ owner: z.string(), slug: z.string() }) },
      responses: { 200: z.any() },
    }),
    async (c) => {
      const { owner, slug } = c.req.valid('param')

      const [result] = await db
        .select({
          id: schema.collections.id,
          slug: schema.collections.slug,
          name: schema.collections.name,
          public: schema.collections.public,
          ownerSlug: schema.organization.slug,
          ownerName: schema.organization.name,
          createdAt: schema.collections.createdAt,
          updatedAt: schema.collections.updatedAt,
        })
        .from(schema.collections)
        .innerJoin(
          schema.organization,
          eq(schema.collections.organizationId, schema.organization.id),
        )
        .where(and(eq(schema.organization.slug, owner), eq(schema.collections.slug, slug)))
        .limit(1)

      if (!result) {
        return c.json({ error: 'Collection not found', statusCode: 404 }, 404)
      }

      if (!result.public) {
        // Check if user is a member of the owning org
        const [org] = await db
          .select({ id: schema.organization.id })
          .from(schema.organization)
          .where(eq(schema.organization.slug, owner))
          .limit(1)

        if (!org) {
          return c.json({ error: 'Collection not found', statusCode: 404 }, 404)
        }

        const userId = c.get('userId')
        let hasAccess = false
        if (userId) {
          const [membership] = await db
            .select()
            .from(schema.member)
            .where(and(eq(schema.member.organizationId, org.id), eq(schema.member.userId, userId)))
            .limit(1)
          hasAccess = !!membership
        }

        if (!hasAccess) {
          return c.json({ error: 'Collection not found', statusCode: 404 }, 404)
        }
      }

      // Get latest version info
      const latestVersion = await getLatestReadyVersion(result.id)

      // Get per-type record counts for latest version
      let typeCounts: { type: string; count: number }[] = []
      if (latestVersion) {
        const rows = await db
          .select({
            type: schema.recordObjects.type,
            count: sql<number>`count(*)::int`,
          })
          .from(schema.versionRecords)
          .innerJoin(
            schema.recordObjects,
            eq(schema.versionRecords.recordHash, schema.recordObjects.hash),
          )
          .where(eq(schema.versionRecords.versionId, latestVersion.id))
          .groupBy(schema.recordObjects.type)
        typeCounts = rows.map((r) => ({ type: r.type, count: r.count }))
      }

      // Fetch ARK URL if enabled
      let ark: string | null = null
      try {
        const [arkRow] = await db
          .select({
            arkId: schema.arkCollections.arkId,
            enabled: schema.arkCollections.enabled,
            shoulder: schema.arkShoulders.shoulder,
            ownerNaan: schema.organization.arkNaan,
          })
          .from(schema.arkCollections)
          .innerJoin(
            schema.collections,
            eq(schema.arkCollections.collectionId, schema.collections.id),
          )
          .innerJoin(
            schema.organization,
            eq(schema.collections.organizationId, schema.organization.id),
          )
          .innerJoin(
            schema.arkShoulders,
            eq(schema.arkShoulders.organizationId, schema.organization.id),
          )
          .where(eq(schema.arkCollections.collectionId, result.id))
          .limit(1)
        if (arkRow?.enabled) {
          ark = buildArkUrl(arkRow.ownerNaan ?? DEFAULT_NAAN, arkRow.shoulder, arkRow.arkId)
        }
      } catch (err) {
        // Non-fatal — ARK URL is decorative here
        console.error(`[ark] Failed to load ARK info for collection ${owner}/${slug}:`, err)
      }

      const [vcRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.versions)
        .where(
          and(eq(schema.versions.collectionId, result.id), eq(schema.versions.status, 'ready')),
        )
      const versionCount = vcRow?.count ?? 0

      const { id: _vid, ...latestVersionData } = latestVersion ?? { id: undefined }
      const meta = latestVersion?.metadata as Record<string, unknown> | null | undefined
      return c.json({
        ...result,
        description: (meta?.description as string) ?? null,
        ark,
        versionCount,
        latestVersion: latestVersion ? { ...latestVersionData, typeCounts } : null,
      })
    },
  )
  // Update collection
  .patch(
    '/collections/:owner/:slug',
    requireAuth('write'),
    openApi({
      tags: ['Collections'],
      summary: 'Update a collection',
      request: {
        param: z.object({ owner: z.string(), slug: z.string() }),
        json: z.object({
          name: z.string().optional(),
          slug: z.string().optional(),
          public: z.boolean().optional(),
        }),
      },
      responses: { 200: z.any() },
    }),
    async (c) => {
      const { owner, slug } = c.req.valid('param')
      const updates = c.req.valid('json')

      const [org] = await db
        .select()
        .from(schema.organization)
        .where(eq(schema.organization.slug, owner))
        .limit(1)

      if (!org) {
        return c.json({ error: 'Not found', statusCode: 404 }, 404)
      }

      const [collection] = await db
        .select()
        .from(schema.collections)
        .where(
          and(eq(schema.collections.organizationId, org.id), eq(schema.collections.slug, slug)),
        )
        .limit(1)

      if (!collection) {
        return c.json({ error: 'Not found', statusCode: 404 }, 404)
      }

      if (!(await hasOrgAccess(c.get('userId'), org.id))) {
        return c.json({ error: 'Forbidden', statusCode: 403 }, 403)
      }

      const scopedCollections = c.get('apiKeyCollectionIds')
      if (scopedCollections && !scopedCollections.includes(collection.id)) {
        return c.json({ error: 'API key is not scoped to this collection', statusCode: 403 }, 403)
      }

      // Validate new slug if provided
      if (updates.slug !== undefined) {
        const newSlug = updates.slug
        if (!newSlug || typeof newSlug !== 'string') {
          return c.json({ error: 'Slug is required', statusCode: 422 }, 422)
        }
        if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(newSlug)) {
          return c.json(
            { error: 'Slug must be lowercase alphanumeric with hyphens', statusCode: 422 },
            422,
          )
        }
        // Check uniqueness within same org
        const [existing] = await db
          .select({ id: schema.collections.id })
          .from(schema.collections)
          .where(
            and(
              eq(schema.collections.organizationId, org.id),
              eq(schema.collections.slug, newSlug),
            ),
          )
          .limit(1)

        if (existing && existing.id !== collection.id) {
          return c.json(
            { error: 'A collection with that slug already exists', statusCode: 409 },
            409,
          )
        }
      }

      await db
        .update(schema.collections)
        .set({ ...updates, updatedAt: new Date() })
        .where(eq(schema.collections.id, collection.id))

      return c.json({ ok: true, slug: updates.slug ?? slug })
    },
  )
  // Delete collection
  .delete(
    '/collections/:owner/:slug',
    requireAuth('write'),
    openApi({
      tags: ['Collections'],
      summary: 'Delete a collection',
      request: { param: z.object({ owner: z.string(), slug: z.string() }) },
      responses: { 200: z.any() },
    }),
    async (c) => {
      const { owner, slug } = c.req.valid('param')

      const [org] = await db
        .select()
        .from(schema.organization)
        .where(eq(schema.organization.slug, owner))
        .limit(1)

      if (!org) {
        return c.json({ error: 'Not found', statusCode: 404 }, 404)
      }

      const [collection] = await db
        .select()
        .from(schema.collections)
        .where(
          and(eq(schema.collections.organizationId, org.id), eq(schema.collections.slug, slug)),
        )
        .limit(1)

      if (!collection) {
        return c.json({ error: 'Not found', statusCode: 404 }, 404)
      }

      // Deleting a collection requires owner/admin role in the owning org
      const role = await getOrgRole(c.get('userId'), org.id)
      if (role !== 'owner' && role !== 'admin') {
        return c.json({ error: 'Forbidden', statusCode: 403 }, 403)
      }

      const scopedCollections = c.get('apiKeyCollectionIds')
      if (scopedCollections && !scopedCollections.includes(collection.id)) {
        return c.json({ error: 'API key is not scoped to this collection', statusCode: 403 }, 403)
      }

      await db.delete(schema.collections).where(eq(schema.collections.id, collection.id))
      return c.json({ ok: true })
    },
  )
  // Transfer collection to another org
  .post(
    '/collections/:owner/:slug/transfer',
    requireAuth(),
    openApi({
      tags: ['Collections'],
      summary: 'Transfer a collection to another org',
      request: {
        param: z.object({ owner: z.string(), slug: z.string() }),
        json: z.object({ targetOrgSlug: z.string() }),
      },
      responses: { 200: z.any() },
    }),
    async (c) => {
      const { owner, slug } = c.req.valid('param')
      const { targetOrgSlug } = c.req.valid('json')

      const callerId = c.get('userId')!

      // Find source org
      const [sourceOrg] = await db
        .select()
        .from(schema.organization)
        .where(eq(schema.organization.slug, owner))
        .limit(1)

      if (!sourceOrg) return c.json({ error: 'Source org not found', statusCode: 404 }, 404)

      // Verify caller has admin/owner access to source org
      const [sourceMembership] = await db
        .select()
        .from(schema.member)
        .where(
          and(eq(schema.member.organizationId, sourceOrg.id), eq(schema.member.userId, callerId)),
        )
        .limit(1)
      if (
        !sourceMembership ||
        (sourceMembership.role !== 'owner' && sourceMembership.role !== 'admin')
      ) {
        return c.json(
          { error: 'You must be an owner or admin of the source org', statusCode: 403 },
          403,
        )
      }

      // Find target org
      const [targetOrg] = await db
        .select()
        .from(schema.organization)
        .where(eq(schema.organization.slug, targetOrgSlug))
        .limit(1)

      if (!targetOrg) return c.json({ error: 'Target org not found', statusCode: 404 }, 404)

      // Verify caller has admin/owner access to target org
      const [targetMembership] = await db
        .select()
        .from(schema.member)
        .where(
          and(eq(schema.member.organizationId, targetOrg.id), eq(schema.member.userId, callerId)),
        )
        .limit(1)
      if (
        !targetMembership ||
        (targetMembership.role !== 'owner' && targetMembership.role !== 'admin')
      ) {
        return c.json(
          { error: 'You must be an owner or admin of the target org', statusCode: 403 },
          403,
        )
      }

      // Find collection
      const [collection] = await db
        .select()
        .from(schema.collections)
        .where(
          and(
            eq(schema.collections.organizationId, sourceOrg.id),
            eq(schema.collections.slug, slug),
          ),
        )
        .limit(1)

      if (!collection) return c.json({ error: 'Collection not found', statusCode: 404 }, 404)

      // Check slug uniqueness in target org
      const [existing] = await db
        .select({ id: schema.collections.id })
        .from(schema.collections)
        .where(
          and(
            eq(schema.collections.organizationId, targetOrg.id),
            eq(schema.collections.slug, slug),
          ),
        )
        .limit(1)

      if (existing) {
        return c.json(
          { error: `Target org already has a collection with slug "${slug}"`, statusCode: 409 },
          409,
        )
      }

      // Transfer
      await db
        .update(schema.collections)
        .set({ organizationId: targetOrg.id, updatedAt: new Date() })
        .where(eq(schema.collections.id, collection.id))

      return c.json({ ok: true, newOwner: targetOrgSlug })
    },
  )
  // List collections for an org
  .get(
    '/accounts/:owner/collections',
    openApi({
      tags: ['Collections'],
      summary: 'List collections for an org',
      request: { param: z.object({ owner: z.string() }) },
      responses: { 200: z.any() },
    }),
    async (c) => {
      const { owner } = c.req.valid('param')

      const [org] = await db
        .select()
        .from(schema.organization)
        .where(eq(schema.organization.slug, owner))
        .limit(1)

      if (!org) return c.json([])

      // Check if the requester is an org member
      let hasFullAccess = false
      const userId = c.get('userId')
      if (userId) {
        const [membership] = await db
          .select()
          .from(schema.member)
          .where(and(eq(schema.member.organizationId, org.id), eq(schema.member.userId, userId)))
          .limit(1)
        hasFullAccess = !!membership
      }

      const conditions = [eq(schema.collections.organizationId, org.id)]
      if (!hasFullAccess) {
        conditions.push(eq(schema.collections.public, true))
      }

      const results = await db
        .select({
          id: schema.collections.id,
          slug: schema.collections.slug,
          name: schema.collections.name,
          public: schema.collections.public,
          createdAt: schema.collections.createdAt,
          updatedAt: schema.collections.updatedAt,
        })
        .from(schema.collections)
        .where(and(...conditions))
        .orderBy(schema.collections.updatedAt)

      return c.json(results)
    },
  )
  // Export collection as .tar.gz archive
  .get(
    '/collections/:owner/:slug/export',
    openApi({
      tags: ['Collections'],
      summary: 'Export a collection as a tar.gz archive',
      request: { param: z.object({ owner: z.string(), slug: z.string() }) },
      responses: { 200: z.any() },
    }),
    async (c) => {
      const { owner, slug } = c.req.valid('param')
      const versionParam = c.req.query('version')

      // Resolve collection
      const [collection] = await db
        .select({
          id: schema.collections.id,
          slug: schema.collections.slug,
          name: schema.collections.name,
          public: schema.collections.public,
          organizationId: schema.collections.organizationId,
        })
        .from(schema.collections)
        .innerJoin(
          schema.organization,
          eq(schema.collections.organizationId, schema.organization.id),
        )
        .where(and(eq(schema.organization.slug, owner), eq(schema.collections.slug, slug)))
        .limit(1)

      if (!collection) {
        return c.json({ error: 'Collection not found', statusCode: 404 }, 404)
      }

      if (!collection.public) {
        const userId = c.get('userId')
        if (!userId || !(await hasOrgAccess(userId, collection.organizationId))) {
          return c.json({ error: 'Collection not found', statusCode: 404 }, 404)
        }
      }

      // Resolve version (latest if not specified)
      const versionConditions = [
        eq(schema.versions.collectionId, collection.id),
        eq(schema.versions.status, 'ready'),
      ]
      if (versionParam) {
        versionConditions.push(eq(schema.versions.semver, versionParam))
      }

      const [version] = await db
        .select()
        .from(schema.versions)
        .where(and(...versionConditions))
        .orderBy(
          sql`${schema.versions.major} desc, ${schema.versions.minor} desc, ${schema.versions.patch} desc`,
        )
        .limit(1)

      if (!version) {
        return c.json({ error: 'No versions found', statusCode: 404 }, 404)
      }

      const versionFiles = await db
        .select({
          hash: schema.versionFiles.fileHash,
          size: schema.files.size,
          mimeType: schema.files.mimeType,
          storageKey: schema.files.storageKey,
        })
        .from(schema.versionFiles)
        .innerJoin(schema.files, eq(schema.versionFiles.fileHash, schema.files.hash))
        .where(eq(schema.versionFiles.versionId, version.id))

      // Load schemas for this version
      const versionSchemaEntries = await db
        .select({
          slug: schema.versionSchemas.slug,
          schemaBody: schema.schemas.schema,
        })
        .from(schema.versionSchemas)
        .innerJoin(schema.schemas, eq(schema.versionSchemas.schemaId, schema.schemas.id))
        .where(eq(schema.versionSchemas.versionId, version.id))

      const schemasMap = Object.fromEntries(versionSchemaEntries.map((e) => [e.slug, e.schemaBody]))

      // Build manifest.json (packed last, so it can report any files that
      // failed to download)
      const versionMeta = version.metadata as Record<string, unknown> | null
      const manifest = {
        collection: {
          owner,
          slug,
          name: collection.name,
          description: (versionMeta?.description as string) ?? null,
        },
        version: {
          semver: version.semver,
          hash: version.hash,
          message: version.message,
          recordCount: version.recordCount,
          fileCount: version.fileCount,
          totalBytes: version.totalBytes,
          createdAt: version.createdAt,
        },
        schemas: schemasMap,
        files_missing: [] as string[],
      }

      // Build tar.gz stream
      const pack = tarPack()
      const gzip = createGzip()

      const filename = `${owner}-${slug}-${version.semver}.tar.gz`

      // Stream records per-type into tar — avoids loading all records at once
      const types = await db
        .selectDistinct({ type: schema.recordObjects.type })
        .from(schema.versionRecords)
        .innerJoin(
          schema.recordObjects,
          eq(schema.versionRecords.recordHash, schema.recordObjects.hash),
        )
        .where(eq(schema.versionRecords.versionId, version.id))

      for (const { type } of types) {
        const lines: string[] = []
        let batchCursor: string | null = null
        let batchHasMore = true
        while (batchHasMore) {
          const conditions = [
            eq(schema.versionRecords.versionId, version.id),
            eq(schema.recordObjects.type, type),
          ]
          if (batchCursor) {
            conditions.push(sql`${schema.recordObjects.hash} > ${batchCursor}`)
          }
          const batch = await db
            .select({
              recordId: schema.recordObjects.recordId,
              type: schema.recordObjects.type,
              data: schema.recordObjects.data,
              hash: schema.recordObjects.hash,
            })
            .from(schema.versionRecords)
            .innerJoin(
              schema.recordObjects,
              eq(schema.versionRecords.recordHash, schema.recordObjects.hash),
            )
            .where(and(...conditions))
            .orderBy(schema.recordObjects.hash)
            .limit(5001)

          batchHasMore = batch.length > 5000
          const page = batchHasMore ? batch.slice(0, 5000) : batch
          if (page.length > 0) batchCursor = page[page.length - 1]!.hash
          for (const r of page) {
            lines.push(JSON.stringify({ id: r.recordId, type: r.type, data: r.data }))
          }
        }
        const buf = Buffer.from(lines.join('\n') + '\n')
        pack.entry({ name: `records/${type}.ndjson`, size: buf.length }, buf)
      }

      // Add files
      for (const file of versionFiles) {
        try {
          const fileBuffer = await downloadFromS3(file.storageKey)
          pack.entry({ name: `files/${file.hash}`, size: fileBuffer.length }, fileBuffer)
        } catch (err) {
          console.error(`[export] Failed to download file ${file.hash} (${file.storageKey}):`, err)
          manifest.files_missing.push(file.hash)
        }
      }

      const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2))
      pack.entry({ name: 'manifest.json', size: manifestBuf.length }, manifestBuf)

      pack.finalize()

      // Pipe tar → gzip and collect into a ReadableStream
      const outputStream = pack.pipe(gzip)
      const readableStream = new ReadableStream({
        start(controller) {
          outputStream.on('data', (chunk: Buffer) => {
            controller.enqueue(new Uint8Array(chunk))
          })
          outputStream.on('end', () => {
            controller.close()
          })
          outputStream.on('error', (err) => {
            controller.error(err)
          })
        },
      })

      return c.body(readableStream, 200, {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="${filename}"`,
      })
    },
  )
  // Fork a collection into the caller's org
  .post(
    '/collections/:owner/:slug/fork',
    requireAuth('write'),
    openApi({
      tags: ['Collections'],
      summary: "Fork a collection into the caller's org",
      request: {
        param: z.object({ owner: z.string(), slug: z.string() }),
        json: z.object({ targetOrg: z.string(), slug: z.string().optional() }),
      },
      responses: { 200: z.any() },
    }),
    async (c) => {
      const { owner: sourceOwner, slug: sourceSlug } = c.req.valid('param')
      const { targetOrg, slug: targetSlug } = c.req.valid('json')

      // Resolve source collection
      const [source] = await db
        .select({
          id: schema.collections.id,
          slug: schema.collections.slug,
          name: schema.collections.name,
          public: schema.collections.public,
          organizationId: schema.collections.organizationId,
        })
        .from(schema.collections)
        .innerJoin(
          schema.organization,
          eq(schema.collections.organizationId, schema.organization.id),
        )
        .where(
          and(eq(schema.organization.slug, sourceOwner), eq(schema.collections.slug, sourceSlug)),
        )
        .limit(1)

      if (!source) {
        return c.json({ error: 'Collection not found', statusCode: 404 }, 404)
      }
      if (!source.public) {
        return c.json({ error: 'Collection not found', statusCode: 404 }, 404)
      }

      // Resolve target org and verify membership
      const [targetOrgRow] = await db
        .select()
        .from(schema.organization)
        .where(eq(schema.organization.slug, targetOrg))
        .limit(1)

      if (!targetOrgRow) {
        return c.json({ error: 'Target org not found', statusCode: 404 }, 404)
      }

      const [membership] = await db
        .select()
        .from(schema.member)
        .where(
          and(
            eq(schema.member.organizationId, targetOrgRow.id),
            eq(schema.member.userId, c.get('userId')!),
          ),
        )
        .limit(1)
      if (!membership) {
        return c.json({ error: 'Forbidden', statusCode: 403 }, 403)
      }

      const newSlug = targetSlug ?? source.slug

      // Check for existing collection with same slug
      const [existing] = await db
        .select({ id: schema.collections.id })
        .from(schema.collections)
        .where(
          and(
            eq(schema.collections.organizationId, targetOrgRow.id),
            eq(schema.collections.slug, newSlug),
          ),
        )
        .limit(1)

      if (existing) {
        return c.json({ error: 'Collection already exists in target org', statusCode: 409 }, 409)
      }

      // Get latest version of source
      const latestVersion = await getLatestReadyVersion(source.id)

      if (!latestVersion) {
        return c.json({ error: 'Source collection has no versions', statusCode: 422 }, 422)
      }

      // Create forked collection + version in a transaction
      const newCollectionId = uuidv4()
      await db.transaction(async (tx) => {
        await tx.insert(schema.collections).values({
          id: newCollectionId,
          organizationId: targetOrgRow.id,
          slug: newSlug,
          name: source.name,
          public: false,
          forkedFrom: source.id,
        })

        const [newVersion] = await tx
          .insert(schema.versions)
          .values({
            collectionId: newCollectionId,
            semver: 'v1.0.0',
            major: 1,
            minor: 0,
            patch: 0,
            hash: latestVersion.hash,
            publicHash: latestVersion.publicHash,
            baseSemver: null,
            message: `Forked from ${sourceOwner}/${sourceSlug} ${latestVersion.semver}`,
            metadata: latestVersion.metadata,
            pushedBy: c.get('userId') ?? null,
            appId: 'fork',
            recordCount: latestVersion.recordCount,
            fileCount: latestVersion.fileCount,
            totalBytes: latestVersion.totalBytes,
          })
          .returning({ id: schema.versions.id })

        const sourceRecords = await tx
          .select({
            recordHash: schema.versionRecords.recordHash,
            publicRecordHash: schema.versionRecords.publicRecordHash,
          })
          .from(schema.versionRecords)
          .where(eq(schema.versionRecords.versionId, latestVersion.id))

        const FORK_BATCH = 5000
        for (let i = 0; i < sourceRecords.length; i += FORK_BATCH) {
          const batch = sourceRecords.slice(i, i + FORK_BATCH)
          await tx.insert(schema.versionRecords).values(
            batch.map((r) => ({
              versionId: newVersion!.id,
              recordHash: r.recordHash,
              publicRecordHash: r.publicRecordHash,
            })),
          )
        }

        const sourceFiles = await tx
          .select({ fileHash: schema.versionFiles.fileHash })
          .from(schema.versionFiles)
          .where(eq(schema.versionFiles.versionId, latestVersion.id))

        for (let i = 0; i < sourceFiles.length; i += FORK_BATCH) {
          const batch = sourceFiles.slice(i, i + FORK_BATCH)
          await tx
            .insert(schema.versionFiles)
            .values(batch.map((f) => ({ versionId: newVersion!.id, fileHash: f.fileHash })))
        }

        const sourceSchemas = await tx
          .select({ slug: schema.versionSchemas.slug, schemaId: schema.versionSchemas.schemaId })
          .from(schema.versionSchemas)
          .where(eq(schema.versionSchemas.versionId, latestVersion.id))

        if (sourceSchemas.length > 0) {
          await tx.insert(schema.versionSchemas).values(
            sourceSchemas.map((s) => ({
              versionId: newVersion!.id,
              slug: s.slug,
              schemaId: s.schemaId,
            })),
          )
        }
      })

      return c.json(
        {
          id: newCollectionId,
          owner: targetOrg,
          slug: newSlug,
          name: source.name,
          forkedFrom: { owner: sourceOwner, slug: sourceSlug, version: latestVersion.semver },
          version: { semver: 'v1.0.0', recordCount: latestVersion.recordCount },
        },
        201,
      )
    },
  )

export default app
