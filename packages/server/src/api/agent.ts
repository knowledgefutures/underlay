/**
 * Agent links (v1's `src/api/agent.ts`, for v2's delta push):
 *
 *   GET /agent/:token        an HTML page that tells an AI agent how to push to one collection
 *
 * The token is an API key the share panel (web's share-panel.tsx) creates: a
 * write key confined to one collection, with `agentShare: true` in its
 * metadata, expiring in an hour. The page is the key's instructions; the key
 * itself is what authorizes the pushes, through the usual API.
 *
 * A token that isn't such a key, has expired or been revoked, or whose holder
 * can no longer write to the collection is a 404 page. A path segment that
 * isn't key-shaped (`ul_…`) falls through to the UI: collection slugs have no
 * underscore, so an org named "agent" keeps its collection pages.
 */
import { and, eq } from 'drizzle-orm'
import { type Context, Hono } from 'hono'

import type { AppEnv } from '../app.js'
import * as schema from '../db/schema.js'
import { findVersion, loadView, typeRecords } from '../versions/view.js'
import { collectionAccess, type Principal } from './access.js'

const DEFAULT_SCHEMA_SLUG = 'update'
const DEFAULT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    key_points: { type: 'array', items: { type: 'string' } },
    source: { type: 'string' },
    timestamp: { type: 'string' },
  },
  required: ['title', 'summary'],
  additionalProperties: false,
}

/** Example records shown, and the largest record body shown as one. */
const EXAMPLES = 3
const MAX_EXAMPLE_BYTES = 4 * 1024

const KEY_SHAPE = /^ul_[A-Za-z0-9]{8,256}$/

const escapeHtml = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

/** better-auth stores JSON columns as strings, older rows twice over (auth/auth.ts). */
function jsonColumn<T>(v: unknown): T | null {
  let out = v
  for (let i = 0; i < 2 && typeof out === 'string'; i++) {
    try {
      out = JSON.parse(out)
    } catch {
      return null
    }
  }
  return (out as T) ?? null
}

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

/**
 * The agent key `token`, if it is one: a live write key confined to exactly one
 * collection and made for an agent link. Read from its row as auth/auth.ts
 * verifyKey does (better-auth's hash of the key), without counting a use.
 */
async function agentKey(c: Context<AppEnv>, token: string) {
  const hashed = b64url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))),
  )
  const { db } = c.var.ports
  const [row] = await db
    .select()
    .from(schema.apikey)
    .where(and(eq(schema.apikey.key, hashed), eq(schema.apikey.configId, 'default')))
    .limit(1)
  if (!row || row.enabled === false) return null
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null
  if (row.remaining !== null && row.remaining <= 0) return null
  const perms = jsonColumn<Record<string, string[]>>(row.permissions)?.collections ?? []
  if (!perms.includes('write')) return null
  const meta = jsonColumn<{ agentShare?: unknown; collectionIds?: unknown }>(row.metadata)
  const ids = meta?.collectionIds
  if (meta?.agentShare !== true || !Array.isArray(ids) || ids.length !== 1) return null
  if (typeof ids[0] !== 'string') return null
  const [org] = await db
    .select({ id: schema.organization.id })
    .from(schema.organization)
    .where(eq(schema.organization.id, row.referenceId))
    .limit(1)
  const principal: Principal = {
    userId: row.referenceId,
    scope: perms.includes('admin') ? 'admin' : 'write',
    collectionIds: [ids[0]],
    ...(org ? { orgId: org.id } : {}),
  }
  return { principal, collectionId: ids[0], expiresAt: row.expiresAt }
}

/** Every agent page: no scripts, no sniffing, no indexing; never cached (it holds a key). */
const HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex',
}

const invalid = (c: Context<AppEnv>) =>
  c.html(
    `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Invalid agent link</title></head><body>
<h1>Invalid or expired agent link</h1>
<p>This agent link is no longer valid. Ask the collection's owner for a new one.</p>
</body></html>`,
    404,
    HEADERS,
  )

const json = (v: unknown) => escapeHtml(JSON.stringify(v, null, 2))

export function agentRoutes() {
  const app = new Hono<AppEnv>()

  app.get('/agent/:token', async (c, next) => {
    const token = c.req.param('token')
    if (!token.startsWith('ul_')) return next()
    if (!KEY_SHAPE.test(token)) return invalid(c)
    const key = await agentKey(c, token)
    if (!key) return invalid(c)
    const { db } = c.var.ports
    const [where] = await db
      .select({ owner: schema.organization.slug, slug: schema.collections.slug })
      .from(schema.collections)
      .innerJoin(schema.organization, eq(schema.organization.id, schema.collections.organizationId))
      .where(eq(schema.collections.id, key.collectionId))
      .limit(1)
    if (!where) return invalid(c)
    // A key's collectionIds are whatever its creator wrote, so the key's holder
    // must still be able to write here: this page shows schemas and records.
    const access = await collectionAccess(db, key.principal, where.owner, where.slug)
    if (!access?.canWrite) return invalid(c)
    const coll = access.collection

    const head = await findVersion(db, coll.id, 'latest', coll.headVersionId)
    const repo = await c.var.ports.stores.forCollection(coll.id)
    const view = head ? await loadView(repo, head, true) : null
    const schemas: { slug: string; schema: unknown }[] = view
      ? await Promise.all(
          view.types.map(async (t) => ({ slug: t.slug, schema: await repo.schema(t.schemaHash) })),
        )
      : []
    const examples: { id: string; type: string; data: unknown; private?: true }[] = []
    if (view && view.types[0]) {
      for await (const e of typeRecords(view, view.types[0], { bodies: true })) {
        if (!e.body || e.body.length > MAX_EXAMPLE_BYTES) continue
        const r = JSON.parse(e.body) as { id: string; type: string; data: unknown }
        examples.push({
          id: r.id,
          type: r.type,
          data: r.data,
          ...(e.set === 'private' ? { private: true as const } : {}),
        })
        if (examples.length === EXAMPLES) break
      }
    }
    const metadata = (view?.root.metadata ?? null) as Record<string, unknown> | null
    const description =
      (typeof metadata?.description === 'string' ? metadata.description : null) ??
      coll.summary?.description ??
      ''

    // The request's origin; the configured one when it names the same host, since
    // behind a TLS-terminating proxy the request may say http.
    const reqUrl = new URL(c.req.url)
    const appUrl = new URL(c.var.config.appUrl)
    const origin = reqUrl.host === appUrl.host ? appUrl.origin : reqUrl.origin
    const collPath = `${access.owner.slug}/${coll.slug}`
    const api = `${origin}/api/collections/${collPath}`
    const llmsTxt = `${origin}/llms.txt`
    const hasSchemas = schemas.length > 0
    const shown = hasSchemas ? schemas : [{ slug: DEFAULT_SCHEMA_SLUG, schema: DEFAULT_SCHEMA }]
    const exampleType = shown[0]!.slug
    const exampleProps =
      (shown[0]!.schema as { properties?: Record<string, { type?: unknown }> }).properties ?? {}
    const exampleData: Record<string, unknown> = {}
    for (const [k, p] of Object.entries(exampleProps)) {
      exampleData[k] = p.type === 'string' ? `your ${k} here` : p.type === 'array' ? [] : null
    }
    const openBody = {
      base: head?.semver ?? null,
      message: 'Added an update from a conversation',
      ...(hasSchemas ? {} : { schemas: { [DEFAULT_SCHEMA_SLUG]: DEFAULT_SCHEMA } }),
    }
    const recordLines = [
      { id: 'update-1', type: exampleType, data: exampleData },
      { id: 'update-2', type: exampleType, data: exampleData, private: true },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n')
    const e = escapeHtml
    const expires = key.expiresAt
      ? `${e(key.expiresAt.toISOString())}. If requests start returning 401, ask the collection's owner for a new link.`
      : 'Never.'

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Agent: ${e(collPath)}</title>
<style>
body { font-family: system-ui, -apple-system, sans-serif; max-width: 760px; margin: 0 auto; padding: 2rem; line-height: 1.6; color: #1a1a1a; }
h1 { font-size: 1.4rem; margin-bottom: 0.25rem; }
h2 { margin-top: 2rem; font-size: 1.1rem; border-bottom: 1px solid #ddd; padding-bottom: 0.3rem; }
h3 { margin-top: 1.5rem; font-size: 0.95rem; }
pre { background: #f5f5f0; padding: 1rem; overflow-x: auto; border: 1px solid #e0e0d8; font-size: 0.8125rem; border-radius: 4px; }
code { background: #f5f5f0; padding: 0.125rem 0.35rem; font-size: 0.8125rem; border-radius: 3px; }
table.kv { border-collapse: collapse; width: 100%; margin: 1rem 0; }
table.kv th { text-align: left; padding: 0.4rem 1rem 0.4rem 0; color: #666; font-weight: 500; font-size: 0.8125rem; vertical-align: top; width: 150px; }
table.kv td { padding: 0.4rem 0; font-size: 0.875rem; overflow-wrap: anywhere; }
table.kv tr { border-bottom: 1px solid #eee; }
.subtitle { color: #666; font-size: 0.875rem; margin-top: 0; }
.note { background: #f0f4ff; border: 1px solid #d0d8f0; border-radius: 4px; padding: 0.75rem 1rem; font-size: 0.8125rem; margin: 1rem 0; }
a { color: #1a6dcc; }
</style>
</head>
<body>

<h1>Agent write access</h1>
<p class="subtitle">This page grants temporary write access to one Underlay collection. It is written for an AI agent. The token in this page's URL is an API key: send it as a Bearer token on every request below.</p>

<h2>Collection</h2>
<table class="kv">
<tr><th>Collection</th><td><strong>${e(collPath)}</strong></td></tr>
<tr><th>Name</th><td>${e(coll.name)}</td></tr>
${description ? `<tr><th>Description</th><td>${e(description)}</td></tr>` : ''}
<tr><th>Current version</th><td>${head ? `<code>${e(head.semver)}</code>` : 'None (empty collection)'}</td></tr>
${head ? `<tr><th>Records</th><td>${head.recordCount.toLocaleString('en-US')}</td></tr>` : ''}
<tr><th>API key</th><td><code>${e(token)}</code></td></tr>
<tr><th>Key expires</th><td>${expires}</td></tr>
<tr><th>Key scope</th><td>Write access to <strong>this collection only</strong>. Other collections answer 404, and account, organization and collection-management endpoints refuse the key.</td></tr>
<tr><th>Collection page</th><td><a href="${e(`${origin}/${collPath}`)}">${e(`${origin}/${collPath}`)}</a></td></tr>
</table>

<h2>Schema</h2>
${
  hasSchemas
    ? schemas
        .map((s) => `<h3>Type <code>${e(s.slug)}</code></h3>\n<pre>${json(s.schema)}</pre>`)
        .join('\n')
    : `<p>This collection has <strong>no types yet</strong>. Send a schema when you open the push session; this default is recommended:</p>
<div class="note">
<strong>Default schema</strong>, type <code>${e(DEFAULT_SCHEMA_SLUG)}</code>
<pre>${json(DEFAULT_SCHEMA)}</pre>
<code>title</code> and <code>summary</code> are required; the other fields are optional.
</div>`
}
${
  examples.length
    ? `<h3>Example records from the current version</h3>\n<pre>${json(examples)}</pre>`
    : '<p>The collection has no records yet: yours will be the first.</p>'
}

<h2>How to write</h2>
<p>Every write is a <strong>delta push</strong>: open a session against the current version, upload the records you add or change, then commit. Records you don't send are kept as they are. Authenticate every request with the API key above.</p>

<div class="note">The full reference (record rules, files, deletes, privacy, errors) is <a href="${e(llmsTxt)}">${e(llmsTxt)}</a>. The steps below are all an update needs.</div>

<h3>Step 1: Open a session</h3>
<pre>POST ${e(`${api}/push`)}
Authorization: Bearer ${e(token)}
Content-Type: application/json

${json(openBody)}</pre>
<table class="kv">
<tr><th>base</th><td>The version you are building on: <code>${head ? e(head.semver) : 'null'}</code> now. Use <code>null</code> for the first push. If someone publishes first, this is a 409 with <code>currentVersion</code>: open the session again with that as <code>base</code>.</td></tr>
<tr><th>schemas</th><td>${
      hasSchemas
        ? 'Leave it out to keep the collection&rsquo;s types. If you send it, it is the <strong>full</strong> type set: a type you leave out is removed with all its records.'
        : `Required on the first push: a map of type name to JSON Schema, as above.`
    }</td></tr>
<tr><th>message</th><td>Optional: what this update is.</td></tr>
</table>
<p>The response carries <code>session_id</code>, used in the next two steps.</p>

<h3>Step 2: Upload records</h3>
<pre>POST ${e(`${api}/push/`)}&lt;session_id&gt;/records
Authorization: Bearer ${e(token)}
Content-Type: application/x-ndjson

${e(recordLines)}</pre>
<p>One JSON object per line with <code>id</code>, <code>type</code> and <code>data</code>; <code>data</code> must match the type&rsquo;s schema. A record with an existing (type, id) replaces it. <code>"private": true</code> shows the record to members of the owning organization only; leaving it out makes the record public. Any invalid line is a 422 listing the lines to fix, and nothing from that request is stored.</p>

<h3>Step 3: Commit</h3>
<pre>POST ${e(`${api}/push/`)}&lt;session_id&gt;/commit
Authorization: Bearer ${e(token)}</pre>
<p>A 201 answers with the new version: <code>${e(JSON.stringify({ semver: 'v1.1.0', hash: 'ulv2:…', recordCount: 1, fileCount: 0 }))}</code>. A 409 &ldquo;Version conflict&rdquo; means someone published after you opened the session: open a new one with the current version as <code>base</code> and upload again.</p>

<h2>Endpoints</h2>
<table class="kv">
<tr><th>Current version</th><td><code>GET ${e(`${api}/versions/latest`)}</code> (404 when there is none)</td></tr>
<tr><th>Schemas</th><td><code>GET ${e(`${api}/schemas`)}</code></td></tr>
<tr><th>Open a session</th><td><code>POST ${e(`${api}/push`)}</code></td></tr>
<tr><th>Upload records</th><td><code>POST ${e(`${api}/push/`)}&lt;session_id&gt;/records</code></td></tr>
<tr><th>Commit</th><td><code>POST ${e(`${api}/push/`)}&lt;session_id&gt;/commit</code></td></tr>
<tr><th>Session status</th><td><code>GET ${e(`${api}/push/`)}&lt;session_id&gt;</code></td></tr>
<tr><th>Reference</th><td><a href="${e(llmsTxt)}">${e(llmsTxt)}</a> and <a href="${e(`${origin}/docs`)}">${e(`${origin}/docs`)}</a></td></tr>
</table>

</body>
</html>`

    // The URL and the page carry a write key: keep both out of caches and out
    // of the Referer of any link followed from here.
    return c.html(html, 200, HEADERS)
  })

  return app
}
