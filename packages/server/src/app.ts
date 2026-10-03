/**
 * The Hono app. Runtime-agnostic: each entry (Node, Worker) supplies a function
 * that builds the ports and config for a request, and everything below reads
 * them from the context.
 */
import { type Context, Hono } from 'hono'

import type { Ports } from './ports.js'

export interface AppConfig {
  /** Public origin, e.g. https://staging.underlay.org */
  appUrl: string
  /** "staging", "next", "production" or "dev": shown in /api/health. */
  deployment: string
}

export type AppEnv = {
  Bindings: Record<string, unknown>
  Variables: {
    ports: Ports
    config: AppConfig
  }
}

/**
 * Builds a request's ports and config. Runs per request: on Workers, bindings and
 * the execution context belong to the invocation.
 */
export type Setup = (c: Context<AppEnv>) => { ports: Ports; config: AppConfig }

export function createApp(setup: Setup) {
  const app = new Hono<AppEnv>()

  app.use('*', async (c, next) => {
    const { ports, config } = setup(c)
    c.set('ports', ports)
    c.set('config', config)
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

  app.notFound((c) => c.json({ error: 'Not found', statusCode: 404 }, 404))
  app.onError((err, c) => {
    console.error('[app]', err)
    return c.json({ error: 'Internal error', statusCode: 500 }, 500)
  })

  return app
}

export type App = ReturnType<typeof createApp>
