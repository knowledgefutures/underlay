import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useLoaderData } from 'react-router'

import BaseLayout from '~/components/BaseLayout'
import DiscussionDrawer from '~/components/DiscussionDrawer'
import { useAppContext } from '~/lib/app-context'

const recordExample = `{"id":"pub-001","type":"Publication","data":{"title":"The Structure of Scientific Revolutions","doi":"10.1234/example"}}`

const hashExample = `canonical = JSON.stringify({ id: "pub-001", type: "Publication", data: { ... } })
hash = SHA256(canonical)  // hex-encoded`

const versionHashExample = `canonical = JSON.stringify({
  schemas: { "Publication": "abc123...", "Author": "def456..." },  // sorted by slug
  records: ["0a1b2c...", "3d4e5f...", ...],                        // sorted, hex SHA-256
  files: ["7a8b9c...", ...],                                       // sorted, hex SHA-256
  metadata: { "license": "CC-BY-4.0", "readme": "# My Collection\\n..." }  // canonicalized JSON
})
hash = "private:" + SHA256(canonical)`

const negotiateExample = `# 1. Client sends manifest of record hashes
POST /api/collections/:owner/:slug/versions/negotiate
{
  "base_version": "v1.1.0",
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

# 3. Client sends only the missing records as JSONL (repeatable for large batches)
POST /api/collections/:owner/:slug/versions/negotiate/:sessionId/records
Content-Type: application/x-ndjson

{"id":"pub-002","type":"Publication","data":{"title":"...","doi":"..."}}
# -> { "received": 1, "remaining": 0, "total_needed": 1 }

# 4. Client commits — server validates schemas, creates version
POST /api/collections/:owner/:slug/versions/negotiate/:sessionId/commit
# -> { "semver": "v1.2.0", "hash": "...", "recordCount": 2, "fileCount": 1 }`

const pullExample = `# Full manifest
GET /api/collections/:owner/:slug/versions/v2.0.0/manifest

# Delta since a previous version
GET /api/collections/:owner/:slug/versions/v2.0.0/manifest?since=v1.1.0
{
  "version": "v2.0.0",
  "since": "v1.1.0",
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
    { "owner": "alice", "collection": "papers", "version": "v1.2.0" },
    { "owner": "bob", "collection": "reading-list", "version": "v1.0.0" }
  ]
}`

interface Comment {
  id: string
  anchor: string
  quote: string | null
  quoteContext: { prefix: string; suffix: string } | null
  parentId: string | null
  userId: string
  body: string
  approvedAt: string | null
  status: 'open' | 'answered' | 'decided' | 'changed'
  resolutionNote: string | null
  createdAt: string
  editedAt: string | null
  authorName: string
  authorImage: string | null
}

type CommentsByAnchor = Record<string, Comment[]>

export default function Protocol() {
  const data = useLoaderData<{ counts: Record<string, number> }>()
  const { currentUser } = useAppContext()
  const [comments, setComments] = useState<CommentsByAnchor>({})
  const [drawerAnchor, setDrawerAnchor] = useState<string | null>(null)
  const [selectionQuote, setSelectionQuote] = useState<string | null>(null)
  const [selectionContext, setSelectionContext] = useState<{
    prefix: string
    suffix: string
  } | null>(null)
  const [popover, setPopover] = useState<{
    x: number
    y: number
    anchor: string
    quote: string
    context: { prefix: string; suffix: string }
  } | null>(null)
  const [counts, setCounts] = useState<Record<string, number>>(data?.counts ?? {})
  const popoverRef = useRef<HTMLDivElement>(null)

  const isSteward = currentUser?.kfRole === 'admin'

  const fetchComments = useCallback(async () => {
    const res = await fetch('/api/pages/protocol/comments')
    if (res.ok) {
      const data = await res.json()
      setComments(data.comments ?? {})
      const newCounts: Record<string, number> = {}
      for (const [anchor, list] of Object.entries(data.comments ?? {})) {
        newCounts[anchor] = (list as Comment[]).filter(
          (c) => c.approvedAt && !c.parentId && c.status === 'open',
        ).length
      }
      setCounts(newCounts)
    }
  }, [])

  useEffect(() => {
    fetchComments()
  }, [fetchComments])

  function findAnchorForNode(node: Node): string | null {
    let el: HTMLElement | null =
      node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement)
    while (el) {
      if (el.dataset.rfcSection) return el.dataset.rfcSection
      el = el.parentElement
    }
    return null
  }

  useEffect(() => {
    function handleMouseUp() {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || !sel.rangeCount) {
        return
      }
      const range = sel.getRangeAt(0)
      const text = sel.toString().trim()
      if (!text || text.length < 3 || text.length > 2000) return

      const anchor = findAnchorForNode(range.startContainer)
      if (!anchor) return

      const rect = range.getBoundingClientRect()
      const fullText = range.startContainer.textContent ?? ''
      const start = Math.max(0, range.startOffset - 40)
      const end = Math.min(fullText.length, range.endOffset + 40)
      const prefix = fullText.slice(start, range.startOffset)
      const suffix = fullText.slice(range.endOffset, end)

      setPopover({
        x: rect.left + rect.width / 2,
        y: rect.top - 10,
        anchor,
        quote: text,
        context: { prefix, suffix },
      })
    }

    function handleMouseDown(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setPopover(null)
      }
    }

    document.addEventListener('mouseup', handleMouseUp)
    document.addEventListener('mousedown', handleMouseDown)
    return () => {
      document.removeEventListener('mouseup', handleMouseUp)
      document.removeEventListener('mousedown', handleMouseDown)
    }
  }, [])

  function openDrawerWithQuote(
    anchor: string,
    quote: string | null,
    context: { prefix: string; suffix: string } | null,
  ) {
    setDrawerAnchor(anchor)
    setSelectionQuote(quote)
    setSelectionContext(context)
    setPopover(null)
    window.getSelection()?.removeAllRanges()
  }

  function openDrawerForSection(anchor: string) {
    setDrawerAnchor(anchor)
    setSelectionQuote(null)
    setSelectionContext(null)
  }

  const closedThreads = Object.values(comments)
    .flat()
    .filter((c) => c.approvedAt && !c.parentId && c.status !== 'open')

  const statusLabel: Record<string, string> = {
    answered: 'Answered',
    decided: 'Decided',
    changed: 'Changed',
  }

  const statusColor: Record<string, string> = {
    answered: 'text-blue-700',
    decided: 'text-amber-700',
    changed: 'text-green-700',
  }

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
          <a href="/llms.txt" className="text-link underline">
            llms.txt
          </a>
          {isSteward && (
            <>
              {' '}
              &middot;{' '}
              <Link to="/superadmin" className="text-link underline">
                Admin
              </Link>
            </>
          )}
        </p>

        <div className="docs-prose">
          <RfcSection id="overview" count={counts['overview'] ?? 0} onOpen={openDrawerForSection}>
            <h2 id="overview">Overview</h2>
            <p>
              Underlay is a protocol for publishing, versioning, and collaborating on structured
              data. Every piece of content (records, schemas, and files) is identified by its
              SHA-256 hash. Versions are manifests that reference these hashes. This means storage
              is deduplicated globally, transfers only move data the other side doesn't have, and
              provenance is built in: any record can be traced back to every collection and version
              that includes it.
            </p>
          </RfcSection>

          <RfcSection
            id="data-model"
            count={counts['data-model'] ?? 0}
            onOpen={openDrawerForSection}
          >
            <h2 id="data-model">Data model</h2>
            <p>The protocol has four primitives:</p>
            <ul>
              <li>
                <strong>Record</strong>: A JSON object with an <code>id</code>, a <code>type</code>,
                and a <code>data</code> payload. Records are the rows of your dataset. Each record
                is content-addressed by the SHA-256 hash of its canonical JSON representation.
              </li>
              <li>
                <strong>Schema</strong>: A JSON Schema document that describes the structure of a
                record type. Schemas are also content-addressed. They define validation rules, mark
                private fields, and annotate cross-record references.
              </li>
              <li>
                <strong>Version</strong>: An immutable snapshot: a manifest of record hashes, schema
                hashes, file hashes, and a metadata bag. Versions are identified by semver (e.g.{' '}
                <code>v1.2.0</code>).
              </li>
              <li>
                <strong>File</strong>: A binary blob (PDF, image, etc.) stored by SHA-256 hash.
                Records reference files with the <code>{'{"$file": "sha256:..."}'}</code>{' '}
                convention.
              </li>
            </ul>
          </RfcSection>

          <RfcSection
            id="record-identity"
            count={counts['record-identity'] ?? 0}
            onOpen={openDrawerForSection}
          >
            <h2 id="record-identity">Record identity</h2>
            <p>
              A record's identity is the SHA-256 hash of its canonical JSON. The canonical form is:
            </p>
            <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
              <code>{hashExample}</code>
            </pre>
            <p>
              The <code>private</code> flag is <strong>not</strong> part of the hash. Two records
              with identical <code>id</code>, <code>type</code>, and <code>data</code> but different
              privacy flags produce the same hash. This is intentional. The record's content
              identity doesn't change when you change who can see it.
            </p>
            <p>
              A record whose type declares private <em>fields</em> has a second address: its{' '}
              <strong>public record hash</strong>, the SHA-256 of the same canonical form with the
              private fields stripped. Public manifests list records by their public hash, and the
              record endpoints resolve either address, so a public reader can always verify that
              hashing the document they received reproduces the address they requested. When a type
              has no private fields the two addresses coincide.
            </p>
            <p>Wire format is JSONL: one record per line, independently hashable and streamable:</p>
            <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
              <code>{recordExample}</code>
            </pre>
          </RfcSection>

          <RfcSection
            id="version-identity"
            count={counts['version-identity'] ?? 0}
            onOpen={openDrawerForSection}
          >
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

            <h3>Semver semantics</h3>
            <p>
              Versions are identified by semver strings (e.g. <code>v1.2.0</code>). The server
              auto-derives the next version based on what changed:
            </p>
            <ul>
              <li>
                <strong>Major bump</strong>: a schema changed (e.g. <code>v1.2.0</code> {'->'}{' '}
                <code>v2.0.0</code>)
              </li>
              <li>
                <strong>Minor bump</strong>: records or files changed (e.g. <code>v1.2.0</code>{' '}
                {'->'} <code>v1.3.0</code>)
              </li>
              <li>
                <strong>Patch bump</strong>: metadata-only change such as readme or license (e.g.{' '}
                <code>v1.2.0</code> {'->'} <code>v1.2.1</code>)
              </li>
            </ul>
          </RfcSection>

          <RfcSection id="push" count={counts['push'] ?? 0} onOpen={openDrawerForSection}>
            <h2 id="push">Push</h2>
            <p>
              All pushes use the negotiate protocol, a three-step flow similar to git's pack
              negotiation. The client sends a manifest of record hashes, the server says which it
              needs, the client sends those records (in one or more batches), then commits.
            </p>
            <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
              <code>{negotiateExample}</code>
            </pre>
            <p>
              The negotiate step checks every record and file hash against the server's global
              store. If 100,000 records already exist and only 5 are new, only those 5 are
              transferred.
            </p>
            <p>
              For large pushes, the <code>/records</code> endpoint can be called multiple times (up
              to 10,000 records per batch). The server tracks which records have been received. Once
              all needed records are submitted, commit to finalize the version. Sessions expire
              after 10 minutes.
            </p>
          </RfcSection>

          <RfcSection id="pull" count={counts['pull'] ?? 0} onOpen={openDrawerForSection}>
            <h2 id="pull">Pull</h2>
            <p>
              Clients can fetch a full manifest or a delta between two versions. Combined with the
              batch records endpoint, this enables efficient pull synchronization.
            </p>
            <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
              <code>{pullExample}</code>
            </pre>
          </RfcSection>

          <RfcSection id="schemas" count={counts['schemas'] ?? 0} onOpen={openDrawerForSection}>
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
                <code>"private": true</code> on a property: the field is stripped from public views
                and excluded from the public hash.
              </li>
              <li>
                <code>"private": true</code> on the schema root: the entire type is hidden from
                public views.
              </li>
              <li>
                <code>"x-ref-type": "Author"</code>: marks a field as a reference to another record
                type (advisory, not enforced).
              </li>
            </ul>
            <p>
              Schemas are content-addressed by their SHA-256 hash. Two collections that use an
              identical Author schema share the same underlying schema object, with zero
              duplication. Schema changes trigger a major semver bump.
            </p>

            <h3>Unknown field handling</h3>
            <p>
              When records contain fields not defined in the schema, the server rejects the push
              with a <code>422</code> response listing the extra fields per record. This protects
              against accidentally storing data outside the schema contract.
            </p>
            <p>
              To accept stripping, set <code>"strip_unknown_fields": true</code> in the negotiate
              request. The server strips the extra fields before hashing and storing, so the stored
              records match the schema exactly. Hashes are recomputed after stripping.
            </p>
          </RfcSection>

          <RfcSection id="files" count={counts['files'] ?? 0} onOpen={openDrawerForSection}>
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
              Like records and schemas, files are globally deduplicated. The same PDF in ten
              collections is stored once.
            </p>
          </RfcSection>

          <RfcSection
            id="provenance"
            count={counts['provenance'] ?? 0}
            onOpen={openDrawerForSection}
          >
            <h2 id="provenance">Provenance</h2>
            <p>
              Because records are content-addressed, every record hash can be traced back to every
              version and collection that includes it. The provenance endpoint returns this lineage:
            </p>
            <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
              <code>{provenanceExample}</code>
            </pre>
            <p>
              <code>firstSeen</code> is the earliest version creation date across all references,
              the record's birthday on this server. This enables citation-like provenance: "this
              record first appeared in alice/papers v1.2.0 on 2026-01-15."
            </p>
          </RfcSection>

          <RfcSection
            id="collaboration"
            count={counts['collaboration'] ?? 0}
            onOpen={openDrawerForSection}
          >
            <h2 id="collaboration">Collaboration</h2>
            <p>Underlay supports collaboration through a small set of primitives:</p>
            <ul>
              <li>
                <strong>Versioning</strong>. Every push creates a new immutable version. The full
                history is always available. Versions are identified by semver strings and use
                optimistic locking: <code>base_version</code> (a semver string, or null for the
                first push) must match the current latest, or the push is rejected with a 409
                conflict.
              </li>
              <li>
                <strong>Diffing</strong>. Any two versions of a collection can be diffed (
                <code>GET .../versions/v2.0.0/diff?from=v1.1.0</code>), returning added, updated,
                and removed records with hash-level comparison.
              </li>
              <li>
                <strong>Cross-collection references</strong>. Records reference each other by ID.
                Because record hashes are global, the same record appearing in two collections can
                be identified as identical content.
              </li>
              <li>
                <strong>Mirroring</strong>. Any Underlay instance can pull from another, using hash
                negotiation to transfer only new data. Mirrors maintain verified, independent
                copies.
              </li>
              <li>
                <strong>Forking</strong>. <code>POST .../fork</code> creates a new collection under
                your org with the source's latest version. Because records, schemas, and files are
                content-addressed, forking copies only the manifest; zero additional storage. The
                fork tracks its origin via <code>forkedFrom</code>.
              </li>
            </ul>
          </RfcSection>

          <RfcSection id="errors" count={counts['errors'] ?? 0} onOpen={openDrawerForSection}>
            <h2 id="errors">Errors</h2>
            <p>
              All error responses return JSON with an <code>error</code> field and an HTTP status
              code:
            </p>
            <ul>
              <li>
                <code>400</code> - Bad request (missing fields, invalid JSONL, hash mismatch)
              </li>
              <li>
                <code>404</code> - Collection, version, or record not found
              </li>
              <li>
                <code>409</code> - Version conflict (base_version doesn't match) or duplicate
                content
              </li>
              <li>
                <code>422</code> - Schema validation failed, missing schemas/files, or records
                contain fields not defined in the schema (set <code>strip_unknown_fields</code> to
                accept stripping)
              </li>
              <li>
                <code>429</code> - Rate limited (includes <code>Retry-After</code> header)
              </li>
            </ul>
          </RfcSection>
        </div>

        {closedThreads.length > 0 && (
          <div className="border-rule mt-16 border-t pt-8">
            <h2 className="mb-4 text-lg font-semibold">Decision log</h2>
            <p className="text-ink-muted mb-6 text-sm">
              Resolved discussions about this specification.
            </p>
            <div className="space-y-4">
              {closedThreads.map((thread) => (
                <div key={thread.id} className="border-rule rounded border p-3">
                  <div className="mb-1 flex items-center gap-2 text-xs">
                    <span className={`font-medium ${statusColor[thread.status] ?? ''}`}>
                      {statusLabel[thread.status] ?? thread.status}
                    </span>
                    <span className="text-ink-muted">
                      {new Date(thread.createdAt).toLocaleDateString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                      })}
                    </span>
                    <span className="text-ink-muted">in</span>
                    <button
                      onClick={() => openDrawerForSection(thread.anchor)}
                      className="text-link text-xs underline"
                    >
                      {thread.anchor}
                    </button>
                  </div>
                  {thread.quote && (
                    <div className="border-rule mb-2 border-l-2 pl-2 text-xs text-amber-800 italic">
                      "{thread.quote}"
                    </div>
                  )}
                  <p className="text-sm">{thread.body}</p>
                  {thread.resolutionNote && (
                    <div className="border-rule mt-2 rounded border bg-gray-50 px-2 py-1.5 text-xs">
                      <span className="font-medium">Resolution:</span> {thread.resolutionNote}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="border-rule mt-12 border-t pt-6">
          <p className="text-ink-muted text-xs">
            Spotted an ambiguity, an error, or something that broke when you implemented it? Select
            any text above to comment on it. The protocol is stewarded by{' '}
            <a href="https://www.knowledgefutures.org" className="text-link underline">
              Knowledge Futures
            </a>{' '}
            . We read everything, publish what moves the spec forward, and keep building.
          </p>
        </div>
      </div>

      {popover && currentUser && (
        <div
          ref={popoverRef}
          className="bg-ink text-parchment fixed z-50 rounded px-3 py-1.5 text-xs font-medium shadow-lg"
          style={{
            left: popover.x,
            top: popover.y,
            transform: 'translate(-50%, -100%)',
          }}
        >
          <button
            onClick={() => openDrawerWithQuote(popover.anchor, popover.quote, popover.context)}
          >
            Comment on this
          </button>
        </div>
      )}

      {drawerAnchor && (
        <DiscussionDrawer
          page="protocol"
          anchor={drawerAnchor}
          quote={selectionQuote}
          quoteContext={selectionContext}
          comments={comments}
          onClose={() => setDrawerAnchor(null)}
          onRefresh={fetchComments}
          isSteward={isSteward}
        />
      )}
    </BaseLayout>
  )
}

function RfcSection({
  id,
  count,
  onOpen,
  children,
}: {
  id: string
  count: number
  onOpen: (id: string) => void
  children: React.ReactNode
}) {
  return (
    <div className="group relative" data-rfc-section={id}>
      <div className="absolute top-0 -right-12 hidden lg:block">
        <button
          onClick={() => onOpen(id)}
          className="text-ink-muted hover:text-ink hover:bg-parchment-dark flex h-7 min-w-[28px] items-center justify-center rounded-full text-xs transition-colors"
          title={count > 0 ? `${count} open thread${count === 1 ? '' : 's'}` : 'Start discussion'}
        >
          {count > 0 ? count : '+'}
        </button>
      </div>
      {children}
    </div>
  )
}
