/**
 * The Hono app. Runtime-agnostic: each entry (Node, Worker) supplies a function
 * that builds the ports, config and authenticator for a request, and everything
 * below reads them from the context.
 */
import { type Context, type ExecutionContext, Hono } from 'hono'

import type { Principal } from './api/access.js'
import { accountRoutes } from './api/accounts.js'
import { adminRoutes } from './api/admin.js'
import { agentRoutes } from './api/agent.js'
import { arkRoutes } from './api/ark.js'
import { avatarRoutes } from './api/avatars.js'
import { cleanupRoutes } from './api/cleanup.js'
import { collectionRoutes } from './api/collections.js'
import { exportRoutes } from './api/export.js'
import { fileRoutes } from './api/files.js'
import { locationRoutes } from './api/locations.js'
import { manageRoutes } from './api/manage.js'
import { pushRoutes } from './api/push.js'
import { recordRoutes } from './api/records.js'
import { schemaRoutes } from './api/schemas.js'
import { statsRoutes } from './api/stats.js'
import { syncRoutes } from './api/sync.js'
import { versionRoutes } from './api/versions.js'
import { webhookRoutes } from './api/webhooks.js'
import type { Kf } from './auth/kf.js'
import { type Meter, meter, newMeter } from './billing/usage.js'
import { clientIp, requestCost } from './lib/limits.js'
import type { Ports } from './ports.js'

export interface AppConfig {
  /** Public origin, e.g. https://staging.underlay.org */
  appUrl: string
  /** "staging", "next", "production" or "dev": shown in /api/health. */
  deployment: string
  /** KF Auth URLs the UI links to (account settings, sign-out). */
  kfAuthUrl?: string | undefined
  kfAccountUrl?: string | undefined
}

export type Authenticate = (req: Request, ports: Ports) => Promise<Principal | null>

/**
 * What one page view's in-process API calls share: the caller, authenticated
 * once for the page, and collection access, resolved once per collection.
 */
export interface PageContext {
  principal: Principal | null
  access: Map<string, Promise<unknown>>
}

export type AppEnv = {
  Bindings: Record<string, unknown>
  Variables: {
    ports: Ports
    config: AppConfig
    principal: Principal | null
    /** KF Auth profile and orgs; null where the deployment has no KF Auth. */
    kf: Kf | null
    /** This request's usage (billing/usage.ts). */
    meter: Meter
    /** Set on the page renderer's in-process API calls: what the page's calls share. */
    page: PageContext | null
  }
}

/**
 * Builds a request's ports, config and authenticator. Runs per request: on
 * Workers, bindings and the execution context belong to the invocation.
 */
export type Setup = (c: Context<AppEnv>) => {
  ports: Ports
  config: AppConfig
  authenticate: Authenticate
  kf?: Kf
  /** better-auth's own routes (/api/auth/*): sign-in, callbacks, sessions, keys, orgs. */
  authHandler?: (req: Request) => Promise<Response>
  /**
   * Server-side rendering of UI pages (packages/web). `api` calls this app
   * in-process: a Worker can't fetch its own zone (build doc finding 9), and on
   * Node it saves a loopback round trip.
   */
  renderPage?: RenderPage
}

export type RenderPage = (
  req: Request,
  api: (req: Request) => Promise<Response>,
) => Promise<Response>

export function createApp(setup: Setup) {
  const app = new Hono<AppEnv>()
  /** Requests the page renderer makes to this app in-process, with their page's context. */
  const inProcess = new WeakMap<Request, PageContext>()

  // better-auth's org update and delete skip Underlay's rules (slugs, logos, the
  // check that an org holds no collections). The account routes do both.
  app.post('/api/auth/organization/update', (c) =>
    c.json({ error: 'Update an organization with PATCH /api/accounts/:slug' }, 404),
  )
  app.post('/api/auth/organization/delete', (c) =>
    c.json({ error: 'Delete an organization with DELETE /api/accounts/:slug' }, 404),
  )

  // The auth routes come before the principal is known: their budget is the IP's.
  app.use('/api/auth/*', async (c, next) => {
    const limiter = setup(c).ports.rateLimit
    if (!limiter || inProcess.has(c.req.raw)) return next()
    if (await limiter.check('page', `auth:${clientIp(c.req.raw.headers)}`)) return next()
    c.header('Retry-After', '60')
    return c.json({ error: 'Rate limit exceeded', statusCode: 429 }, 429)
  })

  app.on(['GET', 'POST'], '/api/auth/*', (c) => {
    const { authHandler } = setup(c)
    return authHandler
      ? authHandler(c.req.raw)
      : c.json({ error: 'Auth is not configured', statusCode: 404 }, 404)
  })

  // Pages that moved: the protocol into the docs, the steward hub to /admin.
  app.get('/protocol', (c) => c.redirect('/docs/protocol', 301))
  app.get('/superadmin', (c) => c.redirect('/admin', 301))

  // Old blog URLs: the posts moved to the KF site under the same slugs
  // (web's lib/kf-updates.ts links there too). `blog` is a reserved org slug.
  const KF_SITE = 'https://www.knowledgefutures.org'
  app.get('/blog', (c) => c.redirect(`${KF_SITE}/?tag=underlay`, 301))
  app.get('/blog/:slug', (c) => {
    const slug = c.req.param('slug')
    return /^[a-z0-9-]+$/i.test(slug)
      ? c.redirect(`${KF_SITE}/updates/${slug.toLowerCase()}`, 301)
      : c.redirect(`${KF_SITE}/?tag=underlay`, 301)
  })

  // The UI's sign-in links point here; the page itself only shows errors (as v1's
  // server.ts). Without this, /login renders a page that redirects to /login.
  app.get('/login', async (c, next) => {
    const { authHandler, config } = setup(c)
    if (!authHandler || c.req.query('error') !== undefined) return next()
    const origin = new URL(config.appUrl).origin
    // Only a path on this site: an open redirect would hand sign-ins to anyone.
    const returnTo = c.req.query('return_to') ?? ''
    const callbackURL = /^\/(?![/\\])/.test(returnTo) ? returnTo : '/dashboard'
    const headers = new Headers({
      'content-type': 'application/json',
      cookie: c.req.header('cookie') ?? '',
      origin,
    })
    const res = await authHandler(
      new Request(`${origin}/api/auth/sign-in/oauth2`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          providerId: 'kf-auth',
          callbackURL,
          errorCallbackURL: '/login',
        }),
      }),
    )
    const body = (await res.json().catch(() => null)) as { url?: string } | null
    if (!body?.url) return next()
    const redirect = new Response(null, { status: 302, headers: { location: body.url } })
    for (const cookie of res.headers.getSetCookie()) redirect.headers.append('set-cookie', cookie)
    return redirect
  })

  app.use('*', async (c, next) => {
    const { ports, config, authenticate, kf } = setup(c)
    c.set('ports', ports)
    c.set('config', config)
    c.set('kf', kf ?? null)
    const page = inProcess.get(c.req.raw) ?? null
    c.set('page', page)
    try {
      c.set('principal', page ? page.principal : await authenticate(c.req.raw, ports))
    } catch (err) {
      if ((err as Error).name !== 'InvalidKeyError') throw err
      return c.json({ error: (err as Error).message, statusCode: 401 }, 401)
    }
    c.set('meter', newMeter())
    await next()
  })

  // Usage (billing/usage.ts): a collection API call and its response bytes, billed
  // to the collection's owner, plus whatever the route metered. A page's own
  // in-process API calls are part of the page view, which isn't metered.
  app.use('/api/*', async (c, next) => {
    await next()
    const sink = c.var.ports.usage
    if (inProcess.has(c.req.raw) || !sink) return
    const m = c.var.meter
    if (!m.collection) {
      if (m.events.length) sink.record(m.events)
      return
    }
    meter(m, 'api_calls', 1)
    // The call and what the route metered count now, whatever becomes of the body.
    sink.record(m.events.slice())
    const body = c.res.body
    if (!body) return
    // Response bytes are counted as they go out (most responses don't know their
    // length up front), and recorded when the body ends or the client goes away.
    const sent = m.events.length
    let bytes = 0
    let done = false
    const finish = () => {
      if (done) return
      done = true
      meter(m, 'response_bytes', m.logicalBytes ?? bytes)
      sink.record(m.events.slice(sent))
    }
    const counted = body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, ctl) {
          bytes += chunk.byteLength
          ctl.enqueue(chunk)
        },
        flush: finish,
        cancel: finish,
      } as Transformer<Uint8Array, Uint8Array>),
    )
    c.res = new Response(counted, c.res)
  })

  // Request budgets (lib/limits.ts): API calls, pages and ARK alike. The page
  // renderer's in-process API calls are part of the page view that made them,
  // so they don't count again.
  app.use('*', async (c, next) => {
    const limiter = c.var.ports.rateLimit
    if (!limiter || inProcess.has(c.req.raw) || c.req.method === 'OPTIONS') return next()
    const p = c.var.principal
    const cost = requestCost(c.req.path)
    const kind = c.req.path.startsWith('/api/') ? 'anon' : 'page'
    const ok = p
      ? await limiter.check('user', p.orgId ?? p.userId, cost)
      : await limiter.check(kind, clientIp(c.req.raw.headers), cost)
    if (ok) return next()
    c.header('Retry-After', '60')
    return c.json({ error: 'Rate limit exceeded', statusCode: 429 }, 429)
  })

  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      version: 2,
      deployment: c.var.config.deployment,
      time: new Date().toISOString(),
    }),
  )

  app.route('/', arkRoutes())
  // Agent links (web's share panel): a page, budgeted as one above.
  app.route('/', agentRoutes())
  // Before the :owner/:slug routes: /api/collections/files/:hash would match them.
  app.route('/', recordRoutes())
  app.route('/api/collections', fileRoutes())
  app.route('/api/collections', exportRoutes())
  app.route('/api/collections', pushRoutes())
  app.route('/api/collections', versionRoutes())
  app.route('/api/collections', syncRoutes())
  app.route('/api/collections', webhookRoutes())
  app.route('/', schemaRoutes())
  app.route('/', manageRoutes())
  app.route('/', avatarRoutes())
  app.route('/', locationRoutes())
  // Before collectionRoutes: /api/accounts/me would match /api/accounts/:slug.
  app.route('/', accountRoutes())
  app.route('/', adminRoutes())
  app.route('/', cleanupRoutes())
  app.route('/', statsRoutes())
  app.route('/', collectionRoutes())

  // Everything else is a UI page, when the deployment renders one.
  app.get('*', async (c) => {
    const { renderPage } = setup(c)
    if (!renderPage || c.req.path.startsWith('/api/'))
      return c.json({ error: 'Not found', statusCode: 404 }, 404)
    // Hono throws reading executionCtx where there is none (Node).
    let ctx: ExecutionContext | undefined
    try {
      ctx = c.executionCtx
    } catch {
      ctx = undefined
    }
    const page: PageContext = { principal: c.var.principal, access: new Map() }
    return renderPage(c.req.raw, async (req) => {
      inProcess.set(req, page)
      return app.fetch(req, c.env, ctx)
    })
  })

  app.notFound((c) => c.json({ error: 'Not found', statusCode: 404 }, 404))
  app.onError((err, c) => {
    // Per-user caps (push/session.ts) are the caller's to fix, not ours.
    if (err.name === 'SessionCapError') {
      c.header('Retry-After', '60')
      return c.json({ error: err.message, statusCode: 429 }, 429)
    }
    // Storage cleanup held a write past its patience (cleanup/fence.ts): brief.
    if (err.name === 'StorageBusyError' || err.name === 'FenceError') {
      c.header('Retry-After', '30')
      return c.json({ error: err.message, statusCode: 503 }, 503)
    }
    console.error('[app]', err)
    return c.json({ error: 'Internal error', statusCode: 500 }, 500)
  })

  return app
}

export type App = ReturnType<typeof createApp>
