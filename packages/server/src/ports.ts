/**
 * The ports the server is written against. Cloudflare and Node each supply
 * adapters; nothing outside the adapters knows which runtime it's on.
 *
 *   Stores     repositories resolved per collection from its placement (never a global
 *              bucket), plus the platform's internal area (sessions, uploads, reference log)
 *   Db         Drizzle sqlite-core over D1 or libsql — async, batches only (no interactive transactions)
 *   Jobs       Cloudflare Queues, or a SQLite jobs table polled by the Node process
 *   Cache      Cache API on Workers, in-memory LRU on Node
 */
import type { BlobStore, Cache, Repo, Signer } from '@underlay/repo'
import type { LibSQLDatabase } from 'drizzle-orm/libsql'

import type * as schema from './db/schema.js'

export type { BlobStore, Cache } from '@underlay/repo'

/**
 * Drizzle over SQLite. Both adapters are async and support `db.batch([...])`,
 * which runs statements atomically. Don't use `db.transaction`: D1 doesn't have
 * interactive transactions, so code that works on Node would break on Workers.
 */
export type Db = LibSQLDatabase<typeof schema>

/** Messages carry ids only (Queues caps messages at 128 KB); data is in SQLite and blobs. */
export interface JobMessage {
  type: string
  [k: string]: string | number | boolean | null
}

export interface Jobs {
  enqueue(job: JobMessage, opts?: { delaySeconds?: number }): Promise<void>
  enqueueBatch(jobs: JobMessage[]): Promise<void>
}

/**
 * Where repositories live. A collection's objects are read and written through
 * the repository of its primary placement; mirrors are written by sync jobs.
 */
export interface Stores {
  /** The repository of a collection's primary placement. */
  forCollection(collectionId: string): Promise<Repo>
  /** The repository at a storage location. */
  forLocation(locationId: string): Promise<Repo>
  /**
   * Platform-internal objects that never leave the platform and are never
   * mirrored: push sessions, staging uploads, the reference log.
   */
  internal: BlobStore
  /** File bytes, by the `files.storage_key` (v1 keys are relative to the bucket root). */
  fileBytes: BlobStore
}

export interface Ports {
  stores: Stores
  db: Db
  jobs: Jobs
  cache: Cache
  /** Signs version log entries (the deployment's Ed25519 key, imported once per isolate). */
  signer(): Promise<Signer>
  /** Run work after the response (Workers: ctx.waitUntil; Node: fire and forget with logging). */
  waitUntil(p: Promise<unknown>): void
}
