/**
 * The four ports the server is written against. Cloudflare and Node each supply
 * adapters; nothing outside the adapters knows which runtime it's on.
 *
 *   BlobStore  S3 API via aws4fetch (R2, S3, MinIO), filesystem and memory for dev/tests
 *   Db         Drizzle sqlite-core over D1 or libsql — async, batches only (no interactive transactions)
 *   Jobs       Cloudflare Queues, or a SQLite jobs table polled by the Node process
 *   Cache      Cache API on Workers, in-memory LRU on Node
 */
import type { LibSQLDatabase } from 'drizzle-orm/libsql'

import type * as schema from './db/schema.js'

// --- Blob store ------------------------------------------------------------------

export interface BlobHead {
  size: number
  etag: string
  contentType: string | null
}

export interface BlobObject extends BlobHead {
  body: ReadableStream<Uint8Array>
  bytes(): Promise<Uint8Array>
  text(): Promise<string>
}

export interface PutOptions {
  contentType?: string
  /** Only write if the key doesn't exist. Immutable keys make this an optimization. */
  ifAbsent?: boolean
}

export interface PresignGetOptions {
  expiresIn: number
  /** Content-Disposition for the response. */
  disposition?: string
  contentType?: string
}

export interface PresignPutOptions {
  expiresIn: number
  contentType?: string
}

export interface BlobStore {
  get(key: string, range?: { offset: number; length?: number }): Promise<BlobObject | null>
  head(key: string): Promise<BlobHead | null>
  put(key: string, body: Uint8Array | string, opts?: PutOptions): Promise<void>
  delete(key: string): Promise<void>
  list(prefix: string, cursor?: string): Promise<{ keys: string[]; cursor?: string }>
  presignGet(key: string, opts: PresignGetOptions): Promise<string>
  presignPut(key: string, opts: PresignPutOptions): Promise<string>
  createMultipart(key: string, contentType?: string): Promise<string>
  presignPart(key: string, uploadId: string, partNumber: number, expiresIn: number): Promise<string>
  completeMultipart(
    key: string,
    uploadId: string,
    parts: { partNumber: number; etag: string }[],
  ): Promise<void>
  abortMultipart(key: string, uploadId: string): Promise<void>
}

// --- Database ----------------------------------------------------------------------

/**
 * Drizzle over SQLite. Both adapters are async and support `db.batch([...])`,
 * which runs statements atomically. Don't use `db.transaction`: D1 doesn't have
 * interactive transactions, so code that works on Node would break on Workers.
 */
export type Db = LibSQLDatabase<typeof schema>

// --- Jobs --------------------------------------------------------------------------------

/** Messages carry ids only (Queues caps messages at 128 KB); data is in SQLite and blobs. */
export interface JobMessage {
  type: string
  [k: string]: string | number | boolean | null
}

export interface Jobs {
  enqueue(job: JobMessage, opts?: { delaySeconds?: number }): Promise<void>
  enqueueBatch(jobs: JobMessage[]): Promise<void>
}

// --- Cache --------------------------------------------------------------------------------

/** A shared cache for immutable, hash-keyed bytes (nodes, roots, schemas). */
export interface Cache {
  get(key: string): Promise<Uint8Array | null>
  put(key: string, value: Uint8Array, opts?: { ttlSeconds?: number }): Promise<void>
}

// --- Everything the app needs -------------------------------------------------------

export interface Ports {
  blobs: BlobStore
  db: Db
  jobs: Jobs
  cache: Cache
  /** Run work after the response (Workers: ctx.waitUntil; Node: fire and forget with logging). */
  waitUntil(p: Promise<unknown>): void
}
