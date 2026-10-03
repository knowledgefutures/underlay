/** Ports over a temp SQLite file and an in-memory bucket, for integration tests. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { newSalt } from '@underlay/core'
import { ed25519Signer, generateSigningKey, type Signer } from '@underlay/repo'
import { MemoryBlobStore } from '@underlay/repo/blob/memory'

import '../src/handlers.js'
import { MemoryCache } from '../src/cache.js'
import { openNodeDb } from '../src/db/node.js'
import * as schema from '../src/db/schema.js'
import { drainSqliteJobs, SqliteJobs } from '../src/jobs.js'
import type { Ports } from '../src/ports.js'
import { createStores } from '../src/stores.js'

const dirs: string[] = []

export async function cleanup(): Promise<void> {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
}

export interface Harness {
  ports: Ports
  bucket: MemoryBlobStore
  signer: Signer
  /** Run queued jobs until none are ready. */
  drain(): Promise<number>
  /** An org and a collection with a primary placement on the platform location. */
  collection(slug?: string): Promise<typeof schema.collections.$inferSelect>
}

export async function harness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'ul-it-'))
  dirs.push(dir)
  const db = await openNodeDb(`file:${join(dir, 'db.sqlite')}`)
  const bucket = new MemoryBlobStore()
  const cache = new MemoryCache()
  const signer = await ed25519Signer(await generateSigningKey())
  const ports: Ports = {
    db,
    stores: createStores(db, cache, { bucket, repoPrefix: 'repo', internalPrefix: 'internal' }),
    cache,
    signer: async () => signer,
    jobs: new SqliteJobs(db),
    waitUntil: (p) => void p.catch((err) => console.error(err)),
  }
  let orgMade = false
  return {
    ports,
    bucket,
    signer,
    drain: () => drainSqliteJobs(ports),
    async collection(slug = 'c') {
      if (!orgMade) {
        await db.insert(schema.organization).values({ id: 'org1', name: 'Org', slug: 'org' })
        orgMade = true
      }
      const [c] = await db
        .insert(schema.collections)
        .values({ organizationId: 'org1', slug, name: slug, privateSalt: newSalt() })
        .returning()
      await db.insert(schema.placements).values({
        collectionId: c!.id,
        locationId: schema.PLATFORM_LOCATION_ID,
        role: 'primary',
        sets: 'public+private',
      })
      return c!
    },
  }
}
