import { Link } from 'react-router'

import DocsLayout from '~/components/DocsLayout'

const pushExample = `{
  "base_version": null,
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
  },
  "manifest": [
    {"id": "author-1", "type": "Author", "hash": "a1b2c3..."},
    {"id": "article-1", "type": "Article", "hash": "d4e5f6..."}
  ]
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

const diffPush = `# 1. Get current state (returns the latest version's semver, e.g. "v1.2.0")
curl https://underlay.org/api/collections/:owner/:slug/versions/latest

# 2. Upload any new files
HASH=$(shasum -a 256 paper.pdf | cut -d' ' -f1)
curl -X PUT "https://underlay.org/api/collections/:owner/:slug/files/sha256:$HASH" \\
  -H "Authorization: Bearer $KEY" \\
  -H "Content-Type: application/pdf" \\
  --data-binary @paper.pdf

# 3. Hash your records and negotiate
curl -X POST https://underlay.org/api/collections/:owner/:slug/versions/negotiate \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $KEY" \\
  -d '{
    "base_version": "v1.2.0",
    "message": "Daily sync",
    "schemas": { ... },
    "manifest": [
      {"id": "record-1", "type": "Article", "hash": "abc123..."},
      {"id": "record-2", "type": "Article", "hash": "def456..."}
    ]
  }'
# → {"session_id":"...","needed_records":["def456..."],...}

# 4. Send only the records the server needs (as JSONL)
curl -X POST .../negotiate/SESSION_ID/records \\
  -H "Content-Type: application/x-ndjson" \\
  -H "Authorization: Bearer $KEY" \\
  --data-binary '{"id":"record-2","type":"Article","data":{...}}'

# 5. Commit
curl -X POST .../negotiate/SESSION_ID/commit \\
  -H "Authorization: Bearer $KEY"`

const hashExample = `import { createHash } from 'node:crypto'

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(canonicalize)
  const sorted = {}
  for (const key of Object.keys(value).sort()) {
    sorted[key] = canonicalize(value[key])
  }
  return sorted
}

function hashRecord(record) {
  const obj = { id: record.id, type: record.type, data: canonicalize(record.data) }
  return createHash('sha256').update(JSON.stringify(obj)).digest('hex')
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
        Underlay is a versioned registry for structured knowledge. Apps push snapshots of their
        data; Underlay preserves them, deduplicates records and files, and serves them via a stable
        API. Think npm for data, or Docker Hub for structured content.
      </p>

      <h2>Core Concepts</h2>
      <ul>
        <li>
          <strong>Collection</strong>: A named, versioned body of structured data. Identified by{' '}
          <code>:owner/:slug</code>.
        </li>
        <li>
          <strong>Version</strong>: An immutable snapshot: JSON Schema + records + file references +
          metadata. Identified by semver (e.g. <code>v1.0.0</code>).
        </li>
        <li>
          <strong>Record</strong>: A flat JSON object with an <code>id</code>, a <code>type</code>,
          and a <code>data</code> payload conforming to the schema. Content-addressed by SHA-256
          hash.
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
      <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
        <code>{'Authorization: Bearer ul_your_key_here'}</code>
      </pre>
      <p>
        Keys are scoped: <code>read</code>, <code>write</code>, or <code>admin</code>. Use{' '}
        <code>write</code> for pushing data.
      </p>

      <h2>The Push Flow</h2>
      <p>
        All pushes use the{' '}
        <Link to="/protocol" className="text-link underline">
          negotiate protocol
        </Link>
        , a three-step flow similar to git's pack negotiation:
      </p>
      <ol>
        <li>Get the current latest version (its semver string)</li>
        <li>Upload any new binary files by hash</li>
        <li>
          Hash your records and <strong>negotiate</strong>: send a manifest of record hashes. The
          server responds with which records it needs.
        </li>
        <li>
          <strong>Send records</strong>: upload only the needed records as JSONL (up to 10,000 per
          batch). Skip if the server already has everything.
        </li>
        <li>
          <strong>Commit</strong>: finalize and create the version.
        </li>
        <li>
          On <code>409 Conflict</code>, re-fetch latest and retry from step 3
        </li>
      </ol>
      <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
        <code>{diffPush}</code>
      </pre>

      <h2>Record Hashing</h2>
      <p>
        Before negotiating, you must hash each record client-side. The hash is the SHA-256 of the
        canonical JSON representation of <code>{'{ id, type, data }'}</code> with all object keys
        sorted recursively. This ensures any implementation produces the same hash for the same
        content.
      </p>
      <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
        <code>{hashExample}</code>
      </pre>
      <p>
        See the{' '}
        <Link to="/protocol" className="text-link underline">
          Protocol spec
        </Link>{' '}
        for the full hashing specification with worked examples.
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
        <li>No joins, no nesting. Keep records flat</li>
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
        <code>PATCH /api/collections/:owner/:slug/metadata</code> with the fields to change. This
        creates a patch version automatically.
      </p>

      <h2>First Push Example</h2>
      <p>
        The negotiate request for a first push. Include <code>schemas</code> (a per-type JSON Schema
        map), <code>metadata</code>, and a <code>manifest</code> of record hashes:
      </p>
      <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
        <code>{pushExample}</code>
      </pre>
      <p>
        After negotiating, send the needed records as JSONL, then commit. See the{' '}
        <Link to="/docs/quickstart" className="text-link underline">
          Quickstart
        </Link>{' '}
        for the complete curl walkthrough.
      </p>

      <h2>Mapping a SQL Database</h2>
      <p>Most apps store data in SQL. Here's how to map it to Underlay records:</p>
      <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
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
          Schema changes → <strong>major</strong> bump
        </li>
        <li>
          Record or file changes → <strong>minor</strong> bump
        </li>
        <li>
          Metadata-only changes (readme, license, etc.) → <strong>patch</strong> bump
        </li>
      </ul>
      <p>
        The first version of a collection is always <code>v1.0.0</code>. The{' '}
        <code>base_version</code> in a negotiate request is a semver string (or <code>null</code>{' '}
        for the first push).
      </p>

      <h2>Privacy</h2>
      <p>You can control what's publicly visible at three levels:</p>
      <ul>
        <li>
          <strong>Private types:</strong> Add <code>"private": true</code> to a type in the schema.
          All records of that type are hidden from public readers.
        </li>
        <li>
          <strong>Private fields:</strong> Add <code>"private": true</code> to a field in the
          schema. That field is stripped from public responses.
        </li>
        <li>
          <strong>Private records:</strong> Add <code>"private": true</code> to individual records
          in the manifest when negotiating. Those records are hidden from public queries.
        </li>
      </ul>
      <p>
        Private content is stored in the same version; the owner always sees everything. Public
        readers see only the filtered view. The public content hash excludes private data, so
        verifiers can confirm integrity of the public subset.
      </p>

      <h2>API Reference</h2>
      <p>
        Full API docs are at <Link to="/docs">/docs</Link>. The key endpoints:
      </p>
      <table>
        <tbody>
          <tr>
            <td>
              <code>POST .../versions/negotiate</code>
            </td>
            <td>Start a push (hash negotiation)</td>
          </tr>
          <tr>
            <td>
              <code>POST .../negotiate/:id/records</code>
            </td>
            <td>Send needed records (JSONL, repeatable)</td>
          </tr>
          <tr>
            <td>
              <code>POST .../negotiate/:id/commit</code>
            </td>
            <td>Finalize and create the version</td>
          </tr>
          <tr>
            <td>
              <code>DELETE .../negotiate/:id</code>
            </td>
            <td>Cancel a negotiate session</td>
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
              <code>GET .../versions/:semver/manifest</code>
            </td>
            <td>Get record hash manifest (supports delta via ?since=)</td>
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
              <code>POST /api/records/batch</code>
            </td>
            <td>Fetch records by hash (NDJSON response)</td>
          </tr>
          <tr>
            <td>
              <code>GET /api/records/:hash/provenance</code>
            </td>
            <td>Find which collections contain a record</td>
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
        If records contain fields not defined in the schema, the commit returns <code>422</code>{' '}
        with a list of extra fields per record. To accept stripping those fields before storage, set{' '}
        <code>"strip_unknown_fields": true</code> in the negotiate request.
      </p>
      <p>
        When stripping is enabled, the server removes extra fields, recomputes record hashes, and
        stores only the schema-conformant data.
      </p>

      <h2>Error Handling</h2>
      <ul>
        <li>
          <code>409 Conflict</code>: Another version was pushed since your <code>base_version</code>
          . Re-negotiate.
        </li>
        <li>
          <code>422 Unprocessable</code>: Records reference files that haven't been uploaded, schema
          validation failed, or records contain fields not in the schema.
        </li>
        <li>
          <code>400 Bad Request</code>: Malformed JSONL, hash mismatch, or missing records.
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
          <strong>Hash each record:</strong> SHA-256 of the canonical JSON with keys sorted
          recursively. See the hashing section above or the{' '}
          <Link to="/protocol" className="text-link underline">
            Protocol spec
          </Link>
          .
        </li>
        <li>
          <strong>Negotiate:</strong> send the manifest of <code>{'{ id, type, hash }'}</code>{' '}
          entries. The server tells you which records it already has.
        </li>
        <li>
          <strong>Send missing records</strong> as JSONL. For large datasets, batch into groups of
          5,000–10,000 records per request.
        </li>
        <li>
          <strong>Commit</strong> to create the version.
        </li>
      </ol>
      <p>
        A minimal Node.js/Python script typically takes 30-50 lines: query your data, map rows to
        records, hash them, POST to negotiate. No SDK needed. See the{' '}
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
        public charity. Contact:{' '}
        <a href="mailto:team@knowledgefutures.org">team@knowledgefutures.org</a>
      </p>
    </DocsLayout>
  )
}
