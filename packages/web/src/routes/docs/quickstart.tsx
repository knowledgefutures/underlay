import { Link } from 'react-router'

import DocsLayout from '~/components/DocsLayout'

const loginNote = `# Sign in via KF Auth SSO at https://underlay.org/login
# Your account is created automatically on first sign-in.
# Then create an API key at https://underlay.org/settings/keys`

const createCollectionCode = `export KEY="ul_abc123..."

curl -X POST https://underlay.org/api/accounts/yourname/collections \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $KEY" \\
  -d '{
    "slug": "my-dataset",
    "name": "My Dataset",
    "public": true
  }'`

const openCode = `# Open a push session. base is null for the first version.
curl -X POST https://underlay.org/api/collections/yourname/my-dataset/push \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $KEY" \\
  -d '{
    "base": null,
    "message": "Initial import",
    "app_id": "my-app",
    "metadata": {
      "description": "A curated book list",
      "readme": "# My Dataset\\nA collection of notable books."
    },
    "schemas": {
      "Book": {
        "type": "object",
        "properties": {
          "title": {"type": "string"},
          "author": {"type": "string"},
          "year": {"type": "integer"}
        }
      }
    }
  }'
# → {"session_id":"SESSION_ID","base":null,"needed_files":[],"expires_at":"...","limits":{...}}`

const sendRecordsCode = `# Upload records as NDJSON, one per line
curl -X POST https://underlay.org/api/collections/yourname/my-dataset/push/SESSION_ID/records \\
  -H "Content-Type: application/x-ndjson" \\
  -H "Authorization: Bearer $KEY" \\
  --data-binary @- << 'EOF'
{"id":"book-1","type":"Book","data":{"author":"Douglas Hofstadter","title":"Gödel, Escher, Bach","year":1979}}
{"id":"book-2","type":"Book","data":{"author":"Thomas Kuhn","title":"The Structure of Scientific Revolutions","year":1962}}
EOF
# → {"received":2}`

const commitCode = `curl -X POST https://underlay.org/api/collections/yourname/my-dataset/push/SESSION_ID/commit \\
  -H "Authorization: Bearer $KEY"
# → {"semver":"v1.0.0","hash":"ulv2:...","recordCount":2,"fileCount":0,"changes":{...}}`

const readCode = `# Get collection info
curl https://underlay.org/api/collections/yourname/my-dataset

# Get latest version records
curl https://underlay.org/api/collections/yourname/my-dataset/versions/v1.0.0/records

# Get the manifest (list of record hashes)
curl https://underlay.org/api/collections/yourname/my-dataset/versions/v1.0.0/manifest`

const updateCode = `# Open a session against the current version. Schemas and metadata
# you leave out are kept.
curl -X POST https://underlay.org/api/collections/yourname/my-dataset/push \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $KEY" \\
  -d '{"base": "v1.0.0", "message": "Add a book, drop another"}'
# → {"session_id":"SESSION_ID","base":"v1.0.0",...}

# Upload the new or changed records
curl -X POST .../push/SESSION_ID/records \\
  -H "Content-Type: application/x-ndjson" \\
  -H "Authorization: Bearer $KEY" \\
  --data-binary '{"id":"book-3","type":"Book","data":{"author":"Ludwig Wittgenstein","title":"Philosophical Investigations","year":1953}}'

# Delete records by type and id
curl -X POST .../push/SESSION_ID/deletes \\
  -H "Content-Type: application/x-ndjson" \\
  -H "Authorization: Bearer $KEY" \\
  --data-binary '{"type":"Book","id":"book-2"}'

curl -X POST .../push/SESSION_ID/commit -H "Authorization: Bearer $KEY"
# → {"semver":"v1.1.0","hash":"ulv2:...","recordCount":2,"fileCount":0,"changes":{...}}`

const diffCode = `curl https://underlay.org/api/collections/yourname/my-dataset/versions/v1.1.0/diff?from=v1.0.0
# → {"from":"v1.0.0","to":"v1.1.0","added":[...],"updated":[...],"removed":[]}`

const filesCode = `# Compute hash
HASH=$(shasum -a 256 paper.pdf | cut -d' ' -f1)

# Upload
curl -X PUT "https://underlay.org/api/collections/yourname/my-dataset/files/sha256:$HASH" \\
  -H "Authorization: Bearer $KEY" \\
  -H "Content-Type: application/pdf" \\
  --data-binary @paper.pdf

# Reference in a record
# {"id": "book-1", "type": "Book", "data": {"title": "...", "pdf": {"$file": "sha256:..."}}}
# A commit whose records reference a file the server doesn't hold is refused (422, filesNeeded).`

const hashingNote = `# Record hashing: SHA-256 of the canonical form
#   '{"id":' + JSON(id) + ',"type":' + JSON(type) + ',"data":' + JCS(data) + '}'
# JCS is RFC 8785 canonical JSON: no whitespace, object keys sorted.

# Example in Node.js:
import { createHash } from 'node:crypto'

// Written out as a string: a sorted object passed to JSON.stringify
// would put integer-like keys ("9", "10") first.
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

export default function DocsQuickstart() {
  return (
    <DocsLayout title="Quickstart">
      <p>
        Push your first version in 5 minutes. All you need is <code>curl</code> and a running
        Underlay instance.
      </p>

      <div className="border-rule bg-parchment-dark/30 rounded-surface mb-6 border p-4">
        <p className="mt-0 mb-2 text-sm font-semibold">Fastest path: use an AI agent</p>
        <p className="text-ink-muted mb-0 text-sm">
          Point your coding agent at{' '}
          <a href="/llms.txt" className="text-link underline">
            llms.txt
          </a>{' '}
          and tell it what data you want to push. It has everything it needs to create a collection,
          write the push script, and batch the uploads for you. The steps below explain the same
          flow manually.
        </p>
      </div>

      <h2>1. Sign in and create an API key</h2>
      <p>
        Sign in at{' '}
        <a href="https://underlay.org/login" className="text-link hover:underline">
          underlay.org/login
        </a>{' '}
        via KF Auth SSO. Your account is created automatically on first sign-in. Then go to{' '}
        <Link to="/settings/keys" className="text-link hover:underline">
          Settings → API Keys
        </Link>{' '}
        and create a write-scoped key.
      </p>
      <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
        <code>{loginNote}</code>
      </pre>
      <p>
        Save the <code>key</code> value. It's shown only once.
      </p>

      <h2>2. Create a collection</h2>
      <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
        <code>{createCollectionCode}</code>
      </pre>

      <h2>3. Push a version</h2>
      <p>
        A push is a{' '}
        <Link to="/docs/protocol/push-and-pull#delta-push" className="text-link hover:underline">
          delta push
        </Link>
        : open a session against a base version, upload the records that are new or changed and the
        ids to delete, then commit. The server builds the version and numbers it.
      </p>

      <h3>3a. Open a session</h3>
      <p>
        Send the schemas and metadata. The response includes the server&rsquo;s <code>limits</code>,
        such as how many lines and bytes one upload may hold.
      </p>
      <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
        <code>{openCode}</code>
      </pre>

      <h3>3b. Upload records</h3>
      <p>
        Send records as NDJSON (one JSON object per line). For large datasets, split them into
        batches within <code>limits.batch_lines</code> (10,000 on underlay.org) and{' '}
        <code>limits.batch_bytes</code>. Add <code>"private": true</code> to a line to keep that
        record out of public view.
      </p>
      <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
        <code>{sendRecordsCode}</code>
      </pre>

      <h3>3c. Commit</h3>
      <p>
        Large commits answer <code>202</code>; poll <code>GET .../push/SESSION_ID</code> until its{' '}
        <code>status</code> is <code>committed</code> or <code>failed</code>.
      </p>
      <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
        <code>{commitCode}</code>
      </pre>

      <h2>4. Read it back</h2>
      <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
        <code>{readCode}</code>
      </pre>

      <h2>5. Push an update</h2>
      <p>
        Set <code>base</code> to the current version and send only what changed. If someone else
        pushed in the meantime, opening the session answers <code>409</code> with{' '}
        <code>currentVersion</code>.
      </p>
      <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
        <code>{updateCode}</code>
      </pre>
      <p>
        If your app exports its whole dataset each time rather than tracking changes, read the
        current version&rsquo;s manifest and diff against it first. See{' '}
        <Link
          to="/docs/protocol/push-and-pull#clients-without-a-copy"
          className="text-link hover:underline"
        >
          clients without a copy
        </Link>
        .
      </p>

      <h2>6. Diff versions</h2>
      <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
        <code>{diffCode}</code>
      </pre>

      <h2>Record hashing</h2>
      <p>
        You don&rsquo;t need to hash records to push them: the server hashes what you upload. You
        need the hash to compare your data with a version&rsquo;s manifest. It is the SHA-256 of a
        fixed <code>{'{id, type, data}'}</code> envelope with <code>data</code> in canonical JSON
        (RFC 8785), so any client produces the same hash for the same data regardless of key
        insertion order. In JavaScript, <code>hashRecord</code> from <code>@underlay/protocol</code>{' '}
        does this.
      </p>
      <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
        <code>{hashingNote}</code>
      </pre>

      <h2>Working with files</h2>
      <p>To attach files (PDFs, images, etc.) to records, upload them first by hash:</p>
      <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
        <code>{filesCode}</code>
      </pre>

      <h2>Next steps</h2>
      <ul>
        <li>
          <Link to="/docs/concepts">Core concepts</Link>: understand the data model
        </li>
        <li>
          <Link to="/docs/integration">Integration guide</Link>: full push protocol, SQL mapping,
          privacy controls
        </li>
        <li>
          <Link to="/docs/protocol">Protocol</Link>: hashing, trees, versions, and the push and pull
          exchanges
        </li>
      </ul>
    </DocsLayout>
  )
}
