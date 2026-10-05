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

const recordsErr = `{
  "error": "Invalid records",
  "validationErrors": [
    {"line": 2, "recordId": "pub-003", "type": "Publication",
     "errors": ["..."]}
  ],
  "totalErrors": 1,
  "statusCode": 422
}`

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
    "major": 1,
    "minor": 1,
    "patch": 0,
    "hash": "ulv2:a1b2c3d4...",
    "baseSemver": "v1.0.0",
    "message": "Add new publications",
    "appId": "pubpub-sync",
    "pushedBy": "user-42",
    "pushedByName": "Ada Lovelace",
    "pushedBySlug": "ada",
    "actorId": "user-42",
    "recordCount": 150,
    "fileCount": 12,
    "totalBytes": 52428800,
    "typeCounts": {"Publication": 150},
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
      },
      "hash": "def456..."
    },
    {
      "id": "pub-002",
      "type": "Publication",
      "data": {"title": "Draft"},
      "hash": "789abc...",
      "private": true
    }
  ],
  "pagination": {
    "limit": 2,
    "hasMore": true,
    "nextCursor": "eyJ0IjoiUHVibGljYXRpb24iLCJrIjoicHViLTAwMiJ9",
    "total": 150
  }
}`

const recordRes = `{
  "id": "pub-001",
  "type": "Publication",
  "data": {"title": "Example Paper"},
  "hash": "def456...",
  "semver": "v1.1.0"
}`

const historyRes = `{
  "type": "Publication",
  "id": "pub-001",
  "changes": [
    {"seq": 1, "semver": "v1.0.0", "createdAt": "2026-03-01T00:00:00.000Z",
     "change": "added", "hash": "abc123..."},
    {"seq": 2, "semver": "v1.1.0", "createdAt": "2026-04-01T00:00:00.000Z",
     "change": "updated", "hash": "def456..."}
  ],
  "truncated": false
}`

const ndjsonRes = `HTTP/1.1 200 OK
Content-Type: application/x-ndjson
X-Underlay-Record-Count: 3110000

{"id":"pub-001","type":"Publication","data":{"title":"..."},"hash":"def456..."}
{"id":"pub-002","type":"Publication","data":{"title":"..."},"hash":"789abc..."}
{"id":"pub-003","type":"Publication","data":{"title":"..."},"hash":"a1b2c3..."}`

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
    "limit": 2,
    "hasMore": true,
    "nextCursor": "eyJ0IjoiUHVibGljYXRpb24iLCJrIjoicHViLTAwMiJ9"
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

const filesRes = `[
  {
    "hash": "a1b2c3...",
    "size": 1048576,
    "mimeType": "application/pdf",
    "createdAt": "2026-04-01T00:00:00.000Z",
    "referenceCount": 2,
    "references": []
  }
]`

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
      <p>
        A version never changes, so responses under <code>.../versions/:n</code> are cached when{' '}
        <code>:n</code> is a semver or hash:{' '}
        <code>public, max-age=600, stale-while-revalidate=60</code> for anonymous readers,{' '}
        <code>private, max-age=3600</code> for signed-in ones. <code>latest</code> moves, so it
        isn&rsquo;t cached. Only <code>200</code>s are cached.
      </p>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="delta-push-open-upload-commit">Delta push (open → upload → commit)</h2>
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
                <code>readme</code>, <code>license</code>, …) and must be an object or{' '}
                <code>null</code>; <code>metadata_patch</code> merges its top-level members into the
                base&rsquo;s. With neither, the metadata is kept.
              </td>
            </tr>
            <tr>
              <td>
                <code>files</code>
              </td>
              <td>
                <code>{'{"add": [hash, …], "remove": [hash, …]}'}</code>: files to declare or drop
                beyond those your records reference. Each hash is bare 64-character lowercase hex.
                Any other string, including one with a <code>sha256:</code> prefix, is ignored
                without an error.
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
          upload. Each records or deletes batch pushes <code>expires_at</code> back; file uploads
          don&rsquo;t.
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
          session&rsquo;s type set. If any line fails, the answer is <code>422</code> and nothing
          from the batch is stored. <code>validationErrors</code> lists the first 100 failing lines,
          each with its 1-based <code>line</code> number; <code>totalErrors</code> is the full
          count.
        </p>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{recordsErr}</code>
        </pre>
        <p>
          A batch with no lines is <code>400</code>. A session that is no longer open is{' '}
          <code>409</code> (<code>"Session is not open"</code>).
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
        <p>
          A line that isn&rsquo;t <code>{'{"type", "id"}'}</code>, or names a type not in the
          session&rsquo;s type set, fails the batch: <code>422</code>, with the first 100 failing
          lines under <code>errors</code> (not <code>validationErrors</code>), and nothing from the
          batch is stored. An empty batch is <code>400</code>; a session that is no longer open is{' '}
          <code>409</code>.
        </p>

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
        <p>
          Build the version. No body is needed; <code>{'{"async": true}'}</code> is the one field
          read.
        </p>
        <h4>
          Response <span className="text-ink-muted font-normal">201</span>
        </h4>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{commitRes}</code>
        </pre>
        <p>
          <code>recordCount</code> here is every record in the version, private ones included: the
          pusher is a member. Reads of the collection and its versions count what the caller may
          see, so a public reader&rsquo;s count leaves private records out.
        </p>
        <p>
          The semver follows from what changed against the base: <strong>major</strong> when a type
          was added or removed or a schema changed, otherwise <strong>minor</strong> when any record
          was added, removed or changed (moving between public and private counts), otherwise{' '}
          <strong>patch</strong> (metadata or files only). A push that changes nothing makes no
          version and answers <code>409</code>.
        </p>
        <p>
          Committing a session that is already committed answers its <code>201</code> result again.
          A session in any other state that isn&rsquo;t open is <code>409</code> (
          <code>"Session is &lt;status&gt;"</code>).
        </p>
        <p>
          With <code>?async=true</code>, <code>?async=1</code> or a body of{' '}
          <code>{'{"async": true}'}</code>, the answer is <code>202</code> and the version is built
          in the background. The commit runs this way without being asked when the session uploaded
          more than 100,000 records, or when a schema change means more than 100,000 of the
          base&rsquo;s records must be revalidated.
        </p>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{asyncCommitRes}</code>
        </pre>
        <p>
          A synchronous commit can also answer <code>202</code>, with{' '}
          <code>{'{"session_id", "status": "committing"}'}</code> and no <code>poll</code>, when the
          server splits a large commit into parallel jobs. Treat both the same way: poll{' '}
          <a href="#get-api-collections-owner-slug-push-sid">
            <code>GET .../push/:sid</code>
          </a>{' '}
          until <code>status</code> is <code>committed</code> (<code>result</code> is the{' '}
          <code>201</code> body) or <code>failed</code> (<code>error</code> is the rejection). The
          version isn&rsquo;t visible to readers until it is committed.
        </p>
        <p>A commit can be refused:</p>
        <ul>
          <li>
            <code>409</code> <code>{'{"error": "Version conflict"}'}</code>: the head moved after
            the session opened. There is no <code>currentVersion</code> here (only the{' '}
            <code>409</code> at open has it); read the head and push again.
          </li>
          <li>
            <code>409</code> <code>"No changes detected"</code>, with the head&rsquo;s{' '}
            <code>hash</code>.
          </li>
          <li>
            <code>422</code> <code>"Missing files"</code>: <code>filesNeeded</code> lists up to 100
            files not uploaded, as <code>sha256:&lt;hex&gt;</code>.
          </li>
          <li>
            <code>422</code> <code>"Schema validation failed"</code>, with{' '}
            <code>validationErrors</code> and <code>totalErrors</code>: a schema change makes
            records of the base invalid.
          </li>
          <li>
            <code>503</code>{' '}
            <code>"Storage cleanup ran while this push was committing. Push again."</code>
          </li>
        </ul>

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
                <code>400</code>
              </td>
              <td>
                A body that isn&rsquo;t a JSON object, <code>metadata</code> that isn&rsquo;t an
                object or <code>null</code>, an empty records or deletes batch, or file bytes that
                don&rsquo;t match their hash.
              </td>
            </tr>
            <tr>
              <td>
                <code>401</code>
              </td>
              <td>You aren&rsquo;t signed in.</td>
            </tr>
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
                the head moved before the commit (no <code>currentVersion</code>), the session
                isn&rsquo;t open, or the push changes nothing (<code>"No changes detected"</code>).
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
                Records that fail (<code>validationErrors</code>), deletes that fail (
                <code>errors</code>), a line whose type isn&rsquo;t in the session&rsquo;s type set,
                a schema that is refused, a commit with files not uploaded (<code>filesNeeded</code>
                ), or a schema change that base records fail (
                <code>"Schema validation failed"</code>).
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
            <tr>
              <td>
                <code>503</code>
              </td>
              <td>Storage cleanup ran while the push was committing. Push again.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="get-api-collections-owner-slug-push-sid">
          GET /api/collections/:owner/:slug/push/:sid
        </h2>
        <p className="scope">Auth: write scope; your own sessions only</p>
        <p>
          A push session&rsquo;s status. Poll it after a commit answers <code>202</code>.
        </p>
        <h3>
          Response <span className="text-ink-muted font-normal">200</span>
        </h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{sessionPollRes}</code>
        </pre>
        <table>
          <tbody>
            <tr>
              <td>
                <code>status</code>
              </td>
              <td>
                <code>open</code> (taking uploads), <code>committing</code>, <code>committed</code>,{' '}
                <code>failed</code>, or <code>expired</code> (abandoned, or idle too long).
              </td>
            </tr>
            <tr>
              <td>
                <code>records_received</code>
              </td>
              <td>Record lines accepted so far, across batches.</td>
            </tr>
            <tr>
              <td>
                <code>finalize_started_at</code>
              </td>
              <td>
                When the commit began, or <code>null</code>.
              </td>
            </tr>
            <tr>
              <td>
                <code>result</code>
              </td>
              <td>
                Once <code>committed</code>, the commit&rsquo;s <code>201</code> body; otherwise{' '}
                <code>null</code>.
              </td>
            </tr>
            <tr>
              <td>
                <code>error</code>
              </td>
              <td>
                Once <code>failed</code>, the rejection body (for example{' '}
                <code>{'{"error": "Version conflict", "statusCode": 409}'}</code>); otherwise{' '}
                <code>null</code>.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="delete-api-collections-owner-slug-push-sid">
          DELETE /api/collections/:owner/:slug/push/:sid
        </h2>
        <p className="scope">Auth: write scope; your own sessions only</p>
        <p>
          Abandon an open session: it becomes <code>expired</code> and stops counting toward{' '}
          <code>open_sessions</code>. The answer is <code>{'{"ok": true}'}</code>. A session that
          isn&rsquo;t open is left as it is.
        </p>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="get-api-collections-owner-slug-versions">
          GET /api/collections/:owner/:slug/versions
        </h2>
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
          <code>recordCount</code>, <code>fileCount</code>, <code>totalBytes</code> and{' '}
          <code>typeCounts</code> count the sets the caller may read: for anyone outside the
          collection&rsquo;s members, public records only. <code>baseSemver</code> is the version
          the push started from (<code>null</code> for the first). <code>pushedBy</code>,{' '}
          <code>pushedByName</code>, <code>pushedBySlug</code> (the pusher&rsquo;s personal account)
          and <code>actorId</code> are for the collection&rsquo;s members only. <code>ark</code> is
          null when the collection&rsquo;s ARK is off.
        </p>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="get-api-collections-owner-slug-versions-latest">
          GET /api/collections/:owner/:slug/versions/latest
        </h2>
        <p className="scope">No auth for public collections</p>
        <p>
          Get the most recent version. Returns the same object as <code>.../versions/:n</code>. Not
          cached.
        </p>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="get-api-collections-owner-slug-versions-n">
          GET /api/collections/:owner/:slug/versions/:n
        </h2>
        <p className="scope">No auth for public collections</p>
        <p>
          Get a specific version by semver (e.g. <code>v1.1.0</code>) or version hash. Returns the
          version object as listed above, plus <code>metadata</code> and the <code>schemas</code> of
          the types the caller may read.
        </p>
        <p>
          With <code>?records=&lt;type&gt;</code> (empty for the first type), it also returns{' '}
          <code>recordsPage</code>, <code>{'{"type", "records", "total"}'}</code>: a page of that
          type&rsquo;s records (<code>offset</code>, <code>limit</code> as on <code>/records</code>)
          and the type&rsquo;s total. <code>schemas</code> then holds only that type&rsquo;s schema;{' '}
          <code>typeCounts</code> still lists every type. The records page uses this to need only
          one call.
        </p>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="get-api-collections-owner-slug-versions-n-records">
          GET /api/collections/:owner/:slug/versions/:n/records
        </h2>
        <p className="scope">No auth for public collections</p>
        <p>
          Get records for a specific version, in (type, id) order: types in slug order (UTF-8 byte
          order), then ids within a type.
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
                Opaque keyset cursor from <code>pagination.nextCursor</code>; it names the (type,
                id) of the last record returned. Ids are unique within a type, so nothing is skipped
                at a page boundary. <code>cursor</code> is an alias. A bare record id is accepted
                only with <code>?type=</code>; without it, the id is ignored and paging starts at
                the beginning.
              </td>
            </tr>
            <tr>
              <td>
                <code>offset</code>
              </td>
              <td>
                Skip this many records. It is a tree seek, O(tree height), and works at any depth.
                Ignored when <code>after</code> is given.
              </td>
            </tr>
          </tbody>
        </table>
        <p className="text-ink-muted">
          Walking a whole collection is bounded by request count, not bytes: 60 rate units a minute
          anonymous, 5,000 signed in, and a page costs 1. Ask for the largest page you can handle: a
          3-million-record collection is 6,000 requests at 500 per page and 1,500 at 2,000 per page.{' '}
          <a href="#get-api-collections-owner-slug-versions-n-records-ndjson">
            <code>records.ndjson</code>
          </a>{' '}
          reads it in one request for 10 units.
        </p>
        <h3>
          Response <span className="text-ink-muted font-normal">200</span>
        </h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{getRecordsRes}</code>
        </pre>
        <p>
          Each record carries its <code>hash</code>. A member&rsquo;s view includes private records,
          marked <code>"private": true</code>; anyone else sees public records only.
        </p>
        <p>
          Use <code>pagination.nextCursor</code> as the <code>after</code> parameter in the next
          request, unchanged — treat it as opaque. When <code>hasMore</code> is false, you&rsquo;ve
          reached the end.
        </p>
        <p className="text-ink-muted">
          <code>pagination.total</code> is the exact count of records in the sets the caller may
          read (public only for non-members), within <code>type</code> if given. The one exception:
          records withheld from serving are counted but skipped.
        </p>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="get-api-collections-owner-slug-versions-n-records-type-id">
          GET /api/collections/:owner/:slug/versions/:n/records/:type/:id
        </h2>
        <p className="scope">No auth for public collections</p>
        <p>
          One record at a version. A member&rsquo;s private record is marked{' '}
          <code>"private": true</code>. A record that doesn&rsquo;t exist, or that the caller may
          not read, is <code>404</code>.
        </p>
        <h3>
          Response <span className="text-ink-muted font-normal">200</span>
        </h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{recordRes}</code>
        </pre>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="get-api-collections-owner-slug-records-type-id-history">
          GET /api/collections/:owner/:slug/records/:type/:id/history
        </h2>
        <p className="scope">No auth for public collections</p>
        <p>
          A record&rsquo;s history: each version where it was <code>added</code>,{' '}
          <code>updated</code> or <code>removed</code>, oldest first. <code>hash</code> is the
          record&rsquo;s hash in that version, <code>null</code> when removed. Only the sets the
          caller may read are consulted, so for a non-member a record made private reads as removed.
          It looks back over the newest 500 versions; <code>truncated</code> is true when there may
          be older ones. A record never seen is <code>404</code>. It costs 5 rate units.
        </p>
        <h3>
          Response <span className="text-ink-muted font-normal">200</span>
        </h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{historyRes}</code>
        </pre>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="get-api-collections-owner-slug-versions-n-records-ndjson">
          GET /api/collections/:owner/:slug/versions/:n/records.ndjson
        </h2>
        <p className="scope">No auth for public collections</p>
        <p>
          Every record in the version, streamed as newline-delimited JSON in a single response. This
          is the bulk read path: one request, costing 10 rate units, against 1,500 pages for a
          3-million-record collection. The server streams from the version&rsquo;s record trees as
          it reads them, so memory stays constant on both ends and you can process the first line
          before the last is sent.
        </p>
        <p>
          Lines come in the same order as <code>/records</code>: types in slug order, then ids. A
          member gets private records too, with no marker on the line; anyone else gets public
          records only.
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
                With <code>type</code> only: emit records with ids strictly after this one. Without{' '}
                <code>type</code> it is ignored.
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
          <code>hash</code> is the same content address <code>/records</code> serves.
        </p>
        <p>
          <strong>Check completeness yourself.</strong> A stream that fails partway cannot report
          it: the <code>200</code> and headers were sent before anything went wrong.{' '}
          <code>X-Underlay-Record-Count</code> tells you how many lines to expect: the count for{' '}
          <em>this</em> request, for the sets you may read and within <code>?type=</code> if you
          passed one. It can exceed the lines sent only by records withheld from serving.
          (Don&rsquo;t compare against the version&rsquo;s <code>recordCount</code>: it covers every
          type.)
        </p>
        <p>
          If you receive fewer, resume rather than start over: request{' '}
          <code>?type=&lt;last type&gt;&amp;after=&lt;last id&gt;</code>, using the last complete
          line you parsed, then each remaining type with <code>?type=</code>.
        </p>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="get-api-collections-owner-slug-versions-n-records-ndjson-gz">
          GET /api/collections/:owner/:slug/versions/:n/records.ndjson.gz
        </h2>
        <p className="scope">No auth for public collections</p>
        <p>
          Public records as a gzip file (<code>Content-Type: application/gzip</code>, sent as an
          attachment). With <code>?type=</code>, one type&rsquo;s; without it, every type&rsquo;s in
          slug order. The server sends the records as stored, so the file is several gzip members
          concatenated. Most gzip readers handle that; some, such as browsers&rsquo;{' '}
          <code>DecompressionStream</code>, stop after the first member.
        </p>
        <p>
          Lines are canonical records, <code>{'{"id", "type", "data"}'}</code>, without{' '}
          <code>hash</code> (it is the SHA-256 of the line). Private records are never included,
          even for members: use <code>records.ndjson</code> for those. A <code>type</code> with no
          public records is <code>404</code>. It costs 10 rate units.
        </p>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="get-api-collections-owner-slug-versions-n-manifest">
          GET /api/collections/:owner/:slug/versions/:n/manifest
        </h2>
        <p className="scope">No auth for public collections</p>
        <p>
          Get the manifest: every record&rsquo;s id, type and content hash, without the bodies, in
          (type, id) order. Members also see private records, marked <code>"private": true</code>.
          This is the cheapest way to learn what a version contains — at roughly 120 bytes per
          entry, a million records is one order of magnitude smaller than fetching them — and what a
          client that keeps no copy diffs against before it pushes.
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
                that; later pages have <code>files: []</code>.
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
                A semver or <code>ulv2:</code> version hash. Return a delta against that version
                instead of the full manifest: which records were added, updated and removed between
                the two.
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
          A delta is one walk over both versions in (type, id) order, with a single cursor;{' '}
          <code>limit</code> counts entries across the three lists. Keep re-requesting with{' '}
          <code>cursor=pagination.nextCursor</code> until <code>hasMore</code> is false.
        </p>
        <p>
          Delta entries carry no <code>private</code> flag, and for a member a record that only
          moved between public and private isn&rsquo;t listed. Read the full manifest to see privacy
          changes. <code>files</code> in a delta is the full file list of <code>:n</code> that the
          caller may read (first page only), not a file delta.
        </p>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="get-api-collections-owner-slug-versions-n-diff">
          GET /api/collections/:owner/:slug/versions/:n/diff
        </h2>
        <p className="scope">No auth for public collections</p>
        <p>
          Diff two versions, with full record bodies. Always pass <code>from</code>: without it the
          diff is against an empty version, so every record is <code>added</code>, <code>from</code>{' '}
          is <code>null</code> and <code>schemaChanged</code> is true. It costs 5 rate units.
        </p>
        <h3>Query parameters</h3>
        <table>
          <tbody>
            <tr>
              <td>
                <code>from</code>
              </td>
              <td>
                Semver or version hash to diff from (e.g. <code>v1.0.0</code>). Default: an empty
                version.
              </td>
            </tr>
            <tr>
              <td>
                <code>limit</code>
              </td>
              <td>Entries per page, across the three lists (default 500, max 5000)</td>
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
        <p>
          <code>removed</code> is bare ids, without their type. <code>filesAdded</code> and{' '}
          <code>filesRemoved</code> are computed on the first page only; later pages report 0.
        </p>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="get-api-collections-owner-slug-versions-n-files">
          GET /api/collections/:owner/:slug/versions/:n/files
        </h2>
        <p className="scope">No auth for public collections</p>
        <p>
          The files of the version that the caller may read, sorted by hash, at most 10,000.{' '}
          <code>referenceCount</code> is how many records in those sets reference the file.{' '}
          <code>references</code> is always empty: which records reference a file isn&rsquo;t
          indexed.
        </p>
        <h3>
          Response <span className="text-ink-muted font-normal">200</span>
        </h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{filesRes}</code>
        </pre>
      </div>
    </DocsLayout>
  )
}
