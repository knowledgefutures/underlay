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
# -> { "session_id": "...", "base": "v1.2.0", "needed_files": ["9f86d0..."], "expires_at": "..." }

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

const negotiate = `POST /api/collections/:owner/:slug/versions/negotiate
{ "base_version": "v1.2.0", "schemas": {...}, "manifest": [{ "id", "type", "hash", "private"? }, ...] }
# -> { "session_id", "needed_records": [...], "needed_files": [...] }

POST .../versions/negotiate/:sid/manifest     # manifests over 50,000 entries, in chunks
POST .../versions/negotiate/:sid/records      # the needed records, NDJSON
POST .../versions/negotiate/:sid/commit       # ?async=true; polled with GET .../negotiate/:sid`

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
        These are the HTTP exchanges for writing and reading versions on an Underlay server. The{' '}
        <Link to="/docs/api/versions">Versions API</Link> lists every endpoint with its options.
      </p>

      <h2 id="delta-push">Delta push</h2>
      <p>
        A client that knows which version it started from sends only its changes: upserted records
        with their set, and deletes. The commit costs in proportion to the changes, at any
        collection size, and the server builds the trees.
      </p>
      <CodeBlock>{delta}</CodeBlock>
      <ul>
        <li>
          <code>base</code> must be the current latest version, or the push gets a <code>409</code>{' '}
          with the current one; pull and push again.
        </li>
        <li>
          Record batches are at most 10,000 lines and 16 MiB. Each line goes through the{' '}
          <Link to="/docs/protocol/records#input-rules">input rules</Link> and schema validation as
          it arrives, so errors come back with the batch.
        </li>
        <li>
          Upload <code>needed_files</code> before committing (<code>PUT …/files/:hash</code> up to
          32 MB, or a presigned upload). A commit whose records reference a file the collection
          doesn&rsquo;t hold gets a <code>422</code> listing them.
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
        Commit asynchronously when the push is large; commits over 100,000 records always are.
        Nothing is published until the commit finishes.
      </p>
      <CodeBlock>{asyncCommit}</CodeBlock>

      <h2 id="negotiate-compatibility">Negotiate (compatibility)</h2>
      <p>
        v1 clients push a <strong>snapshot</strong>: the manifest of every record&rsquo;s hash, then
        the records the server asks for. v2 keeps that API, with the same paths and shapes, for
        existing integrations.
      </p>
      <CodeBlock>{negotiate}</CodeBlock>
      <p>
        A snapshot costs work in proportion to the whole collection, and snapshots over 10 million
        records are refused with a pointer to delta push. Prefer delta push for new clients.
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

      <h2 id="v1-hashes">v1 hashes</h2>
      <p>
        v1 canonicalized by sorting keys into a new object and calling <code>JSON.stringify</code>,
        which puts array-index keys (<code>&quot;0&quot;</code>, <code>&quot;12&quot;</code>) first.
        The two versions give the same record and schema hashes unless an object at some depth has
        such a key.
      </p>
      <ul>
        <li>Servers keep v1 → v2 aliases, and the negotiate API accepts v1 record hashes.</li>
        <li>
          v1 version hashes (<code>private:&lt;hex&gt;</code>, <code>public:&lt;hex&gt;</code>)
          still resolve to the versions they named.
        </li>
        <li>
          v1&rsquo;s field-level privacy is gone: a migrated type with private fields became a
          wholly private type.
        </li>
      </ul>

      <h2 id="errors">Errors</h2>
      <p>
        Errors are JSON with an <code>error</code> field. Content the caller may not see is a{' '}
        <code>404</code>, never a <code>403</code>, so a response can&rsquo;t confirm it exists. The{' '}
        <Link to="/docs/api">API overview</Link> lists the status codes.
      </p>
    </DocsLayout>
  )
}
