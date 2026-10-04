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
 *   SIGNING_KEY       Ed25519 private key seed (base64url) that signs version logs
 *   LOCATION_KEY      32 bytes (base64url) that encrypt customer storage credentials
 *   SESSION_SECRET, OIDC_ISSUER_URL, OIDC_ISSUER_INTERNAL_URL, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET
 *   OIDC_ACCOUNT_URL                      the KF account site, linked from the user menu
 *                     better-auth and KF Auth (same names as v1's .env files)
 */
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import {
  ed25519Signer,
  type FileStore,
  fileStore,
  generateSigningKey,
  s3Store,
  serveSignedBlob,
  type Signer,
} from '@underlay/protocol'
import { Hono } from 'hono'

import '../handlers.js'
import { createApp, type RenderPage } from '../app.js'
import { authenticator, createAuth } from '../auth/auth.js'
import { MemoryCache } from '../cache.js'
import { openNodeDb } from '../db/node.js'
import { drainSqliteJobs, SqliteJobs } from '../jobs.js'
import { requestInit } from '../locations/locations.js'
import type { Ports, PresigningStore } from '../ports.js'
import { createStores } from '../stores.js'
import { guardedFetch } from './guarded-fetch.js'

const env = process.env
const port = Number(env.PORT ?? 4200)
const appUrl = env.APP_URL ?? `http://localhost:${port}`

const db = await openNodeDb(env.DB_URL ?? 'file:./data/underlay.sqlite')

let blobs: PresigningStore
let fsBlobs: FileStore | null = null
if (env.S3_ENDPOINT) {
  blobs = s3Store({
    endpoint: env.S3_ENDPOINT,
    bucket: env.S3_BUCKET ?? 'underlay',
    accessKeyId: env.S3_ACCESS_KEY ?? '',
    secretAccessKey: env.S3_SECRET_KEY ?? '',
    region: env.S3_REGION ?? 'auto',
  })
} else {
  const local = fileStore(env.BLOB_DIR ?? './data/blobs', {
    publicUrl: appUrl,
    secret: env.BLOB_URL_SECRET ?? 'dev-blob-secret',
  })
  fsBlobs = local
  blobs = local
}

let signingKey = env.SIGNING_KEY
if (!signingKey) {
  signingKey = await generateSigningKey()
  console.warn('[underlay] SIGNING_KEY is not set; version logs are signed with a throwaway key')
}
const signer: Promise<Signer> = ed25519Signer(signingKey)

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
  signer: () => signer,
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
  outboundFetch: guardedFetch,
  // Customer storage endpoints are user-supplied URLs too.
  locationFetch: async (req) => guardedFetch(req.url, await requestInit(req)),
  ...(env.LOCATION_KEY ? { locationKey: env.LOCATION_KEY } : {}),
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

const config = {
  appUrl,
  deployment: env.DEPLOYMENT ?? 'dev',
  kfAuthUrl: env.OIDC_ISSUER_URL,
  kfAccountUrl: env.OIDC_ACCOUNT_URL,
}

// The UI (packages/web, built with `pnpm --filter @underlay/web build`). Without
// a build, the API still runs and pages are 404.
let renderPage: RenderPage | undefined
const clientDir = fileURLToPath(new URL('../../../web/dist/client', import.meta.url))
try {
  renderPage = (await import('@underlay/web')).renderPage
} catch {
  console.warn('[underlay] @underlay/web is not built; serving the API only')
}
const staticFiles = serveStatic({ root: relative(process.cwd(), clientDir) })
const auth = createAuth(
  db,
  {
    appUrl,
    secret: env.SESSION_SECRET ?? 'dev-secret-change-me',
    oidc: {
      issuerUrl: env.OIDC_ISSUER_URL ?? 'http://localhost:3000',
      internalUrl: env.OIDC_ISSUER_INTERNAL_URL ?? env.OIDC_ISSUER_URL ?? 'http://localhost:3000',
      clientId: env.OIDC_CLIENT_ID ?? 'kf_underlay',
      clientSecret: env.OIDC_CLIENT_SECRET ?? '',
    },
  },
  ports.waitUntil,
)
const app = createApp(() => ({
  ports,
  config,
  authenticate: authenticator(() => auth),
  authHandler: (req) => auth.handler(req),
  ...(renderPage ? { renderPage } : {}),
}))

/** Static files from the client build, falling back to the app. */
const staticApp = new Hono()
staticApp.use('*', staticFiles)
staticApp.all('*', (c) => app.fetch(c.req.raw))
const staticOrApp = (req: Request) => staticApp.fetch(req)

serve({
  port,
  fetch: (req) => {
    const path = new URL(req.url).pathname
    if (fsBlobs && path.startsWith('/_blob/')) return serveSignedBlob(fsBlobs, req)
    if (!path.startsWith('/api/') && /\.[a-z0-9]+$/i.test(path)) return staticOrApp(req)
    return app.fetch(req)
  },
})
console.log(`underlay v2 (node) listening on ${appUrl}`)
