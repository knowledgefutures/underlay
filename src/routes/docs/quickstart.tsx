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

const negotiateCode = `# Step 1: Hash your records and negotiate with the server
# Record hash = SHA-256 of canonical JSON: {"id","type","data"} with keys sorted recursively
# For this example we'll use pre-computed hashes.

curl -X POST https://underlay.org/api/collections/yourname/my-dataset/versions/negotiate \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $KEY" \\
  -d '{
    "base_version": null,
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
    },
    "manifest": [
      {"id": "book-1", "type": "Book", "hash": "a1b2c3..."},
      {"id": "book-2", "type": "Book", "hash": "d4e5f6..."}
    ]
  }'
# → {"session_id":"abc123","needed_records":["a1b2c3...","d4e5f6..."],...}`

const sendRecordsCode = `# Step 2: Send the records the server needs (as JSONL)
curl -X POST https://underlay.org/api/collections/yourname/my-dataset/versions/negotiate/SESSION_ID/records \\
  -H "Content-Type: application/x-ndjson" \\
  -H "Authorization: Bearer $KEY" \\
  --data-binary @- << 'EOF'
{"id":"book-1","type":"Book","data":{"author":"Douglas Hofstadter","title":"Gödel, Escher, Bach","year":1979}}
{"id":"book-2","type":"Book","data":{"author":"Thomas Kuhn","title":"The Structure of Scientific Revolutions","year":1962}}
EOF
# → {"received":2,"remaining":0}`

const commitCode = `# Step 3: Commit the version
curl -X POST https://underlay.org/api/collections/yourname/my-dataset/versions/negotiate/SESSION_ID/commit \\
  -H "Authorization: Bearer $KEY"
# → {"semver":"v1.0.0","hash":"...","recordCount":2,"fileCount":0}`

const readCode = `# Get collection info
curl https://underlay.org/api/collections/yourname/my-dataset

# Get latest version records
curl https://underlay.org/api/collections/yourname/my-dataset/versions/v1.0.0/records

# Get the manifest (list of record hashes)
curl https://underlay.org/api/collections/yourname/my-dataset/versions/v1.0.0/manifest`

const updateCode = `# To push an update, negotiate again with base_version set.
# The server already has book-1 and book-2, so needed_records
# will only include the new/changed records.

curl -X POST https://underlay.org/api/collections/yourname/my-dataset/versions/negotiate \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $KEY" \\
  -d '{
    "base_version": "v1.0.0",
    "message": "Add third book",
    "manifest": [
      {"id": "book-1", "type": "Book", "hash": "a1b2c3..."},
      {"id": "book-2", "type": "Book", "hash": "d4e5f6..."},
      {"id": "book-3", "type": "Book", "hash": "g7h8i9..."}
    ]
  }'
# → {"session_id":"xyz789","needed_records":["g7h8i9..."],...}

# Send only the new record, then commit
curl -X POST .../negotiate/SESSION_ID/records \\
  -H "Content-Type: application/x-ndjson" \\
  -H "Authorization: Bearer $KEY" \\
  --data-binary '{"id":"book-3","type":"Book","data":{"author":"Ludwig Wittgenstein","title":"Philosophical Investigations","year":1953}}'

curl -X POST .../negotiate/SESSION_ID/commit -H "Authorization: Bearer $KEY"
# → {"semver":"v1.1.0","hash":"...","recordCount":3,"fileCount":0}`

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
# {"id": "book-1", "type": "Book", "data": {"title": "...", "pdf": {"$file": "sha256:..."}}}`

const hashingNote = `# Record hashing: SHA-256 of canonical JSON
# 1. Build object: {id, type, data}
# 2. Sort all keys recursively (including nested objects in data)
# 3. JSON.stringify the sorted object
# 4. SHA-256 hex digest

# Example in Node.js:
import { createHash } from 'node:crypto'

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
  const json = JSON.stringify(obj)
  return createHash('sha256').update(json).digest('hex')
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
          write the push script, and handle hashing and negotiation for you. The steps below explain
          the same flow manually.
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
        Pushes use a three-step{' '}
        <Link to="/protocol" className="text-link hover:underline">
          negotiate protocol
        </Link>
        : send a manifest of record hashes, upload only the records the server needs, then commit.
      </p>

      <h3>3a. Negotiate</h3>
      <p>
        Hash each record and send the manifest. The server tells you which records it already has.
      </p>
      <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
        <code>{negotiateCode}</code>
      </pre>

      <h3>3b. Send records</h3>
      <p>
        Send the needed records as JSONL (one JSON object per line). For large datasets, send in
        batches of up to 10,000 records per request. Skip this step if <code>needed_records</code>{' '}
        is empty.
      </p>
      <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
        <code>{sendRecordsCode}</code>
      </pre>

      <h3>3c. Commit</h3>
      <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
        <code>{commitCode}</code>
      </pre>

      <h2>4. Read it back</h2>
      <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
        <code>{readCode}</code>
      </pre>

      <h2>5. Push an update</h2>
      <p>
        On subsequent pushes, set <code>base_version</code> to the current latest. The server
        deduplicates, so only new or changed records need to be sent.
      </p>
      <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
        <code>{updateCode}</code>
      </pre>

      <h2>6. Diff versions</h2>
      <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
        <code>{diffCode}</code>
      </pre>

      <h2>Record hashing</h2>
      <p>
        Each record must be hashed client-side before negotiating. The hash is the SHA-256 of{' '}
        <code>{'JSON.stringify({id, type, data})'}</code> with all object keys sorted recursively.
        This ensures any client produces the same hash for the same data regardless of key insertion
        order.
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
          <Link to="/protocol">Protocol spec</Link>: precise hashing algorithm and negotiate flow
        </li>
      </ul>
    </DocsLayout>
  )
}
