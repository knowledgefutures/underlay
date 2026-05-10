import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from '@hono/node-server/serve-static'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { marked } from 'marked'

import type { AuthEnv } from '~/api/auth.server'
import { authMiddleware } from '~/api/auth.server'
import { healthRoutes } from '~/api/health'
import { accountRoutes } from '~/api/accounts'
import { collectionsRoutes } from '~/api/collections'
import { versionRoutes } from '~/api/versions'
import { uploadRoutes } from '~/api/uploads'
import { fileRoutes } from '~/api/files'
import { schemaRoutes } from '~/api/schemas'
import { adminRoutes } from '~/api/admin'
import { queryRoutes } from '~/api/query'
import { arkRoutes } from '~/api/ark'
import { arkMiddleware } from '~/api/ark-middleware.server'

const isProd = process.env.NODE_ENV === 'production'
const app = new Hono<AuthEnv>()

// --- CORS ---
app.use('/api/*', cors({ origin: '*', credentials: true }))

// --- Auth middleware for API routes ---
app.use('/api/*', authMiddleware)

// --- ARK resolution middleware ---
app.use('/ark\\:*', arkMiddleware)

// --- API routes ---
app.route('/api', healthRoutes)
app.route('/api', accountRoutes)
app.route('/api', collectionsRoutes)
app.route('/api', versionRoutes)
app.route('/api', uploadRoutes)
app.route('/api', fileRoutes)
app.route('/api', schemaRoutes)
app.route('/api', adminRoutes)
app.route('/api', queryRoutes)
app.route('/api', arkRoutes)

// API 404 catch-all
app.all('/api/*', (c) => {
  return c.json({ error: 'API route not found', statusCode: 404 }, 404)
})

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

// --- SSR ---
if (isProd) {
  // Serve static assets from Vite build output
  app.use('/assets/*', serveStatic({ root: './dist/client' }))
  app.use('/favicon.svg', serveStatic({ root: './dist/client' }))

  // Run migrations on startup
  const { runMigrations } = await import('~/db/migrate')
  await runMigrations()

  app.get('*', async (c) => {
    const { render } = await import('./dist/server/entry-server.js' as string)
    const template = readFileSync(resolve('dist/client/index.html'), 'utf-8')
    const { html, ssrData, redirect, statusCode, title, description } = await render(c.req.raw)

    if (redirect) {
      return c.redirect(redirect, 302)
    }

    let page = template
      .replace('<!--ssr-outlet-->', html)
      .replace(
        '<!--ssr-data-->',
        `<script>window.__SSR_DATA__=${JSON.stringify(ssrData).replace(/</g, '\\u003c')}</script>`,
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
  const { createServer: createViteServer } = await import('vite')
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: 'custom',
  })

  // Vite's Connect middleware for HMR and asset transforms
  app.use('*', async (c, next) => {
    const nodeReq = (c.env as any).incoming
    const nodeRes = (c.env as any).outgoing
    if (!nodeReq || !nodeRes) return next()
    return new Promise<Response | void>((resolve) => {
      vite.middlewares(nodeReq, nodeRes, () => resolve(next()))
    })
  })

  app.get('*', async (c) => {
    const url = c.req.url
    let template = readFileSync(resolve('index.html'), 'utf-8')
    template = await vite.transformIndexHtml(url, template)

    const { render } = await vite.ssrLoadModule('/src/entry-server.tsx')
    const { html, ssrData, redirect, statusCode, title, description } = await render(c.req.raw)

    if (redirect) {
      return c.redirect(redirect, 302)
    }

    let page = template
      .replace('<!--ssr-outlet-->', html)
      .replace(
        '<!--ssr-data-->',
        `<script>window.__SSR_DATA__=${JSON.stringify(ssrData).replace(/</g, '\\u003c')}</script>`,
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
console.log(`Server running at http://localhost:${port}`)
serve({ fetch: app.fetch, port })
