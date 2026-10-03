/**
 * Node entry: one process serving the app, running jobs from the SQLite jobs
 * table, and serving presigned `/_blob/…` URLs when blobs are on the filesystem.
 *
 * Env:
 *   PORT (4200), APP_URL, DEPLOYMENT
 *   DB_URL            file:./data/underlay.sqlite
 *   BLOB_DIR          use the filesystem blob store under this directory, or
 *   S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY, S3_REGION
 *   BLOB_URL_SECRET   HMAC key for filesystem presigned URLs
 *   REPO_PREFIX (repo), INTERNAL_PREFIX (internal)   key prefixes in the platform bucket
 */
import { serve } from '@hono/node-server'
import { FsBlobStore, serveSignedBlob } from '@underlay/repo/blob/fs'
import { S3BlobStore } from '@underlay/repo/blob/s3'

import { createApp } from '../app.js'
import { MemoryCache } from '../cache.js'
import { openNodeDb } from '../db/node.js'
import { drainSqliteJobs, SqliteJobs } from '../jobs.js'
import type { BlobStore, Ports } from '../ports.js'
import { createStores } from '../stores.js'

const env = process.env
const port = Number(env.PORT ?? 4200)
const appUrl = env.APP_URL ?? `http://localhost:${port}`

const db = await openNodeDb(env.DB_URL ?? 'file:./data/underlay.sqlite')

let blobs: BlobStore
let fsBlobs: FsBlobStore | null = null
if (env.S3_ENDPOINT) {
  blobs = new S3BlobStore({
    endpoint: env.S3_ENDPOINT,
    bucket: env.S3_BUCKET ?? 'underlay',
    accessKeyId: env.S3_ACCESS_KEY ?? '',
    secretAccessKey: env.S3_SECRET_KEY ?? '',
    region: env.S3_REGION ?? 'auto',
  })
} else {
  fsBlobs = new FsBlobStore({
    root: env.BLOB_DIR ?? './data/blobs',
    publicUrl: appUrl,
    secret: env.BLOB_URL_SECRET ?? 'dev-blob-secret',
  })
  blobs = fsBlobs
}

let kick: () => void = () => {}
const cache = new MemoryCache()
const ports: Ports = {
  db,
  stores: createStores(db, cache, {
    bucket: blobs,
    repoPrefix: env.REPO_PREFIX ?? 'repo',
    internalPrefix: env.INTERNAL_PREFIX ?? 'internal',
  }),
  cache,
  jobs: {
    async enqueue(job, opts) {
      await jobsTable.enqueue(job, opts)
      kick()
    },
    async enqueueBatch(js) {
      await jobsTable.enqueueBatch(js)
      kick()
    },
  },
  waitUntil: (p) => {
    p.catch((err) => console.error('[waitUntil]', err))
  },
}
const jobsTable = new SqliteJobs(db)

// One runner loop: wakes on enqueue and every few seconds for delayed jobs.
let running = false
const runJobs = async () => {
  if (running) return
  running = true
  try {
    await drainSqliteJobs(ports)
  } catch (err) {
    console.error('[jobs]', err)
  } finally {
    running = false
  }
}
kick = () => void runJobs()
setInterval(kick, 5000).unref()

const config = { appUrl, deployment: env.DEPLOYMENT ?? 'dev' }
const app = createApp(() => ({ ports, config }))

serve({
  port,
  fetch: (req) => {
    if (fsBlobs && new URL(req.url).pathname.startsWith('/_blob/'))
      return serveSignedBlob(fsBlobs, req)
    return app.fetch(req)
  },
})
console.log(`underlay v2 (node) listening on ${appUrl}`)
