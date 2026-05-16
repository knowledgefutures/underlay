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
    "description": "A test collection",
    "public": true
  }'`

const pushCode = `curl -X POST https://underlay.org/api/collections/yourname/my-dataset/versions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $KEY" \\
  -d '{
    "base_version": null,
    "message": "Initial import",
    "app_id": "my-app",
    "schema": {
      "type": "object",
      "properties": {
        "Book": {
          "type": "object",
          "properties": {
            "title": {"type": "string"},
            "author": {"type": "string"},
            "year": {"type": "integer"}
          }
        }
      }
    },
    "changes": {
      "added": [
        {"id": "book-1", "type": "Book", "data": {"title": "Gödel, Escher, Bach", "author": "Douglas Hofstadter", "year": 1979}},
        {"id": "book-2", "type": "Book", "data": {"title": "The Structure of Scientific Revolutions", "author": "Thomas Kuhn", "year": 1962}}
      ]
    }
  }'
# → {"version":1,"semver":"v1.0.0","hash":"...","recordCount":2,"fileCount":0}`

const readCode = `# Get collection info
curl https://underlay.org/api/collections/yourname/my-dataset

# Get version 1 records
curl https://underlay.org/api/collections/yourname/my-dataset/versions/1/records

# Get the manifest
curl https://underlay.org/api/collections/yourname/my-dataset/versions/1/manifest`

const updateCode = `curl -X POST https://underlay.org/api/collections/yourname/my-dataset/versions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $KEY" \\
  -d '{
    "base_version": 1,
    "message": "Add third book, fix year",
    "changes": {
      "added": [
        {"id": "book-3", "type": "Book", "data": {"title": "Philosophical Investigations", "author": "Ludwig Wittgenstein", "year": 1953}}
      ],
      "updated": [
        {"id": "book-1", "type": "Book", "data": {"title": "Gödel, Escher, Bach", "author": "Douglas Hofstadter", "year": 1979}}
      ]
    }
  }'
# → {"version":2,"semver":"v1.1.0","hash":"...","recordCount":3,"fileCount":0}`

const diffCode = `curl https://underlay.org/api/collections/yourname/my-dataset/versions/2/diff?from=1
# → {"from":1,"to":2,"added":[...],"updated":[...],"removed":[]}`

const filesCode = `# Compute hash
HASH=$(shasum -a 256 paper.pdf | cut -d' ' -f1)

# Upload
curl -X PUT "https://underlay.org/api/collections/yourname/my-dataset/files/sha256:$HASH" \\
  -H "Authorization: Bearer $KEY" \\
  -H "Content-Type: application/pdf" \\
  --data-binary @paper.pdf

# Reference in a record
# {"id": "book-1", "type": "Book", "data": {"title": "...", "pdf": {"$file": "sha256:..."}}}`

export default function DocsQuickstart() {
  return (
    <DocsLayout title="Quickstart">
      <p>
        Push your first version in 5 minutes. All you need is <code>curl</code> and a running
        Underlay instance.
      </p>

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
      <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
        <code>{loginNote}</code>
      </pre>
      <p>
        Save the <code>key</code> value — it's shown only once.
      </p>

      <h2>2. Create a collection</h2>
      <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
        <code>{createCollectionCode}</code>
      </pre>

      <h2>3. Push a version</h2>
      <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
        <code>{pushCode}</code>
      </pre>

      <h2>4. Read it back</h2>
      <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
        <code>{readCode}</code>
      </pre>

      <h2>5. Push an update</h2>
      <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
        <code>{updateCode}</code>
      </pre>

      <h2>6. Diff versions</h2>
      <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
        <code>{diffCode}</code>
      </pre>

      <h2>Working with files</h2>
      <p>To attach files (PDFs, images, etc.) to records, upload them first by hash:</p>
      <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
        <code>{filesCode}</code>
      </pre>

      <h2>Next steps</h2>
      <ul>
        <li>
          <Link to="/docs/concepts">Core concepts</Link> — understand the data model
        </li>
        <li>
          <Link to="/docs/api/versions">Versions API</Link> — full reference for push/pull
        </li>
        <li>
          <Link to="/docs/api/files">Files API</Link> — content-addressed file storage
        </li>
      </ul>
    </DocsLayout>
  )
}
