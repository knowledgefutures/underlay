import { Link } from 'react-router'

import BaseLayout from '~/components/BaseLayout'

const recordExample = `{"id":"pub-001","type":"Publication","data":{"title":"The Structure of Scientific Revolutions","doi":"10.1234/example"}}`

const hashExample = `canonical = JSON.stringify({ id: "pub-001", type: "Publication", data: { ... } })
hash = SHA256(canonical)  // hex-encoded`

const versionHashExample = `canonical = JSON.stringify({
  schemas: { "Publication": "abc123...", "Author": "def456..." },  // sorted by slug
  records: ["0a1b2c...", "3d4e5f...", ...],                        // sorted, hex SHA-256
  files: ["7a8b9c...", ...],                                       // sorted, hex SHA-256
  readme: "# My Collection\\n..."                                   // or null
})
hash = "private:" + SHA256(canonical)`

const negotiateExample = `# 1. Client sends manifest
POST /api/collections/:owner/:slug/versions/negotiate
{
  "base_version": 3,
  "schemas": { "Publication": { ... } },
  "manifest": [
    { "id": "pub-001", "type": "Publication", "hash": "abc123..." },
    { "id": "pub-002", "type": "Publication", "hash": "def456..." }
  ],
  "files": ["7a8b9c..."],
  "message": "Add new publication"
}

# 2. Server responds with what it needs
{
  "session_id": "...",
  "needed_records": ["def456..."],
  "needed_files": [],
  "total_records": 2,
  "already_have_records": 1
}

# 3. Client sends only the missing records as JSONL
POST /api/collections/:owner/:slug/versions/negotiate/:sessionId/commit
Content-Type: application/x-ndjson

{"id":"pub-002","type":"Publication","data":{"title":"...","doi":"..."}}

# 4. Server verifies hashes, validates schemas, creates version`

const simplePushExample = `POST /api/collections/:owner/:slug/versions
{
  "base_version": 3,
  "schemas": { "Publication": { ... } },
  "changes": {
    "added": [{ "id": "pub-002", "type": "Publication", "data": { ... } }],
    "updated": [{ "id": "pub-001", "type": "Publication", "data": { ... } }],
    "removed": ["pub-003"]
  },
  "message": "Update publications"
}`

const pullExample = `# Full manifest
GET /api/collections/:owner/:slug/versions/5/manifest

# Delta since version 3
GET /api/collections/:owner/:slug/versions/5/manifest?since=3
{
  "version": 5,
  "since": 3,
  "delta": {
    "added":   [{ "id": "pub-004", "type": "Publication", "hash": "..." }],
    "updated": [{ "id": "pub-001", "type": "Publication", "hash": "...", "previousHash": "..." }],
    "removed": [{ "id": "pub-003", "type": "Publication", "hash": "..." }]
  }
}

# Fetch only the records you need
POST /api/records/batch
{ "hashes": ["abc123...", "def456..."] }
# Returns JSONL stream`

const schemaExample = `{
  "type": "object",
  "properties": {
    "title": { "type": "string" },
    "doi": { "type": "string" },
    "authors": {
      "type": "array",
      "items": { "type": "string", "x-ref-type": "Author" }
    },
    "pdf": { "type": "object" },
    "internalNotes": { "type": "string", "private": true }
  }
}`

const fileExample = `# Upload (content-addressed by SHA-256)
PUT /api/collections/:owner/:slug/files/sha256:a1b2c3...
Content-Type: application/pdf
<binary data>

# Reference in a record
{ "pdf": { "$file": "sha256:a1b2c3..." } }`

const provenanceExample = `GET /api/records/:hash/provenance
{
  "hash": "abc123...",
  "recordId": "pub-001",
  "type": "Publication",
  "firstSeen": "2026-01-15T...",
  "references": [
    { "owner": "alice", "collection": "papers", "version": 3, "semver": "v1.2.0" },
    { "owner": "bob", "collection": "reading-list", "version": 1, "semver": "v1.0.0" }
  ]
}`

export default function Protocol() {
  return (
    <BaseLayout>
      <div className="mx-auto max-w-3xl px-4 py-12">
        <h1 className="mb-2 font-sans text-2xl font-semibold tracking-tight">
          The Underlay Protocol
        </h1>
        <p className="text-ink-muted mb-10 text-sm">
          A content-addressed protocol for versioned structured data.{' '}
          <Link to="/docs" className="text-link underline">
            User docs
          </Link>{' '}
          &middot;{' '}
          <Link to="/.well-known/ai.txt" className="text-link underline">
            ai.txt
          </Link>
        </p>

        <div className="docs-prose">
          <h2 id="overview">Overview</h2>
          <p>
            Underlay is a protocol for publishing, versioning, and collaborating on structured data.
            Every piece of content — records, schemas, and files — is identified by its SHA-256
            hash. Versions are manifests that reference these hashes. This means storage is
            deduplicated globally, transfers only move data the other side doesn't have, and
            provenance is built in: any record can be traced back to every collection and version
            that includes it.
          </p>

          <h2 id="data-model">Data model</h2>
          <p>The protocol has four primitives:</p>
          <ul>
            <li>
              <strong>Record</strong> — A JSON object with an <code>id</code>, a <code>type</code>,
              and a <code>data</code> payload. Records are the rows of your dataset. Each record is
              content-addressed by the SHA-256 hash of its canonical JSON representation.
            </li>
            <li>
              <strong>Schema</strong> — A JSON Schema document that describes the structure of a
              record type. Schemas are also content-addressed. They define validation rules, mark
              private fields, and annotate cross-record references.
            </li>
            <li>
              <strong>Version</strong> — An immutable snapshot: a manifest of record hashes, schema
              hashes, file hashes, and a readme. Versions are numbered sequentially and carry an
              auto-derived semver label.
            </li>
            <li>
              <strong>File</strong> — A binary blob (PDF, image, etc.) stored by SHA-256 hash.
              Records reference files with the <code>{'{"$file": "sha256:..."}'}</code> convention.
            </li>
          </ul>

          <h2 id="record-identity">Record identity</h2>
          <p>
            A record's identity is the SHA-256 hash of its canonical JSON. The canonical form is:
          </p>
          <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
            <code>{hashExample}</code>
          </pre>
          <p>
            The <code>private</code> flag is <strong>not</strong> part of the hash. Two records with
            identical <code>id</code>, <code>type</code>, and <code>data</code> but different
            privacy flags produce the same hash. This is intentional — the record's content identity
            doesn't change when you change who can see it.
          </p>
          <p>Wire format is JSONL — one record per line, independently hashable and streamable:</p>
          <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
            <code>{recordExample}</code>
          </pre>

          <h2 id="version-identity">Version identity</h2>
          <p>
            A version's hash is the SHA-256 of a canonical JSON object containing sorted hashes:
          </p>
          <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
            <code>{versionHashExample}</code>
          </pre>
          <p>
            Two versions with the same content produce the same hash, regardless of when or where
            they were created. The server rejects pushes that would create a duplicate hash.
          </p>
          <p>
            A separate <code>public:</code> hash covers only non-private types and fields, with
            private fields stripped before re-hashing. This lets external verifiers confirm the
            public content without access to private data.
          </p>

          <h2 id="push">Push</h2>
          <p>There are two push modes, depending on whether the client knows record hashes.</p>

          <h3>Simple push</h3>
          <p>
            Send the changes (added, updated, removed records) and the server computes hashes
            server-side. Best for small updates or clients that don't track hashes locally.
          </p>
          <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
            <code>{simplePushExample}</code>
          </pre>

          <h3>Negotiate push</h3>
          <p>
            A two-step protocol that avoids transferring records the server already has. Similar to
            git's pack negotiation. Best for large collections where most records are unchanged.
          </p>
          <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
            <code>{negotiateExample}</code>
          </pre>
          <p>
            The negotiate step checks every record and file hash against the server's global store.
            If 100,000 records already exist and only 5 are new, only those 5 are transferred.
          </p>

          <h2 id="pull">Pull</h2>
          <p>
            Clients can fetch a full manifest or a delta between two versions. Combined with the
            batch records endpoint, this enables efficient pull synchronization.
          </p>
          <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
            <code>{pullExample}</code>
          </pre>

          <h2 id="schemas">Schema semantics</h2>
          <p>
            Schemas are{' '}
            <a
              href="https://json-schema.org/"
              target="_blank"
              rel="noreferrer"
              className="text-link underline"
            >
              JSON Schema
            </a>{' '}
            documents with a few protocol-level extensions:
          </p>
          <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
            <code>{schemaExample}</code>
          </pre>
          <ul>
            <li>
              <code>"private": true</code> on a property — the field is stripped from public views
              and excluded from the public hash.
            </li>
            <li>
              <code>"private": true</code> on the schema root — the entire type is hidden from
              public views.
            </li>
            <li>
              <code>"x-ref-type": "Author"</code> — marks a field as a reference to another record
              type (advisory, not enforced).
            </li>
          </ul>
          <p>
            Schemas are content-addressed by their SHA-256 hash. Two collections that use an
            identical Author schema share the same underlying schema object — zero duplication.
            Schema changes trigger a major semver bump.
          </p>

          <h2 id="files">Files</h2>
          <p>
            Files are binary blobs stored by SHA-256 hash. Upload a file, then reference it from a
            record:
          </p>
          <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
            <code>{fileExample}</code>
          </pre>
          <p>
            Files are verified on upload (the server recomputes the hash and rejects mismatches).
            Like records and schemas, files are globally deduplicated — the same PDF in ten
            collections is stored once.
          </p>

          <h2 id="provenance">Provenance</h2>
          <p>
            Because records are content-addressed, every record hash can be traced back to every
            version and collection that includes it. The provenance endpoint returns this lineage:
          </p>
          <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
            <code>{provenanceExample}</code>
          </pre>
          <p>
            <code>firstSeen</code> is the earliest version creation date across all references — the
            record's birthday on this server. This enables citation-like provenance: "this record
            first appeared in alice/papers v3 on 2026-01-15."
          </p>

          <h2 id="collaboration">Collaboration</h2>
          <p>Underlay supports collaboration through a small set of primitives:</p>
          <ul>
            <li>
              <strong>Versioning</strong> — Every push creates a new immutable version. The full
              history is always available. Versions use optimistic locking:{' '}
              <code>base_version</code> must match the current latest, or the push is rejected with
              a 409 conflict.
            </li>
            <li>
              <strong>Diffing</strong> — Any two versions of a collection can be diffed (
              <code>GET .../versions/5/diff?from=3</code>), returning added, updated, and removed
              records with hash-level comparison.
            </li>
            <li>
              <strong>Cross-collection references</strong> — Records reference each other by ID.
              Because record hashes are global, the same record appearing in two collections can be
              identified as identical content.
            </li>
            <li>
              <strong>Mirroring</strong> — Any Underlay instance can pull from another, using hash
              negotiation to transfer only new data. Mirrors maintain verified, independent copies.
            </li>
          </ul>

          <h2 id="errors">Errors</h2>
          <p>
            All error responses return JSON with an <code>error</code> field and an HTTP status
            code:
          </p>
          <ul>
            <li>
              <code>400</code> — Bad request (missing fields, invalid JSONL, hash mismatch)
            </li>
            <li>
              <code>404</code> — Collection, version, or record not found
            </li>
            <li>
              <code>409</code> — Version conflict (base_version doesn't match) or duplicate content
            </li>
            <li>
              <code>422</code> — Schema validation failed or missing schemas/files
            </li>
            <li>
              <code>429</code> — Rate limited (includes <code>Retry-After</code> header)
            </li>
          </ul>
        </div>
      </div>
    </BaseLayout>
  )
}
