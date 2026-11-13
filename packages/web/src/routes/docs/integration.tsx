import { Link } from 'react-router'

import DocsLayout from '~/components/DocsLayout'
import { HELP_EMAIL } from '~/lib/contact'

const pushExample = `{
  "base": null,
  "message": "Initial import",
  "app_id": "my-app",
  "metadata": {
    "description": "Articles and authors from my app",
    "readme": "# My App Data\\nExported from the app database."
  },
  "schemas": {
    "Article": {
      "type": "object",
      "properties": {
        "title": {"type": "string"},
        "body": {"type": "string"},
        "authorId": {"type": "string"},
        "publishedAt": {"type": "string", "format": "date-time"}
      }
    },
    "Author": {
      "type": "object",
      "properties": {
        "name": {"type": "string"},
        "email": {"type": "string"}
      }
    }
  }
}`

const fileRef = '{"$file": "sha256:<hex>"}'

const sqlIntrospect = `-- For each table, generate a JSON Schema type:
-- table name → type name
-- column name → property name
-- column type → JSON Schema type (text→string, integer→integer, etc.)
-- foreign keys → note as ID references in the schema description

-- Example: a "publications" table with columns (id, title, doi, author_id)
-- becomes a "Publication" type with properties {title: string, doi: string, authorId: string}
-- The record id is the primary key value.`

const diffPush = `# 1. Open a session against the current version (its semver, e.g. "v1.2.0")
curl -X POST https://www.underlay.org/api/collections/:owner/:slug/push \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $KEY" \\
  -d '{
    "base": "v1.2.0",
    "message": "Daily sync",
    "files": {"add": ["9f86d0..."]}
  }'
# → {"session_id":"...","base":"v1.2.0","needed_files":["9f86d0..."],"limits":{...},...}

# 2. Upload the files the server doesn't have yet
curl -X PUT "https://www.underlay.org/api/collections/:owner/:slug/files/sha256:9f86d0..." \\
  -H "Authorization: Bearer $KEY" \\
  -H "Content-Type: application/pdf" \\
  --data-binary @paper.pdf

# 3. Upload new and changed records (NDJSON, repeatable)
curl -X POST .../push/SESSION_ID/records \\
  -H "Content-Type: application/x-ndjson" \\
  -H "Authorization: Bearer $KEY" \\
  --data-binary '{"id":"record-2","type":"Article","data":{...}}'

# 4. Delete records that are gone (NDJSON, repeatable)
curl -X POST .../push/SESSION_ID/deletes \\
  -H "Content-Type: application/x-ndjson" \\
  -H "Authorization: Bearer $KEY" \\
  --data-binary '{"type":"Article","id":"record-9"}'

# 5. Commit
curl -X POST .../push/SESSION_ID/commit \\
  -H "Authorization: Bearer $KEY"
# → 201 {"semver":"v1.3.0","hash":"ulv3:...","recordCount":...,"fileCount":...,"changes":{...}}`

const snapshotDiff = `// hashRecord(record) → hex, as defined under "Record Hashing" below.
const key = (r) => JSON.stringify([r.type, r.id])

// 1. Read the current version's manifest, every page.
// The first page names the version (base); later pages read that same version.
const have = new Map() // key → { id, type, hash }
let base = null
let cursor = null
do {
  const query = cursor ? \`?cursor=\${encodeURIComponent(cursor)}\` : ''
  const res = await fetch(\`\${api}/versions/\${base ?? 'latest'}/manifest\${query}\`, { headers: auth })
  if (res.status === 404) break // no versions yet
  const page = await res.json()
  base = page.semver
  for (const m of page.records) have.set(key(m), m)
  cursor = page.pagination.hasMore ? page.pagination.nextCursor : null
} while (cursor)

// 2. Diff your full export against it.
const upserts = records.filter((r) => {
  const m = have.get(key(r))
  return !m || m.hash !== hashRecord(r)
})
const keep = new Set(records.map(key))
const deletes = [...have.values()]
  .filter((m) => !keep.has(key(m)))
  .map((m) => ({ type: m.type, id: m.id }))

// 3. Open a session with "base": base, upload upserts and deletes in batches, commit.`

const hashExample = `import { createHash } from 'node:crypto'

// RFC 8785 (JCS), written out as a string: a sorted object passed to
// JSON.stringify would put integer-like keys ("9", "10") first.
function jcs(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(jcs).join(',') + ']'
  const keys = Object.keys(value).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + jcs(value[k])).join(',') + '}'
}

function hashRecord(record) {
  const canonical =
    '{"id":' + JSON.stringify(record.id) + ',"type":' + JSON.stringify(record.type) +
    ',"data":' + jcs(record.data) + '}'
  return createHash('sha256').update(canonical).digest('hex')
}`

export default function DocsIntegration() {
  return (
    <DocsLayout title="Integration Guide">
      <p>
        Everything a developer or LLM needs to push data to the registry. No SDK required. HTTPS and
        JSON. For a machine-readable version, see <a href="/llms.txt">llms.txt</a>.
      </p>

      <h2>What is Underlay?</h2>
      <p>
        Underlay is a versioned registry for structured knowledge. Apps publish versions of their
        data; Underlay keeps each collection as a log of commits, each holding only what changed,
        and serves every version via a stable API. Think npm for data, or Docker Hub for structured
        content.
      </p>

      <h2>Core Concepts</h2>
      <ul>
        <li>
          <strong>Collection</strong>: A named, versioned body of structured data. Identified by{' '}
          <code>:owner/:slug</code>.
        </li>
        <li>
          <strong>Version</strong>: The collection as of one commit in its log, and immutable: a
          JSON Schema per type, records, file references and metadata. Identified by semver (e.g.{' '}
          <code>v1.0.0</code>) or by its <code>ulv3:</code> id. Versions converted from the earlier
          format also answer to their old <code>ulv2:</code> ids.
        </li>
        <li>
          <strong>Record</strong>: An <code>id</code>, a <code>type</code> and a <code>data</code>{' '}
          payload conforming to the type&rsquo;s schema. Content-addressed by SHA-256 hash.
        </li>
        <li>
          <strong>File</strong>: A binary blob (PDF, image, etc.) stored by SHA-256 hash. Referenced
          in records via <code>{fileRef}</code>.
        </li>
      </ul>

      <h2>Authentication</h2>
      <p>
        Create an API key at <Link to="/settings/keys">/settings/keys</Link> or via the API. Pass it
        as:
      </p>
      <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
        <code>{'Authorization: Bearer ul_your_key_here'}</code>
      </pre>
      <p>
        Keys are scoped <code>read</code>, <code>write</code> or <code>admin</code>; use{' '}
        <code>write</code> for pushing data. A key never exceeds its holder&rsquo;s role: a{' '}
        <code>write</code> key acts as a member, and only an owner&rsquo;s or admin&rsquo;s{' '}
        <code>admin</code> key can change visibility, delete or manage webhooks. A key confined to
        specific collections acts as a member whatever its scope. To let an AI agent push to one
        collection, create an <strong>agent link</strong> from the collection&rsquo;s Share panel:
        an instructions page at <code>https://www.underlay.org/agent/&lt;key&gt;</code> carrying a
        write key for that collection only, which expires after an hour.
      </p>

      <h2>The Push Flow</h2>
      <p>
        Every push is a{' '}
        <Link to="/docs/protocol/push-and-pull#delta-push" className="text-link underline">
          delta push
        </Link>
        : you send what changed since a base version, and the server builds the new version.
      </p>
      <ol>
        <li>
          <strong>Open a session</strong> with <code>base</code> set to the semver you diffed
          against (<code>null</code> for the first push; <code>null</code> means no conflict check),
          plus any schemas, metadata and files to declare. <code>schemas</code>, when sent, is the
          full type set: a type left out is removed, with its records. <code>metadata</code>{' '}
          replaces the metadata, <code>metadata_patch</code> merges into it. The response lists{' '}
          <code>needed_files</code> and the server&rsquo;s <code>limits</code>. Files go in{' '}
          <code>files.add</code> (or <code>files.remove</code>) as bare hex hashes, without{' '}
          <code>sha256:</code>.
        </li>
        <li>
          <strong>Upload files</strong> listed in <code>needed_files</code>, by hash. Files your
          records reference are added to the version whether or not you declared them; declaring
          them tells you up front which ones to upload.
        </li>
        <li>
          <strong>Upload records</strong> that are new or changed, as NDJSON, in batches within{' '}
          <code>limits.batch_lines</code> and <code>limits.batch_bytes</code>.
        </li>
        <li>
          <strong>Upload deletes</strong>, <code>{'{"type", "id"}'}</code> per line, for records
          that are gone.
        </li>
        <li>
          <strong>Commit</strong>. On <code>409 Conflict</code>, someone else published first: diff
          against the new head and push again. If your changes don&rsquo;t depend on the base (a
          load of upserts), commit with the body <code>{'{"rebase": true}'}</code> instead: the
          session&rsquo;s records and deletes apply on top of the current head, and its schemas and
          metadata replace the head&rsquo;s. On <code>422</code> with <code>filesNeeded</code>,
          upload those files and commit the same session again.
        </li>
      </ol>
      <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
        <code>{diffPush}</code>
      </pre>
      <p>
        Within a session, the later upload of a <code>(type, id)</code> wins, whether a record or a
        delete. Above 100,000 uploaded records (or when a schema change revalidates more than
        100,000 existing records) the commit runs in the background: it answers <code>202</code>,
        and you poll <code>GET .../push/SESSION_ID</code> until its <code>status</code> is{' '}
        <code>committed</code> or <code>failed</code>. Add <code>?async=true</code> to ask for that
        at any size. A background commit refused for missing files goes back to <code>open</code>,
        with <code>filesNeeded</code> in its <code>error</code>.
      </p>

      <h2>Pushing a Full Export</h2>
      <p>
        If your app exports its whole dataset each time rather than tracking changes, diff the
        export against the current version&rsquo;s manifest, then push the differences. The upload
        is the size of the changes, whatever the size of the collection. See{' '}
        <Link
          to="/docs/protocol/push-and-pull#clients-without-a-copy"
          className="text-link underline"
        >
          clients without a copy
        </Link>
        .
      </p>
      <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
        <code>{snapshotDiff}</code>
      </pre>
      <p>
        Uploading a record that matches the base changes nothing: the commit leaves it out. Deleting
        a record the base doesn&rsquo;t have is ignored too.
      </p>

      <h2>Record Hashing</h2>
      <p>
        The server hashes the records you upload, so a push needs no hashing. You need the hash to
        diff against a manifest. It is the SHA-256 of a fixed <code>{'{ id, type, data }'}</code>{' '}
        envelope with <code>data</code> in canonical JSON (RFC 8785), so any implementation produces
        the same hash for the same content. In JavaScript:
      </p>
      <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
        <code>{hashExample}</code>
      </pre>
      <p>
        See{' '}
        <Link to="/docs/protocol/records" className="text-link underline">
          Records and schemas
        </Link>{' '}
        for the full rules, including the input rules every record line must pass.
      </p>

      <h2>Record Format</h2>
      <p>
        Every record has three fields: <code>id</code> (stable string), <code>type</code> (matches
        schema), and <code>data</code> (the payload).
      </p>
      <ul>
        <li>
          Relationships are plain ID strings (e.g. <code>"authorId": "author-1"</code>)
        </li>
        <li>
          Files are referenced as <code>{fileRef}</code>
        </li>
        <li>No joins. Prefer flat records; nesting is allowed up to 64 levels</li>
      </ul>

      <h2>Metadata</h2>
      <p>
        Each version carries a <code>metadata</code> object that can include{' '}
        <code>description</code>, <code>readme</code>, <code>license</code>, and any other key-value
        pairs. Metadata lives on the version, not the collection; it's versioned alongside your
        data. Set it on your first push and update it via subsequent pushes or the metadata
        endpoint.
      </p>
      <p>
        To update metadata without changing records or schemas (e.g. editing the readme),{' '}
        <code>POST /api/collections/:owner/:slug/metadata</code> with the fields to change (
        <code>null</code> clears one). This adds a commit holding only the new metadata, a patch
        version, so it is quick at any collection size. It answers <code>201</code> with the new{' '}
        <code>semver</code> and <code>hash</code>, or <code>200</code> with{' '}
        <code>"unchanged": true</code>. On a push, <code>metadata</code> replaces the metadata and{' '}
        <code>metadata_patch</code> merges into it.
      </p>

      <h2>First Push Example</h2>
      <p>
        The body that opens the first push. Include <code>schemas</code> (a per-type JSON Schema
        map) and <code>metadata</code>:
      </p>
      <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
        <code>{pushExample}</code>
      </pre>
      <p>
        Then upload the records as NDJSON and commit. See the{' '}
        <Link to="/docs/quickstart" className="text-link underline">
          Quickstart
        </Link>{' '}
        for the complete curl walkthrough.
      </p>

      <h2>Mapping a SQL Database</h2>
      <p>Most apps store data in SQL. Here's how to map it to Underlay records:</p>
      <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
        <code>{sqlIntrospect}</code>
      </pre>
      <p>General rules:</p>
      <ul>
        <li>Each table becomes a record type</li>
        <li>
          Each row becomes a record (primary key → record <code>id</code>)
        </li>
        <li>Foreign keys become string ID references</li>
        <li>
          Binary columns (BLOBs) → upload as files, replace with <code>$file</code> references
        </li>
        <li>Generate a JSON Schema from your column types</li>
      </ul>

      <h2>Versioning</h2>
      <p>
        Versions are identified by <strong>semver</strong> (e.g. <code>v1.0.0</code>). The semver is
        derived automatically from what changed:
      </p>
      <ul>
        <li>
          Schema changes, including a type added or removed → <strong>major</strong> bump
        </li>
        <li>
          Record changes (added, changed or removed) → <strong>minor</strong> bump
        </li>
        <li>
          Metadata or file changes only → <strong>patch</strong> bump
        </li>
      </ul>
      <p>
        The first version of a new collection is always <code>v1.0.0</code>. A push that changes
        nothing makes no version (<code>409</code>, <code>No changes detected</code>). The{' '}
        <code>base</code> when opening a push is a semver string (or <code>null</code> for the first
        push).
      </p>

      <h2>Privacy</h2>
      <p>
        Privacy is set per collection: a collection is public (readable by anyone) or private
        (readable only by members of the owning organization) as a whole, every version included.
        There are no private records or private types. Create a collection with{' '}
        <code>"public": true</code> to make it public; without it, it is private. Only the
        organization&rsquo;s owners and admins can change visibility later.
      </p>
      <p>
        If some of your data is public and some is not, push them to two collections: a public one
        and a separate private one. A push to a public collection that marks anything private is
        refused with <code>422</code>:
      </p>
      <ul>
        <li>
          A record line with <code>"private": true</code>: the records upload answers{' '}
          <code>
            This collection is public, and keeps no private records. Make the collection private, or
            push them to a private collection.
          </code>
        </li>
        <li>
          A schema with <code>"private": true</code> at its root: opening the session answers{' '}
          <code>422</code> naming the types.
        </li>
      </ul>
      <p>
        In a private collection the mark is accepted and changes nothing.{' '}
        <code>"private": true</code> on a field inside a schema is refused in any collection.
      </p>

      <h2>API Reference</h2>
      <p>
        Full API docs are at <Link to="/docs/api">/docs/api</Link>. The key endpoints:
      </p>
      <table>
        <tbody>
          <tr>
            <td>
              <code>POST .../push</code>
            </td>
            <td>Open a push session against a base version</td>
          </tr>
          <tr>
            <td>
              <code>POST .../push/:id/records</code>
            </td>
            <td>Upload new or changed records (NDJSON, repeatable)</td>
          </tr>
          <tr>
            <td>
              <code>POST .../push/:id/deletes</code>
            </td>
            <td>Delete records by type and id (NDJSON, repeatable)</td>
          </tr>
          <tr>
            <td>
              <code>POST .../push/:id/commit</code>
            </td>
            <td>
              Build the version. Add <code>?async=true</code> to get a <code>202</code> and poll
              instead of holding the request open
            </td>
          </tr>
          <tr>
            <td>
              <code>GET .../push/:id</code>
            </td>
            <td>Session status, and the result or error of an async commit</td>
          </tr>
          <tr>
            <td>
              <code>DELETE .../push/:id</code>
            </td>
            <td>Abandon a push session</td>
          </tr>
          <tr>
            <td>
              <code>GET .../versions/latest</code>
            </td>
            <td>Get latest version</td>
          </tr>
          <tr>
            <td>
              <code>GET .../versions/:semver/records</code>
            </td>
            <td>Get records (paginated)</td>
          </tr>
          <tr>
            <td>
              <code>GET .../versions/:semver/records.ndjson</code>
            </td>
            <td>
              Stream every record in one request (NDJSON). The bulk read path: use it instead of
              paging when you want the whole collection
            </td>
          </tr>
          <tr>
            <td>
              <code>GET .../versions/:semver/manifest</code>
            </td>
            <td>Record ids, types and hashes, paged (supports delta via ?since=)</td>
          </tr>
          <tr>
            <td>
              <code>GET .../versions/:semver/diff?from=</code>
            </td>
            <td>Diff two versions</td>
          </tr>
          <tr>
            <td>
              <code>PUT .../files/:hash</code>
            </td>
            <td>Upload a file</td>
          </tr>
          <tr>
            <td>
              <code>GET /api/collections</code>
            </td>
            <td>Browse public collections</td>
          </tr>
        </tbody>
      </table>

      <h2>Unknown Fields</h2>
      <p>
        If a record has top-level fields its schema&rsquo;s <code>properties</code> doesn&rsquo;t
        list, the records upload answers <code>422</code> with the extra fields per line. To strip
        those fields instead, set <code>"strip_unknown_fields": true</code> when opening the push.
      </p>
      <p>
        When stripping is enabled, the server removes the extra fields before hashing, and stores
        only the schema-conformant data.
      </p>

      <h2>Error Handling</h2>
      <ul>
        <li>
          <code>409 Conflict</code>: Another version was published since your <code>base</code> (the
          answer names <code>currentVersion</code>, at open or at commit), or the push changes
          nothing. Diff against the new head and push again.
        </li>
        <li>
          <code>413 Payload Too Large</code>: A batch or file is over the session&rsquo;s{' '}
          <code>limits</code>. Split it.
        </li>
        <li>
          <code>422 Unprocessable</code>: Records or deletes fail the input rules or their schema (
          <code>validationErrors</code>, by line), a schema is refused when the session opens, a
          record or type is marked private in a public collection, or the commit references files
          that haven&rsquo;t been uploaded (<code>filesNeeded</code>; upload them and commit the
          same session again).
        </li>
        <li>
          <code>429 Too Many Requests</code>: Too many push sessions open at once (
          <code>limits.open_sessions</code>), or a rate limit. Wait and retry.
        </li>
        <li>
          <code>500</code> on a commit: poll <code>GET .../push/SESSION_ID</code>. The server
          retries a stalled commit, so the session may still end <code>committed</code>. If it ends{' '}
          <code>failed</code> with a <code>500</code> or <code>503</code> in <code>error</code>,
          commit the same session again: its uploads are kept.
        </li>
      </ul>

      <h2>Pushing from Scripts</h2>
      <p>The most common pattern for pushing data from a script, cron job, or CI pipeline:</p>
      <ol>
        <li>
          <strong>Query your source</strong> (database, API, filesystem) and build an array of
          records in <code>{'{id, type, data}'}</code> format.
        </li>
        <li>
          <strong>Diff</strong> against the current version&rsquo;s manifest, unless your app
          already knows what changed. See <em>Pushing a Full Export</em> above.
        </li>
        <li>
          <strong>Open a push</strong> with <code>base</code> set to that version.
        </li>
        <li>
          <strong>Upload</strong> the new and changed records and the deletes as NDJSON, in batches
          within the session&rsquo;s <code>limits</code>.
        </li>
        <li>
          <strong>Commit</strong> to create the version.
        </li>
      </ol>
      <p>
        A minimal Node.js or Python script typically takes 30-50 lines: query your data, map rows to
        records, diff, push. No SDK needed. See the{' '}
        <Link to="/docs/quickstart" className="text-link underline">
          Quickstart
        </Link>{' '}
        for a curl-based walkthrough.
      </p>

      <h2>Source Code</h2>
      <p>
        Underlay is open source:{' '}
        <a href="https://github.com/knowledgefutures/underlay">
          github.com/knowledgefutures/underlay
        </a>
      </p>
      <p>
        Built by <a href="https://www.knowledgefutures.org">Knowledge Futures</a>, a 501(c)(3)
        public charity. Contact: <a href={`mailto:${HELP_EMAIL}`}>{HELP_EMAIL}</a>
      </p>
    </DocsLayout>
  )
}
