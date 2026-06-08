import { existsSync, readFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { resolve } from 'node:path'

import { getRequestListener, serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { marked } from 'marked'
import type { ViteDevServer } from 'vite'

import * as _accounts from '~/api/accounts'
import * as _admin from '~/api/admin'
import * as _ark from '~/api/ark'
import { arkMiddleware } from '~/api/ark-middleware.server'
import type { AuthEnv } from '~/api/auth.server'
import { authMiddleware, requireAuth } from '~/api/auth.server'
import * as _collections from '~/api/collections'
import * as _files from '~/api/files'
import * as _health from '~/api/health'
import * as _kfSummary from '~/api/kf-summary'
import * as _negotiate from '~/api/negotiate'
import * as _query from '~/api/query'
import * as _records from '~/api/records'
import * as _schemas from '~/api/schemas'
import * as _uploads from '~/api/uploads'
import * as _versions from '~/api/versions'
import { auth } from '~/lib/auth'
import { getSessionUser } from '~/lib/auth.server'
import { getMirrorConfig } from '~/lib/mirror-config'

const isProd = process.env.NODE_ENV === 'production'
let vite: ViteDevServer | undefined
let devHttpServer: import('node:http').Server | undefined

// In dev, proxy API modules through Vite's SSR loader for hot reload
function hot<T extends Record<string, any>>(staticMod: T, modulePath: string): T {
  if (isProd) return staticMod
  return new Proxy(staticMod as object, {
    get(_, prop) {
      if (typeof prop === 'symbol') return undefined
      return async (...args: unknown[]) => {
        const mod = await vite!.ssrLoadModule(modulePath)
        return (mod[prop as string] as Function)(...args)
      }
    },
  }) as T
}

const accounts = hot(_accounts, '/src/api/accounts.ts')
const admin = hot(_admin, '/src/api/admin.ts')
const ark = hot(_ark, '/src/api/ark.ts')
const collections = hot(_collections, '/src/api/collections.ts')
const files = hot(_files, '/src/api/files.ts')
const health = hot(_health, '/src/api/health.ts')
const negotiate = hot(_negotiate, '/src/api/negotiate.ts')
const kfSummary = hot(_kfSummary, '/src/api/kf-summary.ts')
const query = hot(_query, '/src/api/query.ts')
const records = hot(_records, '/src/api/records.ts')
const schemas = hot(_schemas, '/src/api/schemas.ts')
const uploads = hot(_uploads, '/src/api/uploads.ts')
const versions = hot(_versions, '/src/api/versions.ts')

const app = new Hono<AuthEnv>()

// --- ai.txt with explicit charset (browsers default to Latin-1 for text/plain) ---
app.get('/.well-known/ai.txt', async (c) => {
  const content = readFileSync(resolve('public/.well-known/ai.txt'), 'utf-8')
  return c.text(content, 200, { 'Content-Type': 'text/plain; charset=utf-8' })
})

// --- CORS ---
app.use('/api/*', cors({ origin: '*', credentials: true }))

// --- Auth middleware for API routes ---
app.use('/api/*', authMiddleware)

// --- Mirror mode guard for admin routes ---
app.use('/api/admin/*', async (c, next) => {
  const config = getMirrorConfig()
  if (!config.enabled) {
    return c.json({ error: 'Not found', statusCode: 404 }, 404)
  }
  await next()
})

// --- ARK resolution middleware ---
app.use('/ark\\:*', arkMiddleware)

// --- Better-auth handler (OIDC login, sessions, API keys) ---
app.on(['GET', 'POST'], '/api/auth/*', async (c) => {
  return auth.handler(c.req.raw)
})

// /login redirect — fall through to React route only when there's an error to display
app.get('/login', async (c, next) => {
  const url = new URL(c.req.url)
  if (!url.searchParams.has('error')) {
    const signInUrl = new URL('/api/auth/sign-in/oauth2', url.origin)
    const authRes = await auth.handler(
      new Request(signInUrl, {
        method: 'POST',
        headers: new Headers({
          'Content-Type': 'application/json',
          Cookie: c.req.header('cookie') ?? '',
          Origin: url.origin,
        }),
        body: JSON.stringify({ providerId: 'kf-auth', callbackURL: '/dashboard' }),
      }),
    )
    const body = await authRes.json()
    if (body.url) {
      const redirect = new Response(null, { status: 302, headers: { Location: body.url } })
      for (const [key, value] of authRes.headers.entries()) {
        if (key.toLowerCase() === 'set-cookie') redirect.headers.append(key, value)
      }
      return redirect
    }
  }
  await next()
})

// --- API routes ---
app.get('/api/health', health.check)

// KF internal (service-to-service)
app.get('/api/kf/summary', kfSummary.summary)

// Admin (mirror)
app.get('/api/admin/mirror/status', admin.mirrorStatus)
app.post('/api/admin/mirror/test', admin.mirrorTest)
app.post('/api/admin/mirror/sync', admin.mirrorSync)
app.post('/api/admin/mirror/sync/stop', admin.mirrorSyncStop)
app.get('/api/admin/mirror/sync/progress', admin.mirrorSyncProgress)
app.get('/api/admin/mirror/sync/active', admin.mirrorSyncActive)
app.get('/api/admin/mirror/history', admin.mirrorHistory)

// Query
app.get('/api/query/sqlite/:owner/:slug/:version', query.sqlite)
app.get('/api/query/ddl/:owner/:slug/:version', query.ddl)
app.post('/api/query/generate-sql', query.generateSql)
app.get('/api/query/collections/search', query.searchCollections)
app.get('/api/query/collections/:owner/:slug/versions', query.collectionVersions)

// Records
app.get('/api/records/:hash/provenance', records.provenance)
app.post('/api/records/batch', records.batch)

// Schemas
app.get('/api/schemas', schemas.listSchemas)
app.get('/api/schemas/:id', schemas.getSchema)
app.get('/api/collections/:owner/:slug/schemas', schemas.collectionSchemas)
app.post('/api/schemas/:id/labels', requireAuth('write'), schemas.addLabel)
app.delete('/api/schemas/:id/labels/:label', requireAuth('admin'), schemas.removeLabel)

// ARK
app.get('/api/ark/resolve', ark.resolve)
app.get('/api/collections/:owner/:slug/ark', requireAuth('read'), ark.getArk)
app.patch('/api/collections/:owner/:slug/ark', requireAuth('write'), ark.updateArk)
app.get(
  '/api/collections/:owner/:slug/ark/record-types',
  requireAuth('read'),
  ark.getArkRecordTypes,
)
app.patch(
  '/api/collections/:owner/:slug/ark/record-types',
  requireAuth('write'),
  ark.updateArkRecordTypes,
)
app.patch('/api/accounts/:slug/ark', requireAuth('admin'), ark.updateAccountArk)

// Collections
app.get('/api/collections', collections.list)
app.post('/api/accounts/:owner/collections', requireAuth('write'), collections.create)
app.get('/api/collections/:owner/:slug', collections.get)
app.patch('/api/collections/:owner/:slug', requireAuth('write'), collections.update)
app.delete('/api/collections/:owner/:slug', requireAuth('admin'), collections.remove)
app.post('/api/collections/:owner/:slug/transfer', requireAuth(), collections.transfer)
app.get('/api/accounts/:owner/collections', collections.listByOwner)
app.get('/api/collections/:owner/:slug/export', collections.exportArchive)
app.post('/api/collections/:owner/:slug/fork', requireAuth('write'), collections.fork)

// Files
app.on('HEAD', '/api/collections/:owner/:slug/files/:hash', files.headFile)
app.get('/api/collections/:owner/:slug/files/:hash', files.getFile)
app.put('/api/collections/:owner/:slug/files/:hash', requireAuth('write'), files.putFile)

// Uploads
app.post(
  '/api/collections/:owner/:slug/versions/upload',
  requireAuth('write'),
  uploads.startSession,
)
app.put(
  '/api/collections/:owner/:slug/versions/upload/:sessionId',
  requireAuth('write'),
  uploads.appendBatch,
)
app.get(
  '/api/collections/:owner/:slug/versions/upload/:sessionId',
  requireAuth('read'),
  uploads.getSession,
)
app.post(
  '/api/collections/:owner/:slug/versions/upload/:sessionId/finalize',
  requireAuth('write'),
  uploads.finalize,
)
app.delete(
  '/api/collections/:owner/:slug/versions/upload/:sessionId',
  requireAuth('write'),
  uploads.cancelSession,
)

// Versions
app.get('/api/collections/:owner/:slug/versions', versions.list)
app.get('/api/collections/:owner/:slug/versions/latest', versions.latest)
app.get('/api/collections/:owner/:slug/versions/:n', versions.getByNumber)
app.get('/api/collections/:owner/:slug/versions/:n/records', versions.records)
app.get('/api/collections/:owner/:slug/versions/:n/files', versions.files)
app.get('/api/collections/:owner/:slug/versions/:n/manifest', versions.manifest)
app.post('/api/collections/:owner/:slug/versions', requireAuth('write'), versions.push)
app.post(
  '/api/collections/:owner/:slug/versions/negotiate',
  requireAuth('write'),
  negotiate.negotiate,
)
app.post(
  '/api/collections/:owner/:slug/versions/negotiate/:sessionId/commit',
  requireAuth('write'),
  negotiate.commit,
)
app.get('/api/collections/:owner/:slug/versions/:n/diff', versions.diff)

// Accounts (custom routes — org CRUD, members, invitations, API keys handled by /api/auth/*)
app.get('/api/accounts/me', requireAuth(), accounts.getMe)
app.get('/api/accounts/available-kf-orgs', requireAuth(), accounts.availableKfOrgs)
app.get('/api/accounts/:slug', accounts.getBySlug)
app.get('/api/accounts/:slug/members', accounts.listMembers)
app.patch('/api/accounts/me', requireAuth(), accounts.updateMe)
app.post('/api/accounts/:slug/avatar', requireAuth(), accounts.uploadOrgAvatar)
app.delete('/api/accounts/me', requireAuth(), accounts.deleteMe)

// --- Blog content API (serves rendered markdown) ---
app.get('/api/blog/:slug', (c) => {
  const slug = c.req.param('slug')
  const mdPath = resolve('content/blog', `${slug}.md`)
  if (!existsSync(mdPath)) {
    return c.json({ error: 'Not found' }, 404)
  }
  const raw = readFileSync(mdPath, 'utf-8')
  // Strip frontmatter
  const fmEnd = raw.indexOf('---', 4)
  const body = fmEnd > 0 ? raw.slice(fmEnd + 3).trim() : raw
  const html = marked(body)
  return c.html(typeof html === 'string' ? html : '')
})

// --- App context (consumed by root loader) ---
app.get('/api/context', async (c) => {
  const user = await getSessionUser(c.req.raw)
  const config = getMirrorConfig()
  return c.json({
    currentUser: user,
    mirrorConfig: config,
    kfAccountUrl: process.env.OIDC_ACCOUNT_URL ?? 'http://localhost:3001',
    kfAuthUrl: process.env.OIDC_ISSUER_URL ?? 'http://localhost:3000',
  })
})

// API 404 catch-all
app.all('/api/*', (c) => {
  return c.json({ error: 'API route not found', statusCode: 404 }, 404)
})

// --- SSR ---
if (isProd) {
  // Verify SSR build artifacts exist at startup (fail fast, don't wait for first request)
  const clientHtml = resolve('dist/client/index.html')
  const ssrBundle = resolve('dist/server/entry-server.js')
  if (!existsSync(clientHtml)) throw new Error(`Missing ${clientHtml} — did 'pnpm build' run?`)
  if (!existsSync(ssrBundle)) throw new Error(`Missing ${ssrBundle} — did 'pnpm build' run?`)

  // Serve Vite build assets (hashed JS/CSS bundles)
  app.use('/assets/*', serveStatic({ root: './dist/client' }))
  // Serve public/ folder files (favicon, wasm, .well-known, etc.)
  app.use('/*', serveStatic({ root: './public' }))

  // Run migrations on startup
  const { runMigrations } = await import('~/db/migrate')
  await runMigrations()

  const template = readFileSync(clientHtml, 'utf-8')
  const { render } = await import(ssrBundle as string)

  app.get('*', async (c) => {
    const { html, hydrationData, redirect, statusCode, title, description } = await render(
      c.req.raw,
    )

    if (redirect) return c.redirect(redirect, statusCode ?? 302)

    let page = template
      .replace('<!--ssr-outlet-->', html)
      .replace(
        '<!--ssr-data-->',
        `<script>window.__staticRouterHydrationData=${hydrationData}</script>`,
      )

    if (title) {
      page = page.replace('<title>Underlay</title>', `<title>${title}</title>`)
    }
    if (description) {
      page = page.replace(
        '</head>',
        `<meta name="description" content="${description.replace(/"/g, '&quot;')}" />\n</head>`,
      )
    }

    return c.html(page, statusCode ?? 200)
  })
} else {
  devHttpServer = createHttpServer()
  const { createServer: createViteServer } = await import('vite')
  vite = await createViteServer({
    server: { middlewareMode: true, hmr: { server: devHttpServer } },
    appType: 'custom',
  })

  // Vite's Connect middleware for HMR and asset transforms
  app.use('*', async (c, next) => {
    const nodeReq = (c.env as any).incoming
    const nodeRes = (c.env as any).outgoing
    if (!nodeReq || !nodeRes) return next()
    return new Promise<Response | void>((resolve) => {
      vite!.middlewares(nodeReq, nodeRes, () => resolve(next()))
    })
  })

  app.get('*', async (c) => {
    const url = c.req.url
    let template = readFileSync(resolve('index.html'), 'utf-8')
    template = await vite!.transformIndexHtml(url, template)

    const { render } = await vite!.ssrLoadModule('/src/entry-server.tsx')
    const { html, hydrationData, redirect, statusCode, title, description } = await render(
      c.req.raw,
    )

    if (redirect) return c.redirect(redirect, statusCode ?? 302)

    let page = template
      .replace('<!--ssr-outlet-->', html)
      .replace(
        '<!--ssr-data-->',
        `<script>window.__staticRouterHydrationData=${hydrationData}</script>`,
      )

    if (title) {
      page = page.replace('<title>Underlay</title>', `<title>${title}</title>`)
    }
    if (description) {
      page = page.replace(
        '</head>',
        `<meta name="description" content="${description.replace(/"/g, '&quot;')}" />\n</head>`,
      )
    }

    return c.html(page, statusCode ?? 200)
  })
}

const port = Number(process.env.PORT) || 3000

const KF_AUTH_INTERNAL_URL =
  process.env.OIDC_ISSUER_INTERNAL_URL ?? process.env.OIDC_ISSUER_URL ?? 'http://localhost:3000'
try {
  const res = await fetch(`${KF_AUTH_INTERNAL_URL}/api/health`, {
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) throw new Error(`status ${res.status}`)
} catch (err: any) {
  console.error(`FATAL: KF Auth not reachable at ${KF_AUTH_INTERNAL_URL}/api/health`)
  console.error(err.message)
  process.exit(1)
}

console.log(`Server running at http://localhost:${port}`)
if (devHttpServer) {
  devHttpServer.on('request', getRequestListener(app.fetch))
  devHttpServer.listen(port)
} else {
  serve({ fetch: app.fetch, port })
}
