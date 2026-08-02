import { eq } from 'drizzle-orm'
import type { Context } from 'hono'

import { db, schema } from '../db/client.server.js'
import { auth } from '../lib/auth.js'
import { getLatestReadyVersion, loadVersionSchemas } from '../lib/version-helpers.server.js'

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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

async function verifyAgentKey(key: string) {
  try {
    const result = await auth.api.verifyApiKey({ body: { key } })
    if (!result?.valid || !result.key) return null
    const meta = (result.key as any).metadata as Record<string, any> | null
    if (!meta?.agentShare || !meta.collectionIds?.length) return null
    return {
      userId: (result.key as any).userId ?? (result.key as any).referenceId,
      collectionId: meta.collectionIds[0] as string,
    }
  } catch {
    return null
  }
}

// GET /agent/:token — HTML instruction page for AI agents
export async function agentPage(c: Context) {
  const token = c.req.param('token')!
  const keyInfo = await verifyAgentKey(token)

  if (!keyInfo) {
    return c.html(
      `<!DOCTYPE html><html><head><title>Invalid token</title></head><body>
<h1>Invalid or expired token</h1>
<p>This agent link is no longer valid. Ask the collection owner for a new link.</p>
</body></html>`,
      404,
    )
  }

  const [coll] = await db
    .select({
      id: schema.collections.id,
      slug: schema.collections.slug,
      name: schema.collections.name,
      ownerSlug: schema.organization.slug,
      ownerName: schema.organization.name,
    })
    .from(schema.collections)
    .innerJoin(schema.organization, eq(schema.collections.organizationId, schema.organization.id))
    .where(eq(schema.collections.id, keyInfo.collectionId))
    .limit(1)

  if (!coll) {
    return c.html('<h1>Collection not found</h1>', 404)
  }

  const latest = await getLatestReadyVersion(coll.id)
  const versionMeta = (latest?.metadata as Record<string, unknown>) ?? null
  const description = (versionMeta?.description as string) ?? ''

  let schemaEntries: { slug: string; schema: object }[] = []
  if (latest) {
    const entries = await loadVersionSchemas(latest.id)
    schemaEntries = entries.map((e) => ({ slug: e.slug, schema: e.schema }))
  }

  const hasSchemas = schemaEntries.length > 0

  let examples: { id: string; type: string; data: unknown }[] = []
  if (latest) {
    const rows = await db
      .select({
        recordId: schema.recordObjects.recordId,
        type: schema.recordObjects.type,
        data: schema.recordObjects.data,
      })
      .from(schema.versionRecords)
      .innerJoin(
        schema.recordObjects,
        eq(schema.versionRecords.recordHash, schema.recordObjects.hash),
      )
      .where(eq(schema.versionRecords.versionId, latest.id))
      .limit(3)
    examples = rows.map((r) => ({ id: r.recordId, type: r.type, data: r.data }))
  }

  const origin = new URL(c.req.url).origin
  const collPath = `${coll.ownerSlug}/${coll.slug}`
  const negotiateUrl = `${origin}/api/collections/${collPath}/versions/negotiate`
  const llmsTxtUrl = `${origin}/llms.txt`

  const displaySchemas = hasSchemas
    ? schemaEntries
    : [{ slug: DEFAULT_SCHEMA_SLUG, schema: DEFAULT_SCHEMA }]
  const exampleType = displaySchemas[0]!.slug
  const exampleSchemaObj = displaySchemas[0]!.schema as Record<string, any>
  const exampleData: Record<string, unknown> = {}
  if (exampleSchemaObj.properties) {
    for (const [key, prop] of Object.entries(exampleSchemaObj.properties as Record<string, any>)) {
      if (prop.type === 'string') exampleData[key] = `your ${key} here`
      else if (prop.type === 'array') exampleData[key] = ['item 1', 'item 2']
      else exampleData[key] = null
    }
  }

  const negotiateExample = JSON.stringify(
    {
      base_version: latest?.semver ?? null,
      message: 'Added update from conversation',
      schemas: Object.fromEntries(displaySchemas.map((s) => [s.slug, s.schema])),
      manifest: [{ id: 'record-1', type: exampleType, hash: '<sha256-of-canonical-json>' }],
      files: [],
    },
    null,
    2,
  )

  const recordExample = JSON.stringify(
    { id: 'record-1', type: exampleType, data: exampleData },
    null,
    2,
  )

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent: ${escapeHtml(collPath)}</title>
<style>
body { font-family: system-ui, -apple-system, sans-serif; max-width: 760px; margin: 0 auto; padding: 2rem; line-height: 1.6; color: #1a1a1a; }
h1 { font-size: 1.4rem; margin-bottom: 0.25rem; }
h2 { margin-top: 2rem; font-size: 1.1rem; border-bottom: 1px solid #ddd; padding-bottom: 0.3rem; }
h3 { margin-top: 1.5rem; font-size: 0.95rem; }
pre { background: #f5f5f0; padding: 1rem; overflow-x: auto; border: 1px solid #e0e0d8; font-size: 0.8125rem; border-radius: 4px; }
code { background: #f5f5f0; padding: 0.125rem 0.35rem; font-size: 0.8125rem; border-radius: 3px; }
table.kv { border-collapse: collapse; width: 100%; margin: 1rem 0; }
table.kv th { text-align: left; padding: 0.4rem 1rem 0.4rem 0; color: #666; font-weight: 500; font-size: 0.8125rem; white-space: nowrap; vertical-align: top; width: 140px; }
table.kv td { padding: 0.4rem 0; font-size: 0.875rem; }
table.kv tr { border-bottom: 1px solid #eee; }
.subtitle { color: #666; font-size: 0.875rem; margin-top: 0; }
.note { background: #f0f4ff; border: 1px solid #d0d8f0; border-radius: 4px; padding: 0.75rem 1rem; font-size: 0.8125rem; color: #333; margin: 1rem 0; }
.recommend { background: #f0faf0; border: 1px solid #c0e0c0; border-radius: 4px; padding: 0.75rem 1rem; font-size: 0.8125rem; color: #1a3a1a; margin: 1rem 0; }
a { color: #1a6dcc; }
hr { border: none; border-top: 1px solid #ddd; margin: 2rem 0; }
</style>
</head>
<body>

<h1>Agent Write Access</h1>
<p class="subtitle">This page grants temporary write access to an Underlay collection. It is designed to be read by an AI agent. The token embedded in this URL is a valid API key &mdash; use it as a Bearer token to authenticate requests.</p>

<h2>Collection Details</h2>
<table class="kv">
<tr><th>Collection</th><td><strong>${escapeHtml(collPath)}</strong></td></tr>
<tr><th>Name</th><td>${escapeHtml(coll.name)}</td></tr>
${description ? `<tr><th>Description</th><td>${escapeHtml(description)}</td></tr>` : ''}
<tr><th>Current version</th><td>${latest ? escapeHtml(latest.semver) : 'None (empty collection)'}</td></tr>
${latest ? `<tr><th>Records</th><td>${latest.recordCount.toLocaleString()}</td></tr>` : ''}
${latest ? `<tr><th>Files</th><td>${latest.fileCount.toLocaleString()}</td></tr>` : ''}
<tr><th>API key</th><td><code>${escapeHtml(token)}</code></td></tr>
<tr><th>Collection URL</th><td><a href="${escapeHtml(origin)}/${escapeHtml(collPath)}">${escapeHtml(origin)}/${escapeHtml(collPath)}</a></td></tr>
</table>

<h2>Schema</h2>
${
  hasSchemas
    ? schemaEntries
        .map(
          (s) => `
<h3>Type: <code>${escapeHtml(s.slug)}</code></h3>
<pre>${escapeHtml(JSON.stringify(s.schema, null, 2))}</pre>`,
        )
        .join('')
    : `
<p>This collection has <strong>no existing schema</strong>. You must provide a schema when pushing. The following default is recommended:</p>
<div class="recommend">
<strong>Recommended default schema</strong> &mdash; type: <code>${escapeHtml(DEFAULT_SCHEMA_SLUG)}</code>
<pre style="margin:0.5rem 0 0;background:transparent;border:none;padding:0;">${escapeHtml(JSON.stringify(DEFAULT_SCHEMA, null, 2))}</pre>
<p style="margin:0.5rem 0 0;">Fields <code>title</code> and <code>summary</code> are required. The rest are optional.</p>
</div>`
}

${
  examples.length > 0
    ? `
<h3>Example records from the current version</h3>
<pre>${escapeHtml(JSON.stringify(examples, null, 2))}</pre>`
    : `<p>This collection has no entries yet. Your update will be the first.</p>`
}

<h2>How to Write Data</h2>
<p>All writes use the <strong>negotiate protocol</strong> &mdash; a three-step flow (similar to git&rsquo;s pack negotiation) that handles deduplication, schema validation, and version creation. Authenticate every request with the API key above.</p>

<div class="note">
<strong>Full protocol details</strong> including record hashing, canonicalization, file uploads, and privacy controls are documented in <a href="${escapeHtml(llmsTxtUrl)}">${escapeHtml(llmsTxtUrl)}</a>. Read that file for the complete reference. The summary below covers the essential steps.
</div>

<h3>Step 1: Negotiate</h3>
<p>POST a manifest of what the new version should contain. The server responds with which records it still needs.</p>
<pre>POST ${escapeHtml(negotiateUrl)}
Authorization: Bearer ${escapeHtml(token)}
Content-Type: application/json</pre>

<h3>Request body</h3>
<pre>${escapeHtml(negotiateExample)}</pre>

<table class="kv">
<tr><th>base_version</th><td>The semver of the version you&rsquo;re building on (e.g. <code>${latest ? escapeHtml(latest.semver) : 'null'}</code>). Use <code>null</code> for the first push.</td></tr>
<tr><th>schemas</th><td><strong>Required.</strong> A map of type name &rarr; JSON Schema for every type in this version.</td></tr>
<tr><th>manifest</th><td><strong>Required</strong> (unless uploading it in chunks, see below). Array of <code>{id, type, hash}</code> for every record in the new version. The hash is SHA-256 of the canonical JSON (see llms.txt for the exact algorithm). Capped at 500,000 entries.</td></tr>
<tr><th>files</th><td>Array of file hashes referenced by records. Empty array if none.</td></tr>
<tr><th>message</th><td>Optional commit message describing this update.</td></tr>
</table>

<h3>Response</h3>
<pre>${escapeHtml(JSON.stringify({ session_id: '<uuid>', needed_records: ['<hash>'], needed_files: [], total_records: 1, already_have_records: 0 }, null, 2))}</pre>

<h3>Step 2: Send needed records</h3>
<p>POST only the records the server asked for as NDJSON (one JSON object per line). Skip this step if <code>needed_records</code> was empty.</p>
<pre>POST ${escapeHtml(origin)}/api/collections/${escapeHtml(collPath)}/versions/negotiate/&lt;session_id&gt;/records
Authorization: Bearer ${escapeHtml(token)}
Content-Type: application/x-ndjson</pre>

<h3>Record format</h3>
<pre>${escapeHtml(recordExample)}</pre>

<h3>Step 3: Commit</h3>
<p>Finalize the version. The server validates all records against schemas, computes the version hash, and creates the new immutable version.</p>
<pre>POST ${escapeHtml(origin)}/api/collections/${escapeHtml(collPath)}/versions/negotiate/&lt;session_id&gt;/commit
Authorization: Bearer ${escapeHtml(token)}</pre>

<h3>Response (201)</h3>
<pre>${escapeHtml(JSON.stringify({ semver: 'v1.1.0', hash: '<sha256>', recordCount: 1, fileCount: 0 }, null, 2))}</pre>

<h3>Pushing more than ~500,000 records</h3>
<p>Two of the steps above assume the collection fits in one request. At a few million records the manifest would be hundreds of megabytes and the commit would run for minutes, so both have a chunked form. The push is otherwise identical and produces the same version hash.</p>
<ul>
<li><strong>Chunked manifest.</strong> Omit <code>manifest</code> and send <code>manifest_expected: &lt;count&gt;</code> instead. Then POST the manifest as NDJSON to <code>&hellip;/negotiate/&lt;session_id&gt;/manifest</code>, up to 50,000 entries per request. Each response reports which records from that chunk are needed, so you can start sending record bodies before the manifest finishes. Commit refuses to build a version until the declared count has arrived.</li>
<li><strong>Async commit.</strong> Add <code>?async=true</code> to the commit. The server returns <code>202</code> and finalizes in the background; poll <code>GET &hellip;/negotiate/&lt;session_id&gt;</code> until <code>status</code> is <code>committed</code> (with <code>result</code>) or <code>failed</code> (with <code>error</code>). The finalize does not depend on your connection staying open.</li>
</ul>

<hr>

<h2>References</h2>
<table class="kv">
<tr><th>AI integration guide</th><td><a href="${escapeHtml(llmsTxtUrl)}">${escapeHtml(llmsTxtUrl)}</a> &mdash; complete API reference including record hashing algorithm, canonicalization, file uploads, privacy, and error handling</td></tr>
<tr><th>Documentation</th><td><a href="${escapeHtml(origin)}/docs">${escapeHtml(origin)}/docs</a></td></tr>
<tr><th>Platform</th><td><a href="https://www.knowledgefutures.org">Knowledge Futures</a> (501c3)</td></tr>
</table>

</body>
</html>`

  return c.html(html)
}
