import DocsLayout from '~/components/DocsLayout'

const pushReq = `{
  "base_version": "v1.0.0",
  "message": "Add new publications",
  "app_id": "pubpub-sync",
  "actor_id": "user-42",
  "metadata": {
    "description": "PubPub archive",
    "readme": "# Publications\\nArchived from PubPub."
  },
  "schemas": {
    "Publication": {
      "type": "object",
      "properties": {
        "title": {"type": "string"}
      }
    }
  },
  "changes": {
    "added": [
      {"id": "rec-1", "type": "Publication", "data": {"title": "..."}}
    ],
    "updated": [
      {"id": "rec-0", "type": "Publication", "data": {"title": "Updated"}}
    ],
    "removed": ["rec-old"]
  }
}`

const pushRes = `{
  "semver": "v1.1.0",
  "hash": "a1b2c3d4...",
  "recordCount": 150,
  "fileCount": 12
}`

const listRes = `[
  {
    "semver": "v1.1.0",
    "hash": "a1b2c3d4...",
    "message": "Add new publications",
    "appId": "pubpub-sync",
    "actorId": "user-42",
    "recordCount": 150,
    "fileCount": 12,
    "totalBytes": 52428800,
    "createdAt": "2026-04-01T00:00:00.000Z"
  }
]`

const recordsRes = `{
  "records": [
    {
      "id": "pub-001",
      "type": "Publication",
      "data": {
        "title": "Example Paper",
        "doi": "10.1234/example"
      }
    }
  ],
  "pagination": {
    "limit": 100,
    "hasMore": true,
    "nextCursor": "pub-002",
    "total": 150
  }
}`

const manifestRes = `{
  "semver": "v1.1.0",
  "hash": "a1b2c3d4...",
  "schemas": {"Publication": "sha256:abc123..."},
  "records": [
    {"id": "pub-001", "type": "Publication", "hash": "sha256:def456..."},
    {"id": "pub-002", "type": "Publication", "hash": "sha256:789abc..."}
  ],
  "files": ["sha256:a1b2c3...", "sha256:d4e5f6..."]
}`

const diffRes = `{
  "from": "v1.0.0",
  "to": "v1.1.0",
  "added": [
    {"id": "pub-003", "type": "Publication", "data": {...}}
  ],
  "updated": [
    {"id": "pub-001", "type": "Publication", "data": {...}}
  ],
  "removed": ["pub-old"]
}`

export default function DocsApiVersions() {
  return (
    <DocsLayout title="Versions API">
      <p>
        Versions are the core of Underlay. Each version is an immutable snapshot of a collection:
        schema + records + file references.
      </p>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2>POST /api/collections/:owner/:slug/versions</h2>
        <p className="scope">Auth: write scope</p>
        <p>
          Push a new version. This is the primary write operation. You send a{' '}
          <code>base_version</code> for optimistic locking, an optional schema, and a set of changes
          (added, updated, removed records). The server computes the full snapshot from the previous
          version plus your changes.
        </p>
        <h3>Request</h3>
        <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
          <code>{pushReq}</code>
        </pre>
        <h3>Fields</h3>
        <table>
          <tbody>
            <tr>
              <td>
                <code>base_version</code>
              </td>
              <td>
                <strong>Required.</strong> The semver string this push is based on (e.g.{' '}
                <code>"v1.0.0"</code>). Use <code>null</code> for the first version. If the current
                version doesn't match, returns <code>409 Conflict</code>.
              </td>
            </tr>
            <tr>
              <td>
                <code>message</code>
              </td>
              <td>Human-readable commit message.</td>
            </tr>
            <tr>
              <td>
                <code>app_id</code>
              </td>
              <td>Identifier for the application that pushed this version.</td>
            </tr>
            <tr>
              <td>
                <code>actor_id</code>
              </td>
              <td>Identifier for the user or process that triggered the push.</td>
            </tr>
            <tr>
              <td>
                <code>metadata</code>
              </td>
              <td>
                Optional object with version metadata (<code>description</code>, <code>readme</code>
                , <code>license</code>, etc.). Merged with the previous version's metadata.
              </td>
            </tr>
            <tr>
              <td>
                <code>schemas</code>
              </td>
              <td>
                Per-type JSON Schema map (e.g. <code>{'{"TypeName": {schema}}'}</code>). Required on
                first push. If omitted on subsequent pushes, the previous version's schemas are
                reused.
              </td>
            </tr>
            <tr>
              <td>
                <code>changes.added</code>
              </td>
              <td>
                New records to add. Each record can include <code>"private": true</code> to hide it
                from public readers.
              </td>
            </tr>
            <tr>
              <td>
                <code>changes.updated</code>
              </td>
              <td>
                Existing records to replace (by id). Can include <code>"private": true</code>.
              </td>
            </tr>
            <tr>
              <td>
                <code>changes.removed</code>
              </td>
              <td>Record IDs to remove.</td>
            </tr>
          </tbody>
        </table>

        <h3>Schema privacy</h3>
        <p>
          You can add <code>"private": true</code> at two levels in the schema:
        </p>
        <ul>
          <li>
            <strong>Type-level:</strong> Add <code>"private": true</code> to a type definition to
            hide all records of that type from public readers. The type is also stripped from the
            public schema response.
          </li>
          <li>
            <strong>Field-level:</strong> Add <code>"private": true</code> to a field definition to
            strip that field from records returned to public readers. The field is also removed from
            the public schema.
          </li>
        </ul>
        <p>Example schema with privacy:</p>
        <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
          <code>{`"schemas": {
  "Article": {
    "type": "object",
    "properties": {
      "title": {"type": "string"},
      "body": {"type": "string"},
      "internalScore": {"type": "number", "private": true}
    }
  },
  "InternalNote": {
    "type": "object",
    "private": true,
    "properties": {
      "note": {"type": "string"}
    }
  }
}`}</code>
        </pre>
        <h3>
          Response <span className="text-ink-muted font-normal">201</span>
        </h3>
        <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
          <code>{pushRes}</code>
        </pre>
        <h3>Errors</h3>
        <table>
          <tbody>
            <tr>
              <td>
                <code>409</code>
              </td>
              <td>
                Version conflict — someone pushed since your <code>base_version</code>. Re-fetch and
                retry.
              </td>
            </tr>
            <tr>
              <td>
                <code>422</code>
              </td>
              <td>
                Missing files — records reference files that haven't been uploaded yet. Response
                includes <code>filesNeeded</code> array.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2>GET /api/collections/:owner/:slug/versions</h2>
        <p className="scope">No auth for public collections</p>
        <p>List versions, newest first.</p>
        <h3>Query parameters</h3>
        <table>
          <tbody>
            <tr>
              <td>
                <code>limit</code>
              </td>
              <td>Max results (default 50, max 100)</td>
            </tr>
            <tr>
              <td>
                <code>offset</code>
              </td>
              <td>Pagination offset</td>
            </tr>
          </tbody>
        </table>
        <h3>
          Response <span className="text-ink-muted font-normal">200</span>
        </h3>
        <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
          <code>{listRes}</code>
        </pre>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2>GET /api/collections/:owner/:slug/versions/latest</h2>
        <p className="scope">No auth for public collections</p>
        <p>Get the most recent version. Returns the full version object.</p>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2>GET /api/collections/:owner/:slug/versions/:n</h2>
        <p className="scope">No auth for public collections</p>
        <p>
          Get a specific version by semver (e.g. <code>v1.1.0</code>). Returns the full version
          object including schemas.
        </p>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2>GET /api/collections/:owner/:slug/versions/:n/records</h2>
        <p className="scope">No auth for public collections</p>
        <p>
          Get records for a specific version. Supports cursor-based pagination for efficient
          traversal of large collections.
        </p>
        <h3>Query parameters</h3>
        <table>
          <tbody>
            <tr>
              <td>
                <code>type</code>
              </td>
              <td>Filter by record type</td>
            </tr>
            <tr>
              <td>
                <code>limit</code>
              </td>
              <td>Max results (default 100, max 1000)</td>
            </tr>
            <tr>
              <td>
                <code>after</code>
              </td>
              <td>Cursor: return records with IDs after this value (preferred for large sets)</td>
            </tr>
            <tr>
              <td>
                <code>offset</code>
              </td>
              <td>Legacy offset-based pagination (still supported)</td>
            </tr>
          </tbody>
        </table>
        <h3>
          Response <span className="text-ink-muted font-normal">200</span>
        </h3>
        <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
          <code>{recordsRes}</code>
        </pre>
        <p>
          Use <code>pagination.nextCursor</code> as the <code>after</code> parameter in the next
          request. When <code>hasMore</code> is false, you've reached the end.
        </p>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2>GET /api/collections/:owner/:slug/versions/:n/manifest</h2>
        <p className="scope">No auth for public collections</p>
        <p>
          Get the manifest: a lightweight summary of what's in a version without the full record
          data.
        </p>
        <h3>
          Response <span className="text-ink-muted font-normal">200</span>
        </h3>
        <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
          <code>{manifestRes}</code>
        </pre>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2>GET /api/collections/:owner/:slug/versions/:n/diff</h2>
        <p className="scope">No auth for public collections</p>
        <p>
          Diff two versions. By default compares version <code>:n</code> against the previous
          version.
        </p>
        <h3>Query parameters</h3>
        <table>
          <tbody>
            <tr>
              <td>
                <code>from</code>
              </td>
              <td>
                Semver to diff from (e.g. <code>v1.0.0</code>). Default: previous version.
              </td>
            </tr>
          </tbody>
        </table>
        <h3>
          Response <span className="text-ink-muted font-normal">200</span>
        </h3>
        <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
          <code>{diffRes}</code>
        </pre>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2>Chunked Upload (Large Pushes)</h2>
        <p>
          For pushes exceeding 100MB or containing millions of records, use the chunked upload
          protocol instead of the single-request push. This streams changes in batches to avoid body
          size limits and server memory pressure.
        </p>

        <h3>Flow</h3>
        <ol>
          <li>
            <strong>Start session</strong> — POST metadata (base_version, schemas, message)
          </li>
          <li>
            <strong>Append batches</strong> — PUT changes in chunks of up to 10,000 records each
          </li>
          <li>
            <strong>Finalize</strong> — POST to create the immutable version from all staged records
          </li>
        </ol>

        <h3>POST /api/collections/:owner/:slug/versions/upload</h3>
        <p className="scope">Auth: write scope</p>
        <p>Start a new upload session. Returns a session ID valid for 1 hour.</p>
        <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
          <code>{`{
  "base_version": "v3.0.0",
  "message": "Bulk import",
  "app_id": "my-app",
  "schemas": { "Article": { "type": "object", "properties": { ... } } }
}`}</code>
        </pre>
        <h4>
          Response <span className="text-ink-muted font-normal">201</span>
        </h4>
        <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
          <code>{`{
  "sessionId": "uuid",
  "expiresAt": "2026-04-30T01:00:00.000Z"
}`}</code>
        </pre>

        <h3>PUT /api/collections/:owner/:slug/versions/upload/:sessionId</h3>
        <p className="scope">Auth: write scope</p>
        <p>
          Append a batch of changes to the session. Call as many times as needed. Max 10,000 records
          per batch. If the same record ID appears in multiple batches, last write wins.
        </p>
        <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
          <code>{`{
  "changes": {
    "added": [{"id": "rec-1", "type": "Article", "data": {...}}],
    "updated": [...],
    "removed": ["rec-old"]
  }
}`}</code>
        </pre>
        <h4>
          Response <span className="text-ink-muted font-normal">200</span>
        </h4>
        <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
          <code>{`{
  "received": { "added": 5000, "updated": 0, "removed": 0 },
  "totalStaged": 15000
}`}</code>
        </pre>

        <h3>POST /api/collections/:owner/:slug/versions/upload/:sessionId/finalize</h3>
        <p className="scope">Auth: write scope</p>
        <p>
          Finalize the session: applies all staged changes to the base version, validates records
          against schemas, computes hashes, and creates the new immutable version.
        </p>
        <h4>
          Response <span className="text-ink-muted font-normal">201</span>
        </h4>
        <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
          <code>{`{
  "semver": "v1.3.0",
  "hash": "...",
  "recordCount": 2000000,
  "fileCount": 5
}`}</code>
        </pre>
        <h4>Errors</h4>
        <table>
          <tbody>
            <tr>
              <td>
                <code>409</code>
              </td>
              <td>
                Version conflict — someone pushed since your base_version. Start a new session.
              </td>
            </tr>
            <tr>
              <td>
                <code>410</code>
              </td>
              <td>Session expired — the 1-hour window elapsed.</td>
            </tr>
            <tr>
              <td>
                <code>422</code>
              </td>
              <td>Schema validation failed or missing files.</td>
            </tr>
          </tbody>
        </table>

        <h3>GET /api/collections/:owner/:slug/versions/upload/:sessionId</h3>
        <p className="scope">Auth: read scope</p>
        <p>
          Check session status. Returns status (<code>open</code>, <code>finalizing</code>,{' '}
          <code>completed</code>, <code>failed</code>, <code>expired</code>), record count, and
          expiry.
        </p>

        <h3>DELETE /api/collections/:owner/:slug/versions/upload/:sessionId</h3>
        <p className="scope">Auth: write scope</p>
        <p>Cancel and discard a session. Staged records are deleted. Returns 204.</p>
      </div>
    </DocsLayout>
  )
}
