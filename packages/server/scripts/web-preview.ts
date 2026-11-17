/**
 * The built site on localhost, for looking at pages in a browser: the built renderPage
 * behind the app (as scripts/ssr-smoke.ts runs it) over an empty database, and dist/client's
 * static files. Run after `pnpm --filter @underlay/web build`:  tsx scripts/web-preview.ts [port]
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { ed25519Signer, generateSigningKey, memoryStore } from '@underlay/protocol'
import { Hono } from 'hono'

import '../src/handlers.js'
// @ts-ignore: the built bundle has no declarations; its source is src/entry-server.tsx.
import { renderPage } from '../../web/dist/server/entry-server.js'
import { createApp } from '../src/app.js'
import { MemoryCache } from '../src/cache.js'
import { openNodeDb } from '../src/db/node.js'
import { SqliteJobs } from '../src/jobs.js'
import type { Ports } from '../src/ports.js'
import { createStores } from '../src/stores.js'

const port = Number(process.argv[2] ?? 4329)
const origin = `http://localhost:${port}`
const dir = await mkdtemp(join(tmpdir(), 'ul-web-preview-'))
const db = await openNodeDb(`file:${join(dir, 'db.sqlite')}`)
const cache = new MemoryCache()
const signer = await ed25519Signer(await generateSigningKey())
const ports: Ports = {
  db,
  stores: createStores(db, cache, {
    bucket: memoryStore(),
    repoPrefix: 'repo',
    internalPrefix: 'internal',
  }),
  cache,
  signer: async () => signer,
  serverName: `localhost:${port}`,
  jobs: new SqliteJobs(db),
  waitUntil: (p) => void p.catch((err) => console.error(err)),
  outboundFetch: async () => new Response('ok'),
}
const app = createApp(() => ({
  ports,
  config: { appUrl: origin, deployment: 'preview' },
  authenticate: async () => null,
  renderPage,
}))
const site = new Hono()
site.use('*', serveStatic({ root: join(import.meta.dirname, '..', '..', 'web', 'dist', 'client') }))
site.route('/', app)
serve({ fetch: site.fetch, port })
console.log(`preview on ${origin}`)
