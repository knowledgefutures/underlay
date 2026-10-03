/**
 * The Hono app. Runtime-agnostic: each entry (Node, Worker) supplies a function
 * that builds the ports, config and authenticator for a request, and everything
 * below reads them from the context.
 */
import { type Context, Hono } from 'hono'

import type { Principal } from './api/access.js'
import { collectionRoutes } from './api/collections.js'
import { fileRoutes } from './api/files.js'
import { pushRoutes } from './api/push.js'
import { versionRoutes } from './api/versions.js'
import type { Ports } from './ports.js'

export interface AppConfig {
  /** Public origin, e.g. https://staging.underlay.org */
  appUrl: string
  /** "staging", "next", "production" or "dev": shown in /api/health. */
  deployment: string
  /** KF Auth URLs the UI links to (account settings, sign-out). */
  kfAuthUrl?: string
  kfAccountUrl?: string
}

export type Authenticate = (req: Request, ports: Ports) => Promise<Principal | null>

export type AppEnv = {
  Bindings: Record<string, unknown>
  Variables: {
    ports: Ports
    config: AppConfig
    principal: Principal | null
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
  /** better-auth's own routes (/api/auth/*): sign-in, callbacks, sessions, keys, orgs. */
  authHandler?: (req: Request) => Promise<Response>
}

export function createApp(setup: Setup) {
  const app = new Hono<AppEnv>()

  app.on(['GET', 'POST'], '/api/auth/*', (c) => {
    const { authHandler } = setup(c)
    return authHandler
      ? authHandler(c.req.raw)
      : c.json({ error: 'Auth is not configured', statusCode: 404 }, 404)
  })

  app.use('*', async (c, next) => {
    const { ports, config, authenticate } = setup(c)
    c.set('ports', ports)
    c.set('config', config)
    c.set('principal', await authenticate(c.req.raw, ports))
    await next()
  })

  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      version: 2,
      deployment: c.var.config.deployment,
      time: new Date().toISOString(),
    }),
  )

  app.route('/api/collections', fileRoutes())
  app.route('/api/collections', pushRoutes())
  app.route('/api/collections', versionRoutes())
  app.route('/', collectionRoutes())

  app.notFound((c) => c.json({ error: 'Not found', statusCode: 404 }, 404))
  app.onError((err, c) => {
    console.error('[app]', err)
    return c.json({ error: 'Internal error', statusCode: 500 }, 500)
  })

  return app
}

export type App = ReturnType<typeof createApp>
