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
  "changes": {
    "added": [
      {"id": "author-1", "type": "Author", "data": {"name": "Jane Doe", "email": "jane@example.com"}},
      {"id": "article-1", "type": "Article", "data": {"title": "Hello World", "body": "...", "authorId": "author-1", "publishedAt": "2026-04-01T00:00:00Z"}}
    ]
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

const diffPush = `# 1. Get current state (returns the latest version's semver, e.g. "v1.2.0")
curl https://underlay.org/api/collections/:owner/:slug/versions/latest

# 2. Upload any new files
HASH=$(shasum -a 256 paper.pdf | cut -d' ' -f1)
curl -X PUT "https://underlay.org/api/collections/:owner/:slug/files/sha256:$HASH" \\
  -H "Authorization: Bearer $KEY" \\
  -H "Content-Type: application/pdf" \\
  --data-binary @paper.pdf

# 3. Push changes (only what changed since base_version semver)
curl -X POST https://underlay.org/api/collections/:owner/:slug/versions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $KEY" \\
  -d '{
    "base_version": "v1.2.0",
    "message": "Daily sync",
    "app_id": "my-app",
    "changes": {
      "added": [...],
      "updated": [...],
      "removed": ["old-record-id"]
    }
  }'`

export default function DocsIntegration() {
  return (
    <DocsLayout title="Integration Guide">
      <p>
        Everything a developer or LLM needs to push data to the registry. No SDK required. HTTPS and
        JSON. For a machine-readable version, see <Link to="/.well-known/ai.txt">ai.txt</Link>.
      </p>

      <h2>What is Underlay?</h2>
      <p>
        Underlay is a versioned registry for structured knowledge. Apps push snapshots of their
        data; Underlay preserves them, deduplicates files, and serves them via a stable API. Think
        npm for data, or Docker Hub for structured content.
      </p>

      <h2>Core Concepts</h2>
      <ul>
        <li>
          <strong>Collection</strong> — A named, versioned body of structured data. Identified by{' '}
          <code>:owner/:slug</code>.
        </li>
        <li>
          <strong>Version</strong> — An immutable snapshot: JSON Schema + records + file references
          + metadata. Identified by semver (e.g. <code>v1.0.0</code>).
        </li>
        <li>
          <strong>Record</strong> — A flat JSON object with an <code>id</code>, a <code>type</code>,
          and a <code>data</code> payload conforming to the schema.
        </li>
        <li>
          <strong>File</strong> — A binary blob (PDF, image, etc.) stored by SHA-256 hash.
          Referenced in records via <code>{fileRef}</code>.
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
      <ol>
        <li>Get the current latest version (its semver string)</li>
        <li>Upload any new binary files by hash</li>
        <li>
          Push a version with <code>base_version</code>, schema (if changed), and record changes
        </li>
        <li>
          On <code>409 Conflict</code>, re-fetch latest and retry
        </li>
      </ol>
      <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
        <code>{diffPush}</code>
      </pre>

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
        <li>No joins, no nesting — keep records flat</li>
      </ul>

      <h2>Metadata</h2>
      <p>
        Each version carries a <code>metadata</code> object that can include{' '}
        <code>description</code>, <code>readme</code>, <code>license</code>, and any other key-value
        pairs. Metadata lives on the version, not the collection — it's versioned alongside your
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
        To push the first version of a collection. Include <code>schemas</code> (a per-type JSON
        Schema map) and <code>metadata</code> (description, readme, etc.):
      </p>
      <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
        <code>{pushExample}</code>
      </pre>

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
        <code>base_version</code> in a push request is a semver string (or <code>null</code> for the
        first push).
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
          when pushing. Those records are hidden from public queries.
        </li>
      </ul>
      <p>
        Private content is stored in the same version — the owner always sees everything. Public
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
              <code>GET .../versions/latest</code>
            </td>
            <td>Get latest version</td>
          </tr>
          <tr>
            <td>
              <code>GET .../versions/:semver/records</code>
            </td>
            <td>Get records</td>
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

      <h2>Push Protocol</h2>
      <p>
        All pushes use the{' '}
        <Link to="/protocol#push" className="text-link underline">
          negotiate protocol
        </Link>
        , a three-step flow similar to git's pack negotiation:
      </p>
      <ol>
        <li>
          <strong>Negotiate:</strong> <code>POST .../versions/negotiate</code> with your schemas and
          a manifest of record hashes. The server responds with which hashes it needs.
        </li>
        <li>
          <strong>Send records:</strong> <code>POST .../negotiate/:id/records</code> with the needed
          records as JSONL. Call this endpoint multiple times for large datasets (up to 10,000
          records per batch). Skip this step if the server already has all records.
        </li>
        <li>
          <strong>Commit:</strong> <code>POST .../negotiate/:id/commit</code> to validate and create
          the version.
        </li>
      </ol>
      <p>
        Record hashes are SHA-256 of the canonical JSON:{' '}
        <code>{'JSON.stringify({id, type, data})'}</code>. Sessions expire after 10 minutes. See the{' '}
        <Link to="/protocol" className="text-link underline">
          Protocol spec
        </Link>{' '}
        for the full hashing specification.
      </p>
      <p>
        This protocol is efficient at every scale: for a small push of 5 new records, only those 5
        are transferred. For a push of 100,000 records where only 5 changed, only 5 are transferred.
        For large initial imports, records are streamed in batches with per-batch progress and retry
        granularity.
      </p>

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
          <code>409 Conflict</code> — Another version was pushed since your{' '}
          <code>base_version</code>. Re-negotiate.
        </li>
        <li>
          <code>422 Unprocessable</code> — Records reference files that haven't been uploaded,
          schema validation failed, or records contain fields not in the schema.
        </li>
        <li>
          <code>400 Bad Request</code> — Malformed JSONL, hash mismatch, or missing records.
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
          <strong>Hash each record:</strong> SHA-256 of{' '}
          <code>{'JSON.stringify({id, type, data})'}</code> with keys sorted recursively.
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
        records, POST to the versions endpoint. No SDK needed. See the{' '}
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
