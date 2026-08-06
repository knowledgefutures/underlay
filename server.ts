import { existsSync, readFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { resolve } from 'node:path'

import { getRequestListener, serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Scalar } from '@scalar/hono-api-reference'
import { Hono } from 'hono'
import type { MiddlewareHandler } from 'hono'
import { createOpenApiDocument } from 'hono-zod-openapi'
import { compress } from 'hono/compress'
import { cors } from 'hono/cors'
import { marked } from 'marked'
import type { ViteDevServer } from 'vite'

import _accounts from '~/api/accounts'
import * as _admin from '~/api/admin'
import * as _agentHandlers from '~/api/agent'
import * as _ark from '~/api/ark'
import { arkMiddleware } from '~/api/ark-middleware.server'
import type { AuthEnv } from '~/api/auth.server'
import { authMiddleware, requireAuth } from '~/api/auth.server'
import _collections from '~/api/collections'
import _discussion from '~/api/discussion'
import _files from '~/api/files'
import * as _health from '~/api/health'
import * as _kfSummary from '~/api/kf-summary'
import _negotiate from '~/api/negotiate'
import _organizations from '~/api/organizations'
import * as _query from '~/api/query'
import { rateLimitMiddleware } from '~/api/rate-limit.server'
import _records from '~/api/records'
import _schemas from '~/api/schemas'
import _versions from '~/api/versions'
import _webhooks from '~/api/webhooks'
import { auth } from '~/lib/auth'
import { getSessionUser } from '~/lib/auth.server'
import { getMirrorConfig } from '~/lib/mirror-config'
import { startWebhookBackgroundJobs } from '~/lib/webhooks.server'

const isProd = process.env.NODE_ENV === 'production'
let vite: ViteDevServer | undefined
/**
 * Substitute a placeholder in the HTML template with untrusted content.
 *
 * `String.prototype.replace` with a *string* pattern treats `$` sequences in the
 * REPLACEMENT specially: `$&` is the match, `` $` `` everything before it, `$'`
 * everything after, `$$` a literal `$`. Passing rendered HTML directly means any
 * page containing one of those corrupts the document — a collection README with
 * `$O(n\log n)$` in it contains `` $` `` and duplicated the entire template
 * prefix into the middle of the body, producing two nested documents.
 *
 * A replacement *function* is not scanned for those patterns, so the content is
 * inserted verbatim.
 */
function fill(template: string, placeholder: string, content: string): string {
  return template.replace(placeholder, () => content)
}

let devHttpServer: import('node:http').Server | undefined

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

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

const admin = hot(_admin, '/src/api/admin.ts')
const agentHandlers = hot(_agentHandlers, '/src/api/agent.ts')
const ark = hot(_ark, '/src/api/ark.ts')
const health = hot(_health, '/src/api/health.ts')
const kfSummary = hot(_kfSummary, '/src/api/kf-summary.ts')
const query = hot(_query, '/src/api/query.ts')

// --- API subapps (Hono Stacks with dev hot reload) ---
const hotApiModules: Array<{ mount: string; source: string }> = []

function api<M extends string, A>(mount: M, source: string, app: A): [M, A] {
  if (!isProd) hotApiModules.push({ mount, source })
  return [mount, app]
}

const app = new Hono<AuthEnv>()

// --- llms.txt with explicit charset (browsers default to Latin-1 for text/plain) ---
app.get('/llms.txt', async (c) => {
  const content = readFileSync(resolve('public/llms.txt'), 'utf-8')
  return c.text(content, 200, { 'Content-Type': 'text/plain; charset=utf-8' })
})

// --- CORS ---
// Credentialed requests are only allowed from the app's own origin (plus any
// extras in CORS_ORIGINS, comma-separated). Non-browser API clients are unaffected.
const corsAllowlist = [process.env.APP_URL, ...(process.env.CORS_ORIGINS ?? '').split(',')]
  .map((s) => s?.trim().replace(/\/$/, ''))
  .filter((s): s is string => !!s)
app.use(
  '/api/*',
  cors({
    origin: (origin) => (corsAllowlist.includes(origin) ? origin : null),
    credentials: true,
  }),
)

// --- Agent share pages (token-authenticated, no session/API-key middleware) ---
app.get('/agent/:token', agentHandlers.agentPage)

// --- Auth + rate limiting for API routes ---
// Responses are JSON and compress ~3x on real record data (measured on arXiv:
// 3.08 MB -> 1.00 MB for a 2,000-record page). Nothing was compressing before —
// not the app, and not Caddy, which has no `encode` directive — so every bulk
// read was paying full size on the wire. Applied in the app rather than at the
// proxy so local dev matches production, and because it covers the streaming
// endpoints too (chunked transfer compresses fine).
app.use('/api/*', compress())

app.use('/api/*', authMiddleware)
app.use('/api/*', rateLimitMiddleware)

// --- Admin route guards ---
// Mirror admin: requires mirror mode + admin API key or MIRROR_ADMIN_EMAILS
app.use('/api/admin/mirror/*', async (c, next) => {
  const config = getMirrorConfig()
  if (!config.enabled) {
    return c.json({ error: 'Not found', statusCode: 404 }, 404)
  }
  if (c.get('apiKeyScope') === 'admin') return next()
  const adminEmails = (process.env.MIRROR_ADMIN_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  const email = c.get('userEmail')?.toLowerCase()
  if (email && adminEmails.includes(email)) return next()
  return c.json(
    {
      error:
        'Forbidden — mirror admin requires an admin API key or a user listed in MIRROR_ADMIN_EMAILS',
      statusCode: 403,
    },
    403,
  )
})

// Steward admin: requires kfRole === 'admin'.
// NOTE: a wildcard like '/api/admin/explore-*' does NOT match in Hono (wildcards
// are segment-level), which previously left these routes ungated. Register the
// guard on the exact paths instead.
const requireSteward: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const userId = c.get('userId')
  if (!userId) return c.json({ error: 'Unauthorized', statusCode: 401 }, 401)
  const sessionUser = await getSessionUser(c.req.raw)
  if (sessionUser?.kfRole !== 'admin') {
    return c.json({ error: 'Forbidden', statusCode: 403 }, 403)
  }
  return next()
}
app.use('/api/admin/explore-tags', requireSteward)
app.use('/api/admin/explore-collections', requireSteward)

// --- ARK resolution middleware ---
app.use('/:arkpath{ark:.*}', arkMiddleware)

// Dev only: re-evaluate converted subapps through Vite on each API request.
// Falls through to next() if the fresh router doesn't match the URL,
// so unconverted routes (below) still run normally.
if (!isProd) {
  app.use('/api/*', async (c, next) => {
    if (!vite || hotApiModules.length === 0) return next()
    const router = new Hono<AuthEnv>()
    router.use('*', authMiddleware)
    for (const { mount, source } of hotApiModules) {
      const mod = await vite.ssrLoadModule(source)
      router.route(mount, mod.default)
    }
    const res = await router.fetch(c.req.raw)
    if (res.status === 404) return next()
    return res
  })
}

// --- Better-auth handler (OIDC login, sessions, API keys) ---
app.on(['GET', 'POST'], '/api/auth/*', async (c) => {
  const url = new URL(c.req.url)
  const isCallback = url.pathname.includes('/callback/')
  if (isCallback) {
    // Never log the raw URL (carries the OAuth `code`/`state`) or cookie/set-cookie
    // values (carry the session token) — anyone with log access could replay them.
    console.log('[auth callback] incoming:', {
      method: c.req.method,
      path: url.pathname,
      hasCode: url.searchParams.has('code'),
      hasState: url.searchParams.has('state'),
      hasError: url.searchParams.has('error'),
      error: url.searchParams.get('error'),
    })
  }
  const res = await auth.handler(c.req.raw)
  if (isCallback) {
    console.log('[auth callback] response:', {
      status: res.status,
      hasLocation: !!res.headers.get('location'),
      setCookieCount: res.headers.getSetCookie?.()?.length ?? 0,
    })
  }
  return res
})

// /login redirect — fall through to React route only when there's an error to display
app.get('/login', async (c, next) => {
  const url = new URL(c.req.url)
  const appOrigin = new URL(process.env.APP_URL ?? 'http://localhost:4100').origin
  if (!url.searchParams.has('error')) {
    const signInUrl = new URL('/api/auth/sign-in/oauth2', appOrigin)
    const headers = new Headers({
      'Content-Type': 'application/json',
      Cookie: c.req.header('cookie') ?? '',
      Origin: appOrigin,
    })
    const xff = c.req.header('x-forwarded-for')
    if (xff) headers.set('X-Forwarded-For', xff)
    const authRes = await auth.handler(
      new Request(signInUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ providerId: 'kf-auth', callbackURL: '/dashboard' }),
      }),
    )
    const body = await authRes.json()
    console.log('[login] auth sign-in response:', { status: authRes.status, hasUrl: !!body.url })
    if (body.url) {
      const redirect = new Response(null, { status: 302, headers: { Location: body.url } })
      for (const cookie of authRes.headers.getSetCookie()) {
        redirect.headers.append('set-cookie', cookie)
      }
      return redirect
    }
  }
  await next()
})

// --- Chained subapp mounts (produces AppType for hc client) ---
const routes = app
  .route(...api('/api/records', './src/api/records.ts', _records))
  .route(...api('/api/collections', './src/api/files.ts', _files))
  .route(...api('/api/accounts', './src/api/accounts.ts', _accounts))
  .route(...api('/api', './src/api/schemas.ts', _schemas))
  .route(...api('/api', './src/api/collections.ts', _collections))
  .route(...api('/api/collections', './src/api/versions.ts', _versions))
  .route(...api('/api/collections', './src/api/negotiate.ts', _negotiate))
  .route(...api('/api/collections', './src/api/webhooks.ts', _webhooks))
  .route(...api('/api', './src/api/discussion.ts', _discussion))
  .route(...api('/api/organizations', './src/api/organizations.ts', _organizations))

export type AppType = typeof routes

// Retry sweep + delivery-log purge for webhooks (in-process, unref'd intervals)
startWebhookBackgroundJobs()

// --- Legacy API routes (not yet converted to subapp pattern) ---
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

// Steward-only: explore featured tags
app.get('/api/admin/explore-tags', async (c) => {
  const { db, schema } = await import('~/db/client.server')
  const { eq } = await import('drizzle-orm')
  const [row] = await db
    .select({ value: schema.instanceSettings.value })
    .from(schema.instanceSettings)
    .where(eq(schema.instanceSettings.key, 'explore_featured_tags'))
    .limit(1)
  return c.json({ tags: Array.isArray(row?.value) ? row.value : [] })
})

app.put('/api/admin/explore-tags', async (c) => {
  const body = await c.req.json<{ tags: string[] }>()
  if (!Array.isArray(body.tags) || !body.tags.every((t: unknown) => typeof t === 'string')) {
    return c.json({ error: 'tags must be an array of strings', statusCode: 422 }, 422)
  }
  const { db, schema } = await import('~/db/client.server')
  await db
    .insert(schema.instanceSettings)
    .values({ key: 'explore_featured_tags', value: body.tags, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: schema.instanceSettings.key,
      set: { value: body.tags, updatedAt: new Date() },
    })
  return c.json({ ok: true, tags: body.tags })
})

// Steward-only: explore featured collections
app.get('/api/admin/explore-collections', async (c) => {
  const { db, schema } = await import('~/db/client.server')
  const { eq } = await import('drizzle-orm')
  const [row] = await db
    .select({ value: schema.instanceSettings.value })
    .from(schema.instanceSettings)
    .where(eq(schema.instanceSettings.key, 'explore_featured_collections'))
    .limit(1)
  return c.json({ collections: Array.isArray(row?.value) ? row.value : [] })
})

app.put('/api/admin/explore-collections', async (c) => {
  const body = await c.req.json<{ collections: string[] }>()
  if (
    !Array.isArray(body.collections) ||
    !body.collections.every((s: unknown) => typeof s === 'string')
  ) {
    return c.json(
      { error: 'collections must be an array of "owner/slug" strings', statusCode: 422 },
      422,
    )
  }
  const { db, schema } = await import('~/db/client.server')
  await db
    .insert(schema.instanceSettings)
    .values({ key: 'explore_featured_collections', value: body.collections, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: schema.instanceSettings.key,
      set: { value: body.collections, updatedAt: new Date() },
    })
  return c.json({ ok: true, collections: body.collections })
})

// Query
app.get('/api/query/sqlite/:owner/:slug/:version', query.sqlite)
app.get('/api/query/ddl/:owner/:slug/:version', query.ddl)
app.post('/api/query/generate-sql', query.generateSql)
app.get('/api/query/collections/search', query.searchCollections)
app.get('/api/query/collections/:owner/:slug/versions', query.collectionVersions)

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
// updateAccountArk enforces org owner/admin role internally
app.patch('/api/accounts/:slug/ark', requireAuth('write'), ark.updateAccountArk)

// --- OpenAPI doc + Scalar reference UI ---
createOpenApiDocument(
  app,
  { info: { title: 'Underlay API', version: '1.0.0' } },
  { routeName: '/api/openapi.json' },
)

app.get('/api/reference', Scalar({ url: '/api/openapi.json', pageTitle: 'Underlay API' }))

// --- Blog content API (serves rendered markdown) ---
app.get('/api/blog/:slug', (c) => {
  const slug = c.req.param('slug')
  const mdPath = resolve('content/blog', `${slug}.md`)
  if (!existsSync(mdPath)) {
    return c.json({ error: 'Not found', statusCode: 404 }, 404)
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
  // Serve public/ folder files (favicon, wasm, llms.txt, etc.)
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

    let page = fill(template, '<!--ssr-outlet-->', html)
    page = fill(
      page,
      '<!--ssr-data-->',
      `<script>window.__staticRouterHydrationData=${hydrationData}</script>`,
    )

    if (title) {
      page = fill(page, '<title>Underlay</title>', `<title>${escapeHtml(title)}</title>`)
    }
    if (description) {
      page = fill(
        page,
        '</head>',
        `<meta name="description" content="${escapeHtml(description)}" />\n</head>`,
      )
    }

    return c.html(page, statusCode ?? 200)
  })
} else {
  devHttpServer = createHttpServer()
  const { createServer: createViteServer } = await import('vite')
  vite = await createViteServer({
    server: { middlewareMode: true, hmr: { server: devHttpServer, port: 24678 } },
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

    let page = fill(template, '<!--ssr-outlet-->', html)
    page = fill(
      page,
      '<!--ssr-data-->',
      `<script>window.__staticRouterHydrationData=${hydrationData}</script>`,
    )

    if (title) {
      page = fill(page, '<title>Underlay</title>', `<title>${escapeHtml(title)}</title>`)
    }
    if (description) {
      page = fill(
        page,
        '</head>',
        `<meta name="description" content="${escapeHtml(description)}" />\n</head>`,
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
