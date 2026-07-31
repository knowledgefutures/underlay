import DocsLayout from '~/components/DocsLayout'

const negotiateReq = `{
  "base_version": "v1.0.0",
  "schemas": {
    "Publication": {
      "type": "object",
      "properties": {
        "title": {"type": "string"}
      }
    }
  },
  "manifest": [
    {"id": "pub-001", "type": "Publication", "hash": "abc123..."},
    {"id": "pub-002", "type": "Publication", "hash": "def456..."},
    {"id": "pub-003", "type": "Publication", "hash": "789abc..."}
  ],
  "files": ["7a8b9c..."],
  "message": "Add new publications",
  "metadata": {
    "description": "PubPub archive"
  }
}`

const negotiateRes = `{
  "session_id": "uuid",
  "needed_records": ["def456...", "789abc..."],
  "needed_files": [],
  "total_records": 3,
  "total_files": 1,
  "already_have_records": 1,
  "already_have_files": 1
}`

const recordsRes = `{
  "received": 2,
  "remaining": 0,
  "total_needed": 2
}`

const commitRes = `{
  "semver": "v1.1.0",
  "hash": "a1b2c3d4...",
  "recordCount": 3,
  "fileCount": 1
}`

const asyncCommitRes = `{
  "session_id": "uuid",
  "status": "committing",
  "message": "Commit accepted. Poll GET .../versions/negotiate/uuid until status is \\"committed\\" or \\"failed\\"."
}`

const sessionPollRes = `{
  "session_id": "uuid",
  "status": "committed",
  "total_records": 3110000,
  "needed_records": 0,
  "finalize_started_at": "2026-07-31T12:00:00.000Z",
  "result": {
    "semver": "v1.1.0",
    "hash": "private:a1b2c3d4...",
    "recordCount": 3110000,
    "fileCount": 0
  },
  "error": null
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

const getRecordsRes = `{
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
  "files": ["sha256:a1b2c3...", "sha256:d4e5f6..."],
  "pagination": {
    "limit": 10000,
    "hasMore": true,
    "nextCursor": "eyJhZGRlZCI6WyJwdWItMDAyIiwiZGVmNDU2Il0..."
  }
}`

const manifestDeltaRes = `{
  "semver": "v1.1.0",
  "hash": "a1b2c3d4...",
  "since": "v1.0.0",
  "schemas": {"Publication": "sha256:abc123..."},
  "delta": {
    "added":   [{"id": "pub-003", "type": "Publication", "hash": "sha256:..."}],
    "updated": [{"id": "pub-001", "type": "Publication", "hash": "sha256:...",
                 "previousHash": "sha256:..."}],
    "removed": [{"id": "pub-old", "type": "Publication", "hash": "sha256:..."}]
  },
  "files": ["sha256:a1b2c3..."],
  "pagination": {
    "limit": 10000,
    "hasMore": false,
    "nextCursor": null
  },
  "truncated": false
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
  "removed": ["pub-old"],
  "pagination": {
    "limit": 500,
    "hasMore": false,
    "nextCursor": null
  },
  "meta": {
    "schemaChanged": false,
    "metadataChanged": false,
    "filesAdded": 0,
    "filesRemoved": 0
  }
}`

export default function DocsApiVersions() {
  return (
    <DocsLayout title="Versions API">
      <p>
        Versions are the core of Underlay. Each version is an immutable snapshot of a collection:
        schema + records + file references. Pushing a new version uses the{' '}
        <strong>negotiate protocol</strong>, a three-step flow similar to git's pack negotiation.
      </p>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2>Push Protocol (Negotiate → Records → Commit)</h2>
        <p>
          All pushes use the negotiate protocol. You send a manifest of record hashes; the server
          tells you which ones it needs; you send only those records; then you commit. For
          collections where most records are unchanged between versions, only a few records are
          transferred.
        </p>

        <h3>Step 1: POST /api/collections/:owner/:slug/versions/negotiate</h3>
        <p className="scope">Auth: write scope</p>
        <p>
          Start a negotiate session. Send your full manifest of record hashes plus schemas. The
          server checks which record and file hashes it already has and returns what it still needs.
        </p>
        <h4>Request</h4>
        <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
          <code>{negotiateReq}</code>
        </pre>
        <h4>Fields</h4>
        <table>
          <tbody>
            <tr>
              <td>
                <code>base_version</code>
              </td>
              <td>
                <strong>Required.</strong> The semver this push is based on (e.g.{' '}
                <code>"v1.0.0"</code>). Use <code>null</code> for the first version. If the current
                version doesn't match, returns <code>409 Conflict</code>.
              </td>
            </tr>
            <tr>
              <td>
                <code>schemas</code>
              </td>
              <td>
                <strong>Required.</strong> Per-type JSON Schema map (e.g.{' '}
                <code>{'{"TypeName": {schema}}'}</code>).
              </td>
            </tr>
            <tr>
              <td>
                <code>manifest</code>
              </td>
              <td>
                <strong>Required.</strong> Array of <code>{'{"id", "type", "hash"}'}</code> objects.
                Each <code>hash</code> is the SHA-256 of the canonical JSON{' '}
                <code>{'{"id":...,"type":...,"data":...}'}</code>.
              </td>
            </tr>
            <tr>
              <td>
                <code>files</code>
              </td>
              <td>Array of file hashes (SHA-256 hex strings) referenced by records.</td>
            </tr>
            <tr>
              <td>
                <code>message</code>
              </td>
              <td>Human-readable commit message.</td>
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
                <code>strip_unknown_fields</code>
              </td>
              <td>
                If <code>true</code>, the server strips fields not defined in the schema instead of
                rejecting the push.
              </td>
            </tr>
          </tbody>
        </table>
        <h4>
          Response <span className="text-ink-muted font-normal">200</span>
        </h4>
        <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
          <code>{negotiateRes}</code>
        </pre>

        <h3>Step 2: POST .../negotiate/:sessionId/records</h3>
        <p className="scope">Auth: write scope</p>
        <p>
          Send needed records as a JSONL body (<code>Content-Type: application/x-ndjson</code>).
          Each line is one JSON record. Only send records whose hashes appear in{' '}
          <code>needed_records</code> from the negotiate response.
        </p>
        <p>
          <strong>Call this endpoint multiple times</strong> to send records in batches (up to
          10,000 per request). The server tracks which records have been received. If{' '}
          <code>needed_records</code> was empty, skip this step and go directly to commit.
        </p>
        <h4>Request</h4>
        <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
          <code>{`{"id":"pub-002","type":"Publication","data":{"title":"New Paper"}}
{"id":"pub-003","type":"Publication","data":{"title":"Another Paper"}}`}</code>
        </pre>
        <h4>
          Response <span className="text-ink-muted font-normal">200</span>
        </h4>
        <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
          <code>{recordsRes}</code>
        </pre>
        <p>
          When <code>remaining</code> reaches 0, all needed records have been received and you can
          commit.
        </p>

        <h3>Step 3: POST .../negotiate/:sessionId/commit</h3>
        <p className="scope">Auth: write scope</p>
        <p>
          Finalize the push. The server validates all records against schemas, computes version
          hashes, and creates the new immutable version. No request body is needed.
        </p>
        <h4>
          Response <span className="text-ink-muted font-normal">201</span>
        </h4>
        <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
          <code>{commitRes}</code>
        </pre>

        <h4>Large pushes: async finalize</h4>
        <p>
          Commit work is proportional to the size of the collection, so on a very large one it can
          run for minutes — longer than a proxy or client will hold a request open. Pass{' '}
          <code>?async=true</code> (or <code>{'{"async": true}'}</code> in the body) and the server
          answers <code>202</code> immediately and builds the version in the background:
        </p>
        <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
          <code>{asyncCommitRes}</code>
        </pre>
        <p>
          Then poll <code>GET .../versions/negotiate/:sessionId</code> until <code>status</code> is{' '}
          <code>committed</code> or <code>failed</code>. On success <code>result</code> holds
          exactly what the synchronous <code>201</code> would have returned; on failure{' '}
          <code>error</code> holds the rejection body it would have returned instead, so the two
          paths are interchangeable apart from timing.
        </p>
        <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
          <code>{sessionPollRes}</code>
        </pre>
        <p className="text-ink-muted">
          The version is not visible to readers until the finalize completes — it is created in a{' '}
          <code>creating</code> state and only published at the end, so there is no window where a
          half-built version can be read. A finalize whose process dies is swept and marked{' '}
          <code>failed</code>, and its partial version removed.
        </p>

        <h3>Schema privacy</h3>
        <p>
          You can add <code>"private": true</code> at two levels in the schema:
        </p>
        <ul>
          <li>
            <strong>Type-level:</strong> Add <code>"private": true</code> to a type definition to
            hide all records of that type from public readers.
          </li>
          <li>
            <strong>Field-level:</strong> Add <code>"private": true</code> to a field definition to
            strip that field from records returned to public readers.
          </li>
        </ul>
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

        <h3>Session management</h3>
        <table>
          <tbody>
            <tr>
              <td>
                <code>GET .../negotiate/:sessionId</code>
              </td>
              <td>Check session status. Returns remaining needed records and files.</td>
            </tr>
            <tr>
              <td>
                <code>DELETE .../negotiate/:sessionId</code>
              </td>
              <td>Cancel a session. Returns 204.</td>
            </tr>
          </tbody>
        </table>

        <h3>Errors</h3>
        <table>
          <tbody>
            <tr>
              <td>
                <code>400</code>
              </td>
              <td>
                Unexpected record hash. A submitted record doesn't match any needed hash, or the
                batch is empty/malformed.
              </td>
            </tr>
            <tr>
              <td>
                <code>404</code>
              </td>
              <td>Session expired or not found. Sessions expire after 10 minutes.</td>
            </tr>
            <tr>
              <td>
                <code>409</code>
              </td>
              <td>
                Version conflict. Someone pushed since your <code>base_version</code>. Re-negotiate.
              </td>
            </tr>
            <tr>
              <td>
                <code>422</code>
              </td>
              <td>
                Schema validation failed, missing files, or records contain extra fields not defined
                in the schema.
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
              <td>Max results (default 100, max 2000)</td>
            </tr>
            <tr>
              <td>
                <code>after</code>
              </td>
              <td>
                Keyset cursor: return records with IDs after this value. Canonical method — stays
                fast at any depth. <code>cursor</code> is accepted as an alias.
              </td>
            </tr>
            <tr>
              <td>
                <code>offset</code>
              </td>
              <td>
                Legacy offset pagination, capped at 10000 (returns 400 beyond that). Use{' '}
                <code>after</code> to page deeper.
              </td>
            </tr>
          </tbody>
        </table>
        <p className="text-ink-muted">
          Walking a whole collection is bounded by request count, not bytes: 60 requests/minute
          anonymous, 5,000 authenticated. Ask for the largest page you can handle — a
          3-million-record collection is 6,200 requests at 500/page and 1,550 at 2,000/page.
        </p>
        <h3>
          Response <span className="text-ink-muted font-normal">200</span>
        </h3>
        <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
          <code>{getRecordsRes}</code>
        </pre>
        <p>
          Use <code>pagination.nextCursor</code> as the <code>after</code> parameter in the next
          request. When <code>hasMore</code> is false, you've reached the end. For large
          collections, always paginate with <code>after</code> rather than <code>offset</code>.
        </p>
        <p className="text-ink-muted">
          <code>pagination.total</code> respects the <code>type</code> filter and excludes private
          types. On collections that mark individual records private it is an upper bound for
          anonymous callers, since those records are hidden but still counted — use{' '}
          <code>hasMore</code> if you need an exact end-of-set signal.
        </p>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2>GET /api/collections/:owner/:slug/versions/:n/manifest</h2>
        <p className="scope">No auth for public collections</p>
        <p>
          Get the manifest: every record's id, type and content hash, without the bodies. This is
          the cheapest way to learn what a version contains — at roughly 120 bytes per entry, a
          million records is one order of magnitude smaller than fetching them.
        </p>
        <h3>Query parameters</h3>
        <table>
          <tbody>
            <tr>
              <td>
                <code>limit</code>
              </td>
              <td>Entries per page (default 10000, max 100000)</td>
            </tr>
            <tr>
              <td>
                <code>cursor</code>
              </td>
              <td>
                Opaque keyset cursor from <code>pagination.nextCursor</code>. Do not construct or
                parse it — pass back exactly what you were given.
              </td>
            </tr>
            <tr>
              <td>
                <code>since</code>
              </td>
              <td>
                Return a delta against this semver instead of the full manifest: which records were
                added, updated and removed between the two versions.
              </td>
            </tr>
          </tbody>
        </table>
        <h3>
          Response <span className="text-ink-muted font-normal">200</span>
        </h3>
        <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
          <code>{manifestRes}</code>
        </pre>
        <h3>
          Response with <code>?since=</code> <span className="text-ink-muted font-normal">200</span>
        </h3>
        <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
          <code>{manifestDeltaRes}</code>
        </pre>
        <p>
          A delta of any size can be walked to completion: keep re-requesting with{' '}
          <code>cursor=pagination.nextCursor</code> until <code>hasMore</code> is false. The three
          lists drain independently and the cursor tracks each one, so a page late in the walk may
          contain only <code>updated</code> entries.
        </p>
        <p className="text-ink-muted">
          <code>truncated</code> is retained for older clients, which treated a capped delta as
          "give up and rebuild from the full manifest". It now simply mirrors{' '}
          <code>pagination.hasMore</code>. Clients that understand the cursor should page instead of
          rebuilding.
        </p>
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
            <tr>
              <td>
                <code>limit</code>
              </td>
              <td>Entries per list per page (default 500, max 5000)</td>
            </tr>
            <tr>
              <td>
                <code>cursor</code>
              </td>
              <td>
                Opaque keyset cursor from <code>pagination.nextCursor</code>, as on the manifest
                endpoint. Diff returns full record bodies, so pages are much larger than manifest
                pages — prefer <code>manifest?since=</code> when you only need the hashes.
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
    </DocsLayout>
  )
}
