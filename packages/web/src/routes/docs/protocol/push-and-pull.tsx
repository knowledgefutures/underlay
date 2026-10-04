import { Link } from 'react-router'

import DocsLayout, { CodeBlock } from '~/components/DocsLayout'

const delta = `# 1. Open a session against the version you started from (null for the first)
POST /api/collections/:owner/:slug/push
{
  "base": "v1.2.0",
  "schemas": { "Publication": { ... } },      // the full type set; omit to keep the base's
  "metadata_patch": { "readme": "# ..." },    // or "metadata": {...} to replace it
  "files": { "add": ["9f86d0..."] },          // hex hashes the new records reference
  "message": "Weekly update"
}
# -> { "session_id": "...", "base": "v1.2.0", "needed_files": ["9f86d0..."], "expires_at": "...",
#      "limits": { "batch_bytes": 16777216, "batch_lines": 10000, ... } }

PUT /api/collections/:owner/:slug/files/9f86d0...           # each needed file's bytes

# 2. Upload what changed: upserts, then deletes (NDJSON, repeatable)
POST /api/collections/:owner/:slug/push/:sid/records
{"id":"pub-004","type":"Publication","data":{"title":"..."}}
{"id":"pub-005","type":"Publication","data":{"title":"..."},"private":true}
# -> { "received": 2 }

POST /api/collections/:owner/:slug/push/:sid/deletes
{"type":"Publication","id":"pub-003"}

# 3. Commit
POST /api/collections/:owner/:slug/push/:sid/commit
# -> 201 { "semver": "v1.3.0", "hash": "ulv2:...", "recordCount": 4, "fileCount": 1, "changes": {...} }`

const asyncCommit = `POST /api/collections/:owner/:slug/push/:sid/commit?async=true
# -> 202 { "session_id": "...", "status": "committing" }

GET /api/collections/:owner/:slug/push/:sid
# -> { "status": "committed", "result": { "semver": "v1.3.0", "hash": "ulv2:...", ... } }`

const noCopy = `# 1. The latest version's records, without bodies (paged: repeat with ?cursor=nextCursor)
GET /api/collections/:owner/:slug/versions/latest/manifest
# -> { "semver": "v1.2.0", "records": [{ "id": "pub-001", "type": "Publication", "hash": "...",
#      "private"?: true }, ...], "pagination": { "hasMore": false, "nextCursor": null } }

# 2. Locally: hash each current record, and compare by (type, id), hash and privacy
#    new, changed or moving between sets  -> upsert
#    in the manifest, gone from your data -> delete

# 3. Delta push against that version
POST /api/collections/:owner/:slug/push   { "base": "v1.2.0", ... }`

const pull = `# The log, with the signing keys, after the last entry you have
GET /api/collections/:owner/:slug/log?after=<seq>

# A pack of what version :n has that your base doesn't (sets=all needs membership)
GET /api/collections/:owner/:slug/versions/:n/pack?base=<n>&sets=public

# Or read through the API
GET /api/collections/:owner/:slug/versions/:n/records.ndjson.gz   # the whole version
GET /api/collections/:owner/:slug/versions/:n/manifest?since=<n>  # what changed
GET /api/collections/:owner/:slug/versions/:n/diff?from=<n>
GET /api/records/:hash/provenance                                 # every version holding a record`

export default function ProtocolPushPull() {
  return (
    <DocsLayout title="Push and pull" eyebrow="Protocol v2">
      <p>
        Every Underlay node accepts pushes and serves pulls the same way, so a client written
        against one works against any other. The <Link to="/docs/api/versions">Versions API</Link>{' '}
        lists every endpoint with its options.
      </p>

      <h2 id="delta-push">Delta push</h2>
      <p>
        Delta push is the one way to publish. A client names the version it started from and sends
        only its changes: upserted records with their set, and deletes. The commit costs in
        proportion to the changes, at any collection size. The node builds the trees, signs the log
        entry and numbers the version by the{' '}
        <Link to="/docs/protocol/versions#semver">semver rules</Link>.
      </p>
      <CodeBlock>{delta}</CodeBlock>
      <ul>
        <li>
          <code>base</code> must be the current latest version, or the push gets a <code>409</code>{' '}
          with the current one; pull and push again.
        </li>
        <li>
          <code>limits</code> in the answer are the node&rsquo;s own: the largest batch in bytes and
          lines, the session idle timeout, sessions per user and the largest direct file upload.
          Size batches by them; going over is a <code>413</code>.
        </li>
        <li>
          Each record line goes through the{' '}
          <Link to="/docs/protocol/records#input-rules">input rules</Link> and schema validation as
          it arrives. A batch with any failing line gets a <code>422</code> listing them by line
          number, and none of it is kept. Fields the schema&rsquo;s <code>properties</code>{' '}
          don&rsquo;t list are refused unless the session sets <code>strip_unknown_fields</code>.
        </li>
        <li>Within a session, the later upload of a (type, id) wins, record or delete.</li>
        <li>
          Upload <code>needed_files</code> before committing. A commit whose records reference a
          file the collection doesn&rsquo;t hold gets a <code>422</code> listing them.
        </li>
        <li>
          A commit that changes nothing gets a <code>409</code> (&ldquo;No changes detected&rdquo;)
          and makes no version.
        </li>
        <li>
          Sessions expire when idle; every batch extends them. <code>DELETE …/push/:sid</code>{' '}
          abandons one.
        </li>
      </ul>

      <h3>Long commits</h3>
      <p>
        Commit asynchronously when the push is large; a node may also choose to (underlay.org does
        for every commit over 100,000 records). Poll the session until it is <code>committed</code>{' '}
        or <code>failed</code>. Nothing is published until the commit finishes.
      </p>
      <CodeBlock>{asyncCommit}</CodeBlock>

      <h2 id="clients-without-a-copy">Clients without a copy</h2>
      <p>
        An integration that exports its whole dataset each time, rather than keeping a copy of what
        it pushed, works out its changes from the latest version&rsquo;s manifest. The upload is
        then only what changed, whatever the collection&rsquo;s size.
      </p>
      <CodeBlock>{noCopy}</CodeBlock>
      <p>
        Hashes are computed as in{' '}
        <Link to="/docs/protocol/records#records">Records and schemas</Link>;{' '}
        <code>hashRecord</code> in <code>@underlay/protocol</code> does it. If another push lands in
        between, the push gets a <code>409</code>: read the manifest again and redo the diff.
      </p>

      <h2 id="pull">Pull</h2>
      <p>
        A client that keeps a copy verifies the signed log, then fetches a pack against the version
        it last synced and checks it as described in{' '}
        <Link to="/docs/protocol/repositories#sync">Sync</Link>. The log, pack and file reads are
        the ones every node serves (
        <Link to="/docs/protocol/repositories#serving-over-http">Serving over HTTP</Link>); the
        others are this server&rsquo;s. Readers that want records rather than trees use the read
        endpoints.
      </p>
      <CodeBlock>{pull}</CodeBlock>
      <p>
        <code>records.ndjson.gz</code> is the version&rsquo;s stored bodies concatenated: a reader
        can hash each line and check it against the version&rsquo;s trees. Public readers see the
        public set only; private types and records are absent from every read.
      </p>

      <h2 id="errors">Errors</h2>
      <p>
        Errors are JSON with an <code>error</code> field. Content the caller may not see is a{' '}
        <code>404</code>, never a <code>403</code>, so a response can&rsquo;t confirm it exists. The
        statuses that mean something specific:
      </p>
      <ul>
        <li>
          <code>403</code>: the caller can read the collection but not write to it, or asked for{' '}
          <code>sets=all</code> without access to the private set.
        </li>
        <li>
          <code>409</code>: <code>base</code> isn&rsquo;t the latest version, the latest moved
          before the commit, the session isn&rsquo;t open, or the push changes nothing.
        </li>
        <li>
          <code>413</code>: over one of the node&rsquo;s <code>limits</code>.
        </li>
        <li>
          <code>422</code>: records, deletes or a schema that fail validation, or files the commit
          needs and the node doesn&rsquo;t hold.
        </li>
        <li>
          <code>429</code>: too many sessions in progress, or a rate limit (with{' '}
          <code>Retry-After</code>).
        </li>
      </ul>
    </DocsLayout>
  )
}
