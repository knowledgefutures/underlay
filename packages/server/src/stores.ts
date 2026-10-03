/**
 * Resolve repositories from placements (edge-redesign.md, "Placements").
 *
 * Today every collection's primary is the platform location, but nothing below
 * assumes it: the primary is looked up per collection, and a location is turned
 * into a Repo from its row. Customer (s3) locations become readable once
 * credential encryption lands with bucket mirrors (phase 11).
 */
import {
  type Cache,
  PrefixedStore,
  type PresigningStore,
  Repo,
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
}

/** Primary placements change rarely; remember them briefly per isolate. */
const PRIMARY_TTL_MS = 60_000
const primaryCache = new Map<string, { locationId: string; at: number }>()

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
    })
    repos.set(locationId, repo)
    return repo
  }

  return {
    forLocation,
    async forCollection(collectionId: string): Promise<Repo> {
      const hit = primaryCache.get(collectionId)
      if (hit && Date.now() - hit.at < PRIMARY_TTL_MS) return forLocation(hit.locationId)
      const [row] = await db
        .select({ locationId: schema.placements.locationId })
        .from(schema.placements)
        .where(
          and(
            eq(schema.placements.collectionId, collectionId),
            eq(schema.placements.role, 'primary'),
          ),
        )
        .limit(1)
      if (!row) throw new Error(`Collection ${collectionId} has no primary placement`)
      primaryCache.set(collectionId, { locationId: row.locationId, at: Date.now() })
      return forLocation(row.locationId)
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

/** Forget a cached primary (after promoting a mirror). */
export function invalidatePrimary(collectionId: string): void {
  primaryCache.delete(collectionId)
}
