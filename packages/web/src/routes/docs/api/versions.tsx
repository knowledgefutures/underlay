import DocsLayout from '~/components/DocsLayout'

const openReq = `{
  "base": "v1.0.0",
  "schemas": {
    "Publication": {
      "type": "object",
      "properties": {
        "title": {"type": "string"},
        "pdf": {"type": "object"}
      }
    }
  },
  "metadata_patch": {"description": "PubPub archive"},
  "files": {"add": ["7a8b9c..."]},
  "message": "Add new publications"
}`

const openRes = `{
  "session_id": "uuid",
  "base": "v1.0.0",
  "needed_files": ["7a8b9c..."],
  "expires_at": "2026-10-04T13:00:00.000Z",
  "limits": {
    "open_bytes": 8388608,
    "batch_bytes": 16777216,
    "batch_lines": 10000,
    "session_idle_seconds": 3600,
    "open_sessions": 20,
    "file_bytes": 33554432
  }
}`

const recordsReq = `{"id":"pub-002","type":"Publication","data":{"title":"New Paper"}}
{"id":"pub-003","type":"Publication","data":{"title":"Draft"},"private":true}`

const deletesReq = `{"type":"Publication","id":"pub-old"}`

const commitRes = `{
  "semver": "v1.1.0",
  "hash": "ulv2:a1b2c3d4...",
  "recordCount": 3,
  "fileCount": 1,
  "changes": {"added": 2, "removed": 1, "updated": 0}
}`

const asyncCommitRes = `{
  "session_id": "uuid",
  "status": "committing",
  "poll": "GET /api/collections/:owner/:slug/push/uuid"
}`

const sessionPollRes = `{
  "session_id": "uuid",
  "status": "committed",
  "records_received": 3110000,
  "expires_at": "2026-10-04T13:00:00.000Z",
  "created_at": "2026-10-04T12:00:00.000Z",
  "finalize_started_at": "2026-10-04T12:20:00.000Z",
  "result": {
    "semver": "v1.1.0",
    "hash": "ulv2:a1b2c3d4...",
    "recordCount": 3110000,
    "fileCount": 0,
    "changes": {"added": 3110000, "removed": 0, "updated": 0}
  },
  "error": null
}`

const noCopy = `# 1. What the head holds: page the manifest (members also see private records)
GET .../versions/latest/manifest?limit=25000           # then ?cursor=<nextCursor>
# 2. Compare by (type, id): hash your current records (canonical form, SHA-256)
#    new, changed hash, or changed privacy  -> upsert
#    in the manifest but not in your data   -> delete
# 3. Push only those, against the manifest's semver
POST .../push  {"base": "<manifest semver>"}
POST .../push/:sid/records   ...
POST .../push/:sid/deletes   ...
POST .../push/:sid/commit`

const listRes = `[
  {
    "semver": "v1.1.0",
    "hash": "ulv2:a1b2c3d4...",
    "message": "Add new publications",
    "appId": "pubpub-sync",
    "pushedBy": "user-42",
    "pushedByName": "Ada Lovelace",
    "actorId": "user-42",
    "recordCount": 150,
    "fileCount": 12,
    "totalBytes": 52428800,
    "createdAt": "2026-04-01T00:00:00.000Z",
    "ark": "https://underlay.org/ark:12345/ulb9bq4n5gmv3k0.v1.1.0"
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
    "nextCursor": "eyJyIjpbInB1Yi0wMDIiLCJkZWY0NTYiXX0",
    "total": 150
  }
}`

const ndjsonRes = `HTTP/1.1 200 OK
Content-Type: application/x-ndjson
X-Underlay-Record-Count: 3113504

{"id":"pub-001","type":"Publication","data":{"title":"..."},"hash":"sha256:..."}
{"id":"pub-002","type":"Publication","data":{"title":"..."},"hash":"sha256:..."}
{"id":"pub-003","type":"Publication","data":{"title":"..."},"hash":"sha256:..."}`

const manifestRes = `{
  "semver": "v1.1.0",
  "hash": "ulv2:a1b2c3d4...",
  "schemas": {"Publication": "abc123..."},
  "records": [
    {"id": "pub-001", "type": "Publication", "hash": "def456..."},
    {"id": "pub-002", "type": "Publication", "hash": "789abc...", "private": true}
  ],
  "files": ["a1b2c3...", "d4e5f6..."],
  "pagination": {
    "limit": 10000,
    "hasMore": true,
    "nextCursor": "eyJhZGRlZCI6WyJwdWItMDAyIiwiZGVmNDU2Il0..."
  }
}`

const manifestDeltaRes = `{
  "semver": "v1.1.0",
  "hash": "ulv2:a1b2c3d4...",
  "since": "v1.0.0",
  "schemas": {"Publication": "abc123..."},
  "delta": {
    "added":   [{"id": "pub-003", "type": "Publication", "hash": "def456..."}],
    "updated": [{"id": "pub-001", "type": "Publication", "hash": "def456...",
                 "previousHash": "abc123..."}],
    "removed": [{"id": "pub-old", "type": "Publication", "hash": "def456..."}]
  },
  "files": ["a1b2c3..."],
  "pagination": {
    "limit": 10000,
    "hasMore": false,
    "nextCursor": null
  }
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
        schemas, records and file references. You publish one with a <strong>delta push</strong>:
        open a session against the version you started from, upload the records you add or change
        and the ids you delete, and commit. The same exchange works against any Underlay node (
        <a href="/docs/protocol/push-and-pull">Push and pull</a>).
      </p>
      <p>
        <strong>Version hashes</strong> are <code>ulv2:&lt;sha256&gt;</code>, the hash of the
        version&rsquo;s root, and are the same for every reader: the private set is in the root only
        as a salted commitment (see{' '}
        <a href="/docs/protocol/versions#version-root">Trees and versions</a>). Wherever a version
        is named in a path (<code>:n</code>), it can be a semver (<code>v1.1.0</code>), a version
        hash, or <code>latest</code>. Record, schema and file hashes are bare hex with no prefix.
      </p>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2>Delta push (open → upload → commit)</h2>
        <p>
          A push costs work in proportion to what changed, not to the size of the collection. Only
          the records you send are validated and hashed; unchanged records are never re-sent.
        </p>

        <h3>POST /api/collections/:owner/:slug/push</h3>
        <p className="scope">Auth: write scope</p>
        <p>Open a session. Every field is optional.</p>
        <h4>Request</h4>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{openReq}</code>
        </pre>
        <h4>Fields</h4>
        <table>
          <tbody>
            <tr>
              <td>
                <code>base</code>
              </td>
              <td>
                The semver you started from. If it isn&rsquo;t the collection&rsquo;s head, the
                answer is <code>409</code> with <code>currentVersion</code>. <code>null</code> or
                absent applies the changes to whatever the head is (use <code>null</code> for the
                first version).
              </td>
            </tr>
            <tr>
              <td>
                <code>schemas</code>
              </td>
              <td>
                The full type set, <code>{'{"TypeName": schema}'}</code>. It replaces the
                base&rsquo;s: a type left out is removed with its records. Absent keeps the
                base&rsquo;s types.
              </td>
            </tr>
            <tr>
              <td>
                <code>metadata</code> / <code>metadata_patch</code>
              </td>
              <td>
                <code>metadata</code> replaces the version metadata (<code>description</code>,{' '}
                <code>readme</code>, <code>license</code>, …); <code>metadata_patch</code> merges
                its top-level members into the base&rsquo;s. With neither, the metadata is kept.
              </td>
            </tr>
            <tr>
              <td>
                <code>files</code>
              </td>
              <td>
                <code>{'{"add": [hash, …], "remove": [hash, …]}'}</code>: files to declare or drop
                beyond those your records reference.
              </td>
            </tr>
            <tr>
              <td>
                <code>message</code>, <code>app_id</code>, <code>actor_id</code>
              </td>
              <td>Strings recorded in the version&rsquo;s signed log entry.</td>
            </tr>
            <tr>
              <td>
                <code>strip_unknown_fields</code>
              </td>
              <td>
                If <code>true</code>, top-level fields a record&rsquo;s schema doesn&rsquo;t list in{' '}
                <code>properties</code> are dropped before the record is hashed, instead of refusing
                the record.
              </td>
            </tr>
          </tbody>
        </table>
        <h4>
          Response <span className="text-ink-muted font-normal">200</span>
        </h4>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{openRes}</code>
        </pre>
        <p>
          <code>needed_files</code> are the declared files this collection doesn&rsquo;t hold yet:
          upload them before you commit. <code>limits</code> are this node&rsquo;s; size your
          batches by them. The session expires after <code>session_idle_seconds</code> without an
          upload, and every upload pushes <code>expires_at</code> back.
        </p>

        <h3>POST .../push/:sid/records</h3>
        <p className="scope">Auth: write scope</p>
        <p>
          Upserts as NDJSON (<code>Content-Type: application/x-ndjson</code>), one record per line:{' '}
          <code>{'{"id", "type", "data", "private"?}'}</code>. Call it as many times as you need, up
          to <code>batch_lines</code> lines and <code>batch_bytes</code> bytes each.
        </p>
        <h4>Request</h4>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{recordsReq}</code>
        </pre>
        <h4>
          Response <span className="text-ink-muted font-normal">200</span>
        </h4>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{'{ "received": 2 }'}</code>
        </pre>
        <p>
          Each line passes the input rules and its type&rsquo;s schema, and its type must be in the
          session&rsquo;s type set. If any line fails, the answer is <code>422</code> with{' '}
          <code>validationErrors</code>, one per failing line with its 1-based <code>line</code>{' '}
          number, and nothing from the batch is stored.
        </p>

        <h3>POST .../push/:sid/deletes</h3>
        <p className="scope">Auth: write scope</p>
        <p>
          Deletes as NDJSON, one <code>{'{"type", "id"}'}</code> per line; the answer is{' '}
          <code>{'{ "received": n }'}</code>. Deleting an id the base doesn&rsquo;t hold is not an
          error. Within a session the later upload of a (type, id) wins, whether it is a record or a
          delete.
        </p>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{deletesReq}</code>
        </pre>

        <h3>PUT .../files/:hash</h3>
        <p className="scope">Auth: write scope</p>
        <p>
          Upload a file&rsquo;s bytes under its SHA-256 hash: <code>201</code>, or <code>400</code>{' '}
          if the bytes don&rsquo;t match the hash. Files over <code>file_bytes</code> are a{' '}
          <code>413</code>; upload those through <a href="/docs/api/files">the Files API</a>. Every
          file a new record references must be uploaded before the commit.
        </p>

        <h3>POST .../push/:sid/commit</h3>
        <p className="scope">Auth: write scope</p>
        <p>Build the version. No body is needed.</p>
        <h4>
          Response <span className="text-ink-muted font-normal">201</span>
        </h4>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{commitRes}</code>
        </pre>
        <p>
          The semver follows from what changed against the base: <strong>major</strong> when a type
          was added or removed or a schema changed, otherwise <strong>minor</strong> when any record
          was added, removed or changed (moving between public and private counts), otherwise{' '}
          <strong>patch</strong> (metadata or files only). A push that changes nothing makes no
          version and answers <code>409</code>.
        </p>
        <p>
          With <code>?async=true</code>, or whenever the push is large, the answer is{' '}
          <code>202</code> and the version is built in the background:
        </p>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{asyncCommitRes}</code>
        </pre>
        <p>
          Poll <code>GET .../push/:sid</code> until <code>status</code> is <code>committed</code> (
          <code>result</code> is the <code>201</code> body) or <code>failed</code> (
          <code>error</code> is the rejection). The version isn&rsquo;t visible to readers until it
          is committed.
        </p>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{sessionPollRes}</code>
        </pre>
        <p>
          <code>DELETE .../push/:sid</code> abandons a session.
        </p>

        <h3>Clients that keep no copy</h3>
        <p>
          A client that exports its whole dataset each time, rather than tracking changes, reads the
          head&rsquo;s manifest, diffs against it, and pushes only the differences. The upload is
          the size of the changes, whatever the size of the collection.
        </p>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{noCopy}</code>
        </pre>

        <h3>Privacy</h3>
        <ul>
          <li>
            <strong>Type-level:</strong> <code>"private": true</code> at a schema&rsquo;s root hides
            every record of that type from people outside the owning organization.
          </li>
          <li>
            <strong>Record-level:</strong> <code>"private": true</code> on a record line puts that
            record in the version&rsquo;s private set. It belongs to this version&rsquo;s reference
            to the record: a record keeps its flag until a later upload of the same id changes it.
          </li>
        </ul>
        <p>
          <code>"private": true</code> on a property inside a schema (field-level privacy) is
          refused. Put private fields in a private type, or push the whole record as private.
          Privacy is per version: marking a record private in v1.1.0 doesn&rsquo;t change v1.0.0,
          which still serves it.
        </p>

        <h3>Errors</h3>
        <table>
          <tbody>
            <tr>
              <td>
                <code>403</code>
              </td>
              <td>
                You can read the collection but not write to it, or the session is another
                user&rsquo;s.
              </td>
            </tr>
            <tr>
              <td>
                <code>404</code>
              </td>
              <td>Collection or session not found, or not visible to you.</td>
            </tr>
            <tr>
              <td>
                <code>409</code>
              </td>
              <td>
                <code>base</code> isn&rsquo;t the head (<code>currentVersion</code> says what is),
                the head moved before the commit, the session isn&rsquo;t open, or the push changes
                nothing (<code>"No changes detected"</code>).
              </td>
            </tr>
            <tr>
              <td>
                <code>413</code>
              </td>
              <td>
                A body over <code>open_bytes</code> or <code>batch_bytes</code>, a batch over{' '}
                <code>batch_lines</code>, or a file over <code>file_bytes</code>.
              </td>
            </tr>
            <tr>
              <td>
                <code>422</code>
              </td>
              <td>
                Records or deletes that fail (<code>validationErrors</code>), a schema that is
                refused, or a commit with files not uploaded (<code>filesNeeded</code>).
              </td>
            </tr>
            <tr>
              <td>
                <code>429</code>
              </td>
              <td>
                You have <code>open_sessions</code> sessions in progress (commit or abandon one), or
                a rate limit (<code>Retry-After</code>).
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
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{listRes}</code>
        </pre>
        <p>
          <code>pushedBy</code>, <code>pushedByName</code> and <code>actorId</code> are for the
          collection's members only. <code>ark</code> is null when the collection's ARK is off.
        </p>
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
          Get a specific version by semver (e.g. <code>v1.1.0</code>) or version hash. Returns the
          full version object including schemas.
        </p>
        <p>
          With <code>?records=&lt;type&gt;</code> (empty for the first type), it also returns{' '}
          <code>recordsPage</code>: a page of that type&rsquo;s records (<code>offset</code>,{' '}
          <code>limit</code> as on <code>/records</code>) and the type&rsquo;s total, and{' '}
          <code>schemas</code> holds only that type&rsquo;s schema; <code>typeCounts</code> still
          lists every type. A records page needs only this one call.
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
                Opaque keyset cursor from <code>pagination.nextCursor</code>. Records are ordered by
                record id then record hash, so records that share an id across types are never
                skipped at a page boundary. Canonical method — stays fast at any depth.{' '}
                <code>cursor</code> is accepted as an alias. A bare record id is still accepted and
                returns records with IDs strictly after it, but that skips any other records sharing
                the last id; prefer <code>nextCursor</code>.
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
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{getRecordsRes}</code>
        </pre>
        <p>
          Use <code>pagination.nextCursor</code> as the <code>after</code> parameter in the next
          request, unchanged — treat it as opaque. When <code>hasMore</code> is false, you've
          reached the end. For large collections, always paginate with <code>after</code> rather
          than <code>offset</code>.
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
        <h2>GET /api/collections/:owner/:slug/versions/:n/records.ndjson</h2>
        <p className="scope">No auth for public collections</p>
        <p>
          Every record in the version, streamed as newline-delimited JSON in a single response. This
          is the bulk read path. Paging <code>/records</code> costs a round trip per page purely to
          re-establish a cursor the server just had — 1,556 requests for a 3.1-million-record
          collection, against one here. The server reads through a database cursor and writes as it
          goes, so memory stays constant on both ends and you can process the first line before the
          last is sent.
        </p>
        <h3>Query parameters</h3>
        <table>
          <tbody>
            <tr>
              <td>
                <code>type</code>
              </td>
              <td>Restrict to a single record type</td>
            </tr>
            <tr>
              <td>
                <code>after</code>
              </td>
              <td>
                Resume: emit only records with ids strictly after this value. Records are ordered by
                id ascending, so this restarts a dropped read from where it stopped rather than from
                the beginning.
              </td>
            </tr>
          </tbody>
        </table>
        <h3>
          Response <span className="text-ink-muted font-normal">200</span>
        </h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{ndjsonRes}</code>
        </pre>
        <p>
          <code>hash</code> is the same content address <code>/records</code> serves. Privacy
          filtering is identical too: private types and private records are absent.
        </p>
        <p>
          <strong>Check completeness yourself.</strong> A stream that fails partway cannot report
          it: the <code>200</code> and headers were sent before anything went wrong.{' '}
          <code>X-Underlay-Record-Count</code> tells you how many lines to expect — the count for{' '}
          <em>this</em> request, privacy-filtered for your access level and scoped to{' '}
          <code>?type=</code> if you passed one, so the comparison is exact. (Don&rsquo;t compare
          against the version&rsquo;s <code>recordCount</code>: that is the full total and counts
          private records you may not be receiving.) If you receive fewer, resume with{' '}
          <code>?after=</code> set to the id of the last complete line you parsed — don't start
          over.
        </p>
        <p>
          A record id is not guaranteed unique within a version — the same id can appear under more
          than one hash. Because <code>after</code> resumes strictly past the id, a stream that
          broke between two lines sharing an id will skip the second on resume. This matches{' '}
          <code>/records</code> paging, and the line-count check above is what catches it.
        </p>
        <p className="text-ink-muted">
          Responses are compressed when you send <code>Accept-Encoding: gzip</code>, which most HTTP
          clients do automatically — roughly 3× on record data, and it applies to this stream as
          well.
        </p>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2>GET /api/collections/:owner/:slug/versions/:n/manifest</h2>
        <p className="scope">No auth for public collections</p>
        <p>
          Get the manifest: every record's id, type and content hash, without the bodies, in (type,
          id) order. Members also see private records, marked <code>"private": true</code>. This is
          the cheapest way to learn what a version contains — at roughly 120 bytes per entry, a
          million records is one order of magnitude smaller than fetching them — and what a client
          that keeps no copy diffs against before it pushes.
        </p>
        <h3>Query parameters</h3>
        <table>
          <tbody>
            <tr>
              <td>
                <code>limit</code>
              </td>
              <td>
                Entries per page (default 10000, max 25000). The first page also lists the
                version&rsquo;s files, at most 25,000, with <code>filesTruncated: true</code> past
                that
              </td>
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
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{manifestRes}</code>
        </pre>
        <h3>
          Response with <code>?since=</code> <span className="text-ink-muted font-normal">200</span>
        </h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{manifestDeltaRes}</code>
        </pre>
        <p>
          A delta of any size can be walked to completion: keep re-requesting with{' '}
          <code>cursor=pagination.nextCursor</code> until <code>hasMore</code> is false. The three
          lists drain independently and the cursor tracks each one, so a page late in the walk may
          contain only <code>updated</code> entries.
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
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{diffRes}</code>
        </pre>
      </div>
    </DocsLayout>
  )
}
