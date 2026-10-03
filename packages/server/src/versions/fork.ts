/**
 * Fork (edge-redesign.md, Commit): the fork's first version is a new root that
 * reuses the source version's sets, plus a `forks` row. No data is copied.
 *
 * A fork by an owner keeps the private set; it inherits the source collection's
 * salt so the private commitment (and so the version hash) stays the same and
 * later pushes of the same content still dedupe. A fork by anyone else takes
 * the public set only. Both collections must share a primary location, since a
 * repository never references another location.
 */
import { makeRoot, newSalt } from '@underlay/protocol'
import { eq } from 'drizzle-orm'

import * as schema from '../db/schema.js'
import type { Ports } from '../ports.js'
import { appendVersionLog } from './commit.js'
import { publishVersion, type SchemaUsageChange } from './publish.js'

export async function createCollectionRows(
  ports: Ports,
  c: { organizationId: string; slug: string; name: string; public: boolean; privateSalt?: string },
): Promise<typeof schema.collections.$inferSelect> {
  const id = crypto.randomUUID()
  await ports.db.batch([
    ports.db.insert(schema.collections).values({
      id,
      organizationId: c.organizationId,
      slug: c.slug,
      name: c.name,
      public: c.public,
      privateSalt: c.privateSalt ?? newSalt(),
    }),
    ports.db.insert(schema.placements).values({
      collectionId: id,
      locationId: schema.PLATFORM_LOCATION_ID,
      role: 'primary',
      sets: 'public+private',
    }),
  ])
  const [row] = await ports.db
    .select()
    .from(schema.collections)
    .where(eq(schema.collections.id, id))
  return row!
}

export async function forkCollection(
  ports: Ports,
  source: {
    collection: typeof schema.collections.$inferSelect
    version: typeof schema.versions.$inferSelect
  },
  target: { organizationId: string; slug: string; name: string; public: boolean },
  includePrivate: boolean,
): Promise<{
  collection: typeof schema.collections.$inferSelect
  version: typeof schema.versions.$inferSelect
}> {
  const repo = await ports.stores.forCollection(source.collection.id)
  const root = await repo.root(source.version.hash)
  const priv = includePrivate && root.private ? await repo.privateSet(root.private) : null

  const collection = await createCollectionRows(ports, {
    ...target,
    ...(priv ? { privateSalt: source.collection.privateSalt } : {}),
  })
  const targetRepo = await ports.stores.forCollection(collection.id)
  if (targetRepo !== repo) throw new Error('Forks across storage locations are not supported yet')

  const newRoot = makeRoot(root.metadata, root.public, priv)
  const hash = await repo.putRoot(newRoot)

  const v = source.version
  const keepPrivate = !!priv
  const usage: SchemaUsageChange[] = [
    ...Object.entries(root.public.types).map(([slug, t]) => ({
      set: 'public' as const,
      typeSlug: slug,
      schemaHash: t.schema,
      wasOpen: false,
    })),
    ...Object.entries(priv?.types ?? {}).map(([slug, t]) => ({
      set: 'private' as const,
      typeSlug: slug,
      schemaHash: t.schema,
      wasOpen: false,
    })),
  ]
  const versionId = crypto.randomUUID()
  const published = await publishVersion(ports.db, {
    version: {
      id: versionId,
      collectionId: collection.id,
      seq: 1,
      semver: 'v1.0.0',
      major: 1,
      minor: 0,
      patch: 0,
      hash,
      baseSemver: null,
      message: `Forked from ${source.collection.slug} ${v.semver}`,
      pushedBy: null,
      appId: null,
      actorId: null,
      recordCount: keepPrivate ? v.recordCount : v.publicRecordCount,
      publicRecordCount: v.publicRecordCount,
      fileCount: keepPrivate ? v.fileCount : v.publicFileCount,
      totalBytes: keepPrivate ? v.totalBytes : v.publicTotalBytes,
      publicFileCount: v.publicFileCount,
      publicTotalBytes: v.publicTotalBytes,
      typeCounts: keepPrivate ? v.typeCounts : v.publicTypeCounts,
      publicTypeCounts: v.publicTypeCounts,
      hasPrivate: newRoot.private !== null,
      publicRefsRoot: v.publicRefsRoot,
      privateRefsRoot: keepPrivate ? v.privateRefsRoot : null,
      changes: { added: keepPrivate ? v.recordCount : v.publicRecordCount, removed: 0, updated: 0 },
    },
    baseVersionId: null,
    collectionUpdate: {
      publicFilesRoot: root.public.files.root,
      summary: source.collection.summary,
    },
    schemaHashes: [],
    usage,
  })
  if (!published.ok) throw new Error('Fork publish lost a race on a brand-new collection')
  await ports.db.insert(schema.forks).values({
    childCollectionId: collection.id,
    parentCollectionId: source.collection.id,
    parentSeq: v.seq,
  })
  const [version] = await ports.db
    .select()
    .from(schema.versions)
    .where(eq(schema.versions.id, versionId))
  await appendVersionLog(ports, repo, collection.id, version!)
  await ports.jobs.enqueue({ type: 'version.published', versionId, bump: 'major' })
  return { collection, version: version! }
}
