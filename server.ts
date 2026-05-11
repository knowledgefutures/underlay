import { serve, } from '@hono/node-server'
import { serveStatic, } from '@hono/node-server/serve-static'
import { Hono, } from 'hono'
import { cors, } from 'hono/cors'
import { marked, } from 'marked'
import { existsSync, readFileSync, } from 'node:fs'
import { resolve, } from 'node:path'

import * as accounts from '~/api/accounts'
import * as admin from '~/api/admin'
import * as ark from '~/api/ark'
import { arkMiddleware, } from '~/api/ark-middleware.server'
import type { AuthEnv, } from '~/api/auth.server'
import { authMiddleware, requireAuth, } from '~/api/auth.server'
import * as collections from '~/api/collections'
import * as files from '~/api/files'
import * as health from '~/api/health'
import * as query from '~/api/query'
import * as schemas from '~/api/schemas'
import * as uploads from '~/api/uploads'
import * as versions from '~/api/versions'
import { getMirrorConfig, } from '~/lib/mirror-config'

const isProd = process.env.NODE_ENV === 'production'
const app = new Hono<AuthEnv>()

// --- CORS ---
app.use('/api/*', cors({ origin: '*', credentials: true, },),)

// --- Auth middleware for API routes ---
app.use('/api/*', authMiddleware,)

// --- Mirror mode guard for admin routes ---
app.use('/api/admin/*', async (c, next,) => {
  const config = getMirrorConfig()
  if (!config.enabled) {
    return c.json({ error: 'Not found', statusCode: 404, }, 404,)
  }
  await next()
},)

// --- ARK resolution middleware ---
app.use('/ark\\:*', arkMiddleware,)

// --- API routes ---
app.get('/api/health', health.check,)

// Admin (mirror)
app.get('/api/admin/mirror/status', admin.mirrorStatus,)
app.post('/api/admin/mirror/test', admin.mirrorTest,)
app.post('/api/admin/mirror/sync', admin.mirrorSync,)
app.post('/api/admin/mirror/sync/stop', admin.mirrorSyncStop,)
app.get('/api/admin/mirror/sync/progress', admin.mirrorSyncProgress,)
app.get('/api/admin/mirror/sync/active', admin.mirrorSyncActive,)
app.get('/api/admin/mirror/history', admin.mirrorHistory,)

// Query
app.get('/api/query/sqlite/:owner/:slug/:version', query.sqlite,)
app.get('/api/query/ddl/:owner/:slug/:version', query.ddl,)
app.post('/api/query/generate-sql', query.generateSql,)
app.get('/api/query/collections/search', query.searchCollections,)
app.get('/api/query/collections/:owner/:slug/versions', query.collectionVersions,)

// Schemas
app.get('/api/schemas', schemas.listSchemas,)
app.get('/api/schemas/:id', schemas.getSchema,)
app.get('/api/collections/:owner/:slug/schemas', schemas.collectionSchemas,)
app.post('/api/schemas/:id/labels', requireAuth('write',), schemas.addLabel,)
app.delete('/api/schemas/:id/labels/:label', requireAuth('admin',), schemas.removeLabel,)

// ARK
app.get('/api/ark/resolve', ark.resolve,)
app.get('/api/collections/:owner/:slug/ark', requireAuth('read',), ark.getArk,)
app.patch('/api/collections/:owner/:slug/ark', requireAuth('write',), ark.updateArk,)
app.get('/api/collections/:owner/:slug/ark/record-types', requireAuth('read',), ark.getArkRecordTypes,)
app.patch('/api/collections/:owner/:slug/ark/record-types', requireAuth('write',), ark.updateArkRecordTypes,)
app.patch('/api/accounts/:slug/ark', requireAuth('admin',), ark.updateAccountArk,)

// Collections
app.get('/api/collections', collections.list,)
app.post('/api/accounts/:owner/collections', requireAuth('write',), collections.create,)
app.get('/api/collections/:owner/:slug', collections.get,)
app.patch('/api/collections/:owner/:slug', requireAuth('write',), collections.update,)
app.delete('/api/collections/:owner/:slug', requireAuth('admin',), collections.remove,)
app.get('/api/accounts/:owner/collections', collections.listByOwner,)
app.get('/api/collections/:owner/:slug/export', collections.exportArchive,)

// Files
app.on('HEAD', '/api/collections/:owner/:slug/files/:hash', files.headFile,)
app.get('/api/collections/:owner/:slug/files/:hash', files.getFile,)
app.put('/api/collections/:owner/:slug/files/:hash', requireAuth('write',), files.putFile,)

// Uploads
app.post('/api/collections/:owner/:slug/versions/upload', requireAuth('write',), uploads.startSession,)
app.put('/api/collections/:owner/:slug/versions/upload/:sessionId', requireAuth('write',), uploads.appendBatch,)
app.get('/api/collections/:owner/:slug/versions/upload/:sessionId', requireAuth('read',), uploads.getSession,)
app.post('/api/collections/:owner/:slug/versions/upload/:sessionId/finalize', requireAuth('write',), uploads.finalize,)
app.delete('/api/collections/:owner/:slug/versions/upload/:sessionId', requireAuth('write',), uploads.cancelSession,)

// Versions
app.get('/api/collections/:owner/:slug/versions', versions.list,)
app.get('/api/collections/:owner/:slug/versions/latest', versions.latest,)
app.get('/api/collections/:owner/:slug/versions/:n', versions.getByNumber,)
app.get('/api/collections/:owner/:slug/versions/:n/records', versions.records,)
app.get('/api/collections/:owner/:slug/versions/:n/files', versions.files,)
app.get('/api/collections/:owner/:slug/versions/:n/manifest', versions.manifest,)
app.post('/api/collections/:owner/:slug/versions', requireAuth('write',), versions.push,)
app.get('/api/collections/:owner/:slug/versions/:n/diff', versions.diff,)

// Accounts
app.post('/api/accounts/signup', accounts.signup,)
app.post('/api/accounts/login', accounts.login,)
app.post('/api/accounts/logout', accounts.logout,)
app.get('/api/accounts/me', requireAuth(), accounts.getMe,)
app.get('/api/accounts/:slug', accounts.getBySlug,)
app.patch('/api/accounts/me', requireAuth(), accounts.updateMe,)
app.post('/api/accounts/me/email', requireAuth(), accounts.updateEmail,)
app.post('/api/accounts/me/password', requireAuth(), accounts.updatePassword,)
app.post('/api/accounts/me/avatar', requireAuth(), accounts.uploadAvatar,)
app.get('/api/accounts/me/sessions', requireAuth(), accounts.listSessions,)
app.delete('/api/accounts/me/sessions/:sessionId', requireAuth(), accounts.deleteSession,)
app.delete('/api/accounts/me', requireAuth(), accounts.deleteMe,)
app.post('/api/accounts/forgot-password', accounts.forgotPassword,)
app.post('/api/accounts/reset-password', accounts.resetPassword,)
app.post('/api/accounts/keys', requireAuth(), accounts.createKey,)
app.get('/api/accounts/keys', requireAuth(), accounts.listKeys,)
app.delete('/api/accounts/keys/:id', requireAuth(), accounts.deleteKey,)
app.post('/api/accounts/:slug/keys', requireAuth(), accounts.createOrgKey,)
app.get('/api/accounts/:slug/keys', requireAuth(), accounts.listOrgKeys,)
app.delete('/api/accounts/:slug/keys/:id', requireAuth(), accounts.deleteOrgKey,)
app.post('/api/accounts/orgs', requireAuth(), accounts.createOrg,)
app.get('/api/accounts/:slug/members', requireAuth(), accounts.listMembers,)
app.post('/api/accounts/:slug/members', requireAuth(), accounts.addMember,)
app.patch('/api/accounts/:slug/members/:userId', requireAuth(), accounts.updateMember,)
app.delete('/api/accounts/:slug/members/:userId', requireAuth(), accounts.removeMember,)
app.patch('/api/accounts/:slug', requireAuth(), accounts.updateOrg,)
app.post('/api/accounts/:slug/avatar', requireAuth(), accounts.uploadOrgAvatar,)
app.post('/api/accounts/:slug/invitations', requireAuth(), accounts.createInvitation,)
app.get('/api/accounts/:slug/invitations', requireAuth(), accounts.listInvitations,)
app.delete('/api/accounts/:slug/invitations/:id', requireAuth(), accounts.deleteInvitation,)
app.post('/api/accounts/invitations/accept', requireAuth(), accounts.acceptInvitation,)
app.delete('/api/accounts/:slug', requireAuth(), accounts.deleteOrg,)

// --- Blog content API (serves rendered markdown) ---
app.get('/api/blog/:slug', (c,) => {
  const slug = c.req.param('slug',)
  const mdPath = resolve('content/blog', `${slug}.md`,)
  if (!existsSync(mdPath,)) {
    return c.json({ error: 'Not found', }, 404,)
  }
  const raw = readFileSync(mdPath, 'utf-8',)
  // Strip frontmatter
  const fmEnd = raw.indexOf('---', 4,)
  const body = fmEnd > 0 ? raw.slice(fmEnd + 3,).trim() : raw
  const html = marked(body,)
  return c.html(typeof html === 'string' ? html : '',)
},)

// API 404 catch-all
app.all('/api/*', (c,) => {
  return c.json({ error: 'API route not found', statusCode: 404, }, 404,)
},)

// --- SSR ---
if (isProd) {
  // Verify SSR build artifacts exist at startup (fail fast, don't wait for first request)
  const clientHtml = resolve('dist/client/index.html',)
  const ssrBundle = resolve('dist/server/entry-server.js',)
  if (!existsSync(clientHtml,)) throw new Error(`Missing ${clientHtml} — did 'pnpm build' run?`,)
  if (!existsSync(ssrBundle,)) throw new Error(`Missing ${ssrBundle} — did 'pnpm build' run?`,)

  // Serve static assets from Vite build output
  app.use('/assets/*', serveStatic({ root: './dist/client', },),)
  app.use('/favicon.svg', serveStatic({ root: './dist/client', },),)

  // Run migrations on startup
  const { runMigrations, } = await import('~/db/migrate')
  await runMigrations()

  const template = readFileSync(clientHtml, 'utf-8',)
  const { render, } = await import(ssrBundle as string)

  app.get('*', async (c,) => {
    const { html, ssrData, redirect, statusCode, title, description, } = await render(c.req.raw,)

    if (redirect) {
      return c.redirect(redirect, 302,)
    }

    let page = template
      .replace('<!--ssr-outlet-->', html,)
      .replace(
        '<!--ssr-data-->',
        `<script>window.__SSR_DATA__=${JSON.stringify(ssrData,).replace(/</g, '\\u003c',)}</script>`,
      )

    if (title) {
      page = page.replace('<title>Underlay</title>', `<title>${title}</title>`,)
    }
    if (description) {
      page = page.replace(
        '</head>',
        `<meta name="description" content="${description.replace(/"/g, '&quot;',)}" />\n</head>`,
      )
    }

    return c.html(page, statusCode ?? 200,)
  },)
} else {
  const { createServer: createViteServer, } = await import('vite')
  const vite = await createViteServer({
    server: { middlewareMode: true, },
    appType: 'custom',
  },)

  // Vite's Connect middleware for HMR and asset transforms
  app.use('*', async (c, next,) => {
    const nodeReq = (c.env as any).incoming
    const nodeRes = (c.env as any).outgoing
    if (!nodeReq || !nodeRes) return next()
    return new Promise<Response | void>((resolve,) => {
      vite.middlewares(nodeReq, nodeRes, () => resolve(next(),),)
    },)
  },)

  app.get('*', async (c,) => {
    const url = c.req.url
    let template = readFileSync(resolve('index.html',), 'utf-8',)
    template = await vite.transformIndexHtml(url, template,)

    const { render, } = await vite.ssrLoadModule('/src/entry-server.tsx',)
    const { html, ssrData, redirect, statusCode, title, description, } = await render(c.req.raw,)

    if (redirect) {
      return c.redirect(redirect, 302,)
    }

    let page = template
      .replace('<!--ssr-outlet-->', html,)
      .replace(
        '<!--ssr-data-->',
        `<script>window.__SSR_DATA__=${JSON.stringify(ssrData,).replace(/</g, '\\u003c',)}</script>`,
      )

    if (title) {
      page = page.replace('<title>Underlay</title>', `<title>${title}</title>`,)
    }
    if (description) {
      page = page.replace(
        '</head>',
        `<meta name="description" content="${description.replace(/"/g, '&quot;',)}" />\n</head>`,
      )
    }

    return c.html(page, statusCode ?? 200,)
  },)
}

const port = Number(process.env.PORT,) || 3000
console.log(`Server running at http://localhost:${port}`,)
serve({ fetch: app.fetch, port, },)
