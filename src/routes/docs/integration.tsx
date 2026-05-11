import { Link, } from 'react-router'
import DocsLayout from '~/components/DocsLayout'

const pushExample = `{
  "base_version": null,
  "message": "Initial import",
  "app_id": "my-app",
  "schema": {
    "type": "object",
    "properties": {
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

const diffPush = `# 1. Get current state
curl https://underlay.org/api/collections/:owner/:slug/versions/latest

# 2. Upload any new files
HASH=$(shasum -a 256 paper.pdf | cut -d' ' -f1)
curl -X PUT "https://underlay.org/api/collections/:owner/:slug/files/sha256:$HASH" \\
  -H "Authorization: Bearer $KEY" \\
  -H "Content-Type: application/pdf" \\
  --data-binary @paper.pdf

# 3. Push changes (only what changed since base_version)
curl -X POST https://underlay.org/api/collections/:owner/:slug/versions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $KEY" \\
  -d '{
    "base_version": 42,
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
    <DocsLayout title='Integration Guide'>
      <p>
        Everything a developer or LLM needs to push data to the registry. No SDK required. HTTPS and JSON. For a
        machine-readable version, see <Link to='/.well-known/ai.txt'>ai.txt</Link>.
      </p>

      <h2>What is Underlay?</h2>
      <p>
        Underlay is a versioned registry for structured knowledge. Apps push snapshots of their data; Underlay preserves
        them, deduplicates files, and serves them via a stable API. Think npm for data, or Docker Hub for structured
        content.
      </p>

      <h2>Core Concepts</h2>
      <ul>
        <li>
          <strong>Collection</strong> — A named, versioned body of structured data. Identified by{' '}
          <code>:owner/:slug</code>.
        </li>
        <li>
          <strong>Version</strong>{' '}
          — An immutable snapshot: JSON Schema + records + file references + metadata. Numbered sequentially.
        </li>
        <li>
          <strong>Record</strong> — A flat JSON object with an <code>id</code>, a <code>type</code>, and a{' '}
          <code>data</code> payload conforming to the schema.
        </li>
        <li>
          <strong>File</strong> — A binary blob (PDF, image, etc.) stored by SHA-256 hash. Referenced in records via
          {' '}
          <code>{fileRef}</code>.
        </li>
      </ul>

      <h2>Authentication</h2>
      <p>
        Create an API key at <Link to='/settings/keys'>/settings/keys</Link> or via the API. Pass it as:
      </p>
      <pre className='bg-ink text-parchment p-3 text-xs overflow-x-auto'><code>{'Authorization: Bearer ul_your_key_here'}</code></pre>
      <p>
        Keys are scoped: <code>read</code>, <code>write</code>, or <code>admin</code>. Use <code>write</code>{' '}
        for pushing data.
      </p>

      <h2>The Push Flow</h2>
      <ol>
        <li>Get the current latest version number</li>
        <li>Upload any new binary files by hash</li>
        <li>
          Push a version with <code>base_version</code>, schema (if changed), and record changes
        </li>
        <li>
          On <code>409 Conflict</code>, re-fetch latest and retry
        </li>
      </ol>
      <pre className='bg-ink text-parchment p-3 text-xs overflow-x-auto'><code>{diffPush}</code></pre>

      <h2>Record Format</h2>
      <p>
        Every record has three fields: <code>id</code> (stable string), <code>type</code> (matches schema), and{' '}
        <code>data</code> (the payload).
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

      <h2>First Push Example</h2>
      <p>To push the first version of a collection (creates the initial snapshot):</p>
      <pre className='bg-ink text-parchment p-3 text-xs overflow-x-auto'><code>{pushExample}</code></pre>

      <h2>Mapping a SQL Database</h2>
      <p>Most apps store data in SQL. Here's how to map it to Underlay records:</p>
      <pre className='bg-ink text-parchment p-3 text-xs overflow-x-auto'><code>{sqlIntrospect}</code></pre>
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
      <p>Versions are numbered sequentially and also carry a semver tag derived automatically:</p>
      <ul>
        <li>
          Schema changes → <strong>major</strong> bump
        </li>
        <li>
          Record changes → <strong>minor</strong> bump
        </li>
        <li>
          Metadata-only changes → <strong>patch</strong> bump
        </li>
      </ul>
      <p>
        Version 1 is always <code>v1.0.0</code>.
      </p>

      <h2>Privacy</h2>
      <p>You can control what's publicly visible at three levels:</p>
      <ul>
        <li>
          <strong>Private types:</strong> Add <code>"private": true</code>{' '}
          to a type in the schema. All records of that type are hidden from public readers.
        </li>
        <li>
          <strong>Private fields:</strong> Add <code>"private": true</code>{' '}
          to a field in the schema. That field is stripped from public responses.
        </li>
        <li>
          <strong>Private records:</strong> Add <code>"private": true</code>{' '}
          to individual records when pushing. Those records are hidden from public queries.
        </li>
      </ul>
      <p>
        Private content is stored in the same version — the owner always sees everything. Public readers see only the
        filtered view. The public content hash excludes private data, so verifiers can confirm integrity of the public
        subset.
      </p>

      <h2>API Reference</h2>
      <p>
        Full API docs are at <Link to='/docs'>/docs</Link>. The key endpoints:
      </p>
      <table>
        <tbody>
          <tr>
            <td>
              <code>POST .../versions</code>
            </td>
            <td>Push a new version (up to 100MB)</td>
          </tr>
          <tr>
            <td>
              <code>POST .../versions/upload</code>
            </td>
            <td>Start chunked upload (for large pushes)</td>
          </tr>
          <tr>
            <td>
              <code>GET .../versions/latest</code>
            </td>
            <td>Get latest version</td>
          </tr>
          <tr>
            <td>
              <code>GET .../versions/:n/records</code>
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

      <h2>Large Pushes (Chunked Upload)</h2>
      <p>For pushes exceeding 100MB or containing hundreds of thousands of records, use the chunked upload protocol:</p>
      <ol>
        <li>
          <strong>Start session:</strong> <code>POST .../versions/upload</code>{' '}
          with metadata (base_version, schemas, message). Returns a <code>sessionId</code>.
        </li>
        <li>
          <strong>Append batches:</strong> <code>PUT .../versions/upload/:sessionId</code>{' '}
          with up to 10,000 records per batch. Repeat as needed.
        </li>
        <li>
          <strong>Finalize:</strong> <code>POST .../versions/upload/:sessionId/finalize</code>{' '}
          to validate and create the version.
        </li>
      </ol>
      <p>
        Sessions expire after 1 hour. If the same record ID appears in multiple batches, last write wins. See the{' '}
        <Link to='/docs/api/versions'>Versions API docs</Link> for full details.
      </p>

      <h2>Error Handling</h2>
      <ul>
        <li>
          <code>409 Conflict</code> — Another version was pushed since your{' '}
          <code>base_version</code>. Re-fetch and retry.
        </li>
        <li>
          <code>422 Unprocessable</code> — Records reference files that haven't been uploaded. Upload them first.
        </li>
        <li>
          <code>400 Bad Request</code> — Schema validation failed or hash mismatch on file upload.
        </li>
      </ul>

      <h2>Source Code</h2>
      <p>
        Underlay is open source:{' '}
        <a href='https://github.com/knowledgefutures/underlay'>github.com/knowledgefutures/underlay</a>
      </p>
      <p>
        Built by <a href='https://www.knowledgefutures.org'>Knowledge Futures</a>, a 501(c)(3) nonprofit. Contact:{' '}
        <a href='mailto:team@knowledgefutures.org'>team@knowledgefutures.org</a>
      </p>
    </DocsLayout>
  )
}
