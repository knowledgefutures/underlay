/**
 * Resolve repositories from placements (edge-redesign.md, "Placements").
 *
 * Today every collection's primary is the platform location, but nothing below
 * assumes it: the primary is looked up per collection, and a location is turned
 * into a Repo from its row. Customer (s3) locations become readable once
 * credential encryption lands with bucket mirrors (phase 11).
 */
import {
  type LayoutName,
  type Cache,
  PrefixedStore,
  type PresigningStore,
  Repo,
  sharedLru,
  type Store,
} from '@underlay/protocol'
import { and, eq } from 'drizzle-orm'

import * as schema from './db/schema.js'
import type { Db, Stores } from './ports.js'

export interface PlatformStorage {
  /** The deployment's own bucket: repositories and internal objects. */
  bucket: Store
  /**
   * The same bucket through a store that presigns, for file bytes (direct
   * uploads and downloads). On Workers `bucket` can be the R2 binding, which
   * can't presign, and this the S3 API. Defaults to `bucket` when it presigns.
   */
  files?: PresigningStore
  /** Key prefix for repositories in it ('' for the bucket root). */
  repoPrefix: string
  /** Key prefix for platform-internal objects. */
  internalPrefix: string
  /** The isolate's memory cache for repository objects (default 32 MB; the bulk Worker's is smaller). */
  memoryBytes?: number
  /**
   * The record layout new collections get (record-storage-layout.md): `today`
   * (default for now), leaf bodies, or `f`, records in packs per collection. Each collection keeps
   * the layout it was created with (`collections.record_layout`); forks take their
   * parent's.
   */
  newCollections?: LayoutName
}

/** Primary placements change rarely, a collection's layout only by a conversion; remember them briefly per isolate. */
const PRIMARY_TTL_MS = 60_000
const primaryCache = new Map<string, { locationId: string; layout: LayoutName; at: number }>()

export function createStores(db: Db, cache: Cache, platform: PlatformStorage): Stores {
  const repos = new Map<string, Repo>()
  const files = platform.files ?? presigning(platform.bucket)

  const forLocation = async (locationId: string): Promise<Repo> => {
    const known = repos.get(locationId)
    if (known) return known
    const [loc] = await db
      .select()
      .from(schema.storageLocations)
      .where(eq(schema.storageLocations.id, locationId))
      .limit(1)
    if (!loc) throw new Error(`Unknown storage location ${locationId}`)
    if (loc.kind !== 'platform') {
      throw new Error(`Storage location ${locationId} (${loc.kind}) is not readable yet`)
    }
    const prefix = [platform.repoPrefix, loc.prefix].filter(Boolean).join('/')
    const repo = new Repo(new PrefixedStore(platform.bucket, prefix), {
      cache,
      scope: `loc:${locationId}`,
      trusted: true,
      lru: sharedLru(platform.memoryBytes),
    })
    repos.set(locationId, repo)
    return repo
  }

  /**
   * Layout F keeps records per collection: one repository per collection over the
   * location's objects (nodes are shared), its packs, index and manifest under
   * `runs/<collection>/`, and rewritten leaves stored as node deltas.
   */
  const forCollectionRuns = async (locationId: string, collectionId: string): Promise<Repo> => {
    const k = `${locationId}/${collectionId}`
    const known = repos.get(k)
    if (known) return known
    const loc = await forLocation(locationId)
    const repo = new Repo(loc.blobs, {
      cache,
      scope: loc.scope,
      trusted: true,
      lru: loc.lru,
      layout: 'f',
      recordScope: collectionId,
      nodes: 'delta',
    })
    repos.set(k, repo)
    return repo
  }
  const located = (locationId: string, collectionId: string, layout: LayoutName) =>
    layout === 'f' ? forCollectionRuns(locationId, collectionId) : forLocation(locationId)

  return {
    forLocation,
    newCollections: platform.newCollections ?? 'today',
    async forCollection(collectionId: string): Promise<Repo> {
      const hit = primaryCache.get(collectionId)
      if (hit && Date.now() - hit.at < PRIMARY_TTL_MS)
        return located(hit.locationId, collectionId, hit.layout)
      const [row] = await db
        .select({
          locationId: schema.placements.locationId,
          layout: schema.collections.recordLayout,
        })
        .from(schema.placements)
        .innerJoin(schema.collections, eq(schema.collections.id, schema.placements.collectionId))
        .where(
          and(
            eq(schema.placements.collectionId, collectionId),
            eq(schema.placements.role, 'primary'),
          ),
        )
        .limit(1)
      if (!row) throw new Error(`Collection ${collectionId} has no primary placement`)
      primaryCache.set(collectionId, {
        locationId: row.locationId,
        layout: row.layout,
        at: Date.now(),
      })
      return located(row.locationId, collectionId, row.layout)
    },
    internal: new PrefixedStore(platform.bucket, platform.internalPrefix),
    fileBytes: files,
    canonicalFileKey: (hash) => [platform.repoPrefix, 'files', hash].filter(Boolean).join('/'),
    stagingKey: (id) => [platform.internalPrefix, 'uploads', id].filter(Boolean).join('/'),
  }
}

function presigning(store: Store): PresigningStore {
  if (!store.presigner) throw new Error('The platform bucket store cannot presign; pass `files`')
  return store as PresigningStore
}
