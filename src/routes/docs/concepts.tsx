import { Link } from 'react-router'

import DocsLayout from '~/components/DocsLayout'

const recordExample = `{
  "id": "pub-001",
  "type": "Publication",
  "data": {
    "title": "The Structure of Scientific Revolutions",
    "doi": "10.1234/example",
    "authors": ["author-001", "author-002"],
    "pdf": { "$file": "sha256:a1b2c3..." }
  }
}`

const fileRef = '{"$file": "sha256:..."}'

export default function DocsConcepts() {
  return (
    <DocsLayout title="Concepts">
      <p>Underlay has four core primitives. Everything else is built from these.</p>

      <h2>Collection</h2>
      <p>
        A <strong>collection</strong> (plural: <strong>collections</strong>) is a named, versioned
        body of structured data. It belongs to an account (a user or an organization) and is
        identified by <code>:owner/:slug</code> — for example,{' '}
        <code>knowledge-futures/pubpub-archive</code>.
      </p>
      <p>
        A collection can be public (browsable by anyone) or private (visible only to the owner and
        org members). Each collection has its own independent version history.
      </p>

      <h2>Version</h2>
      <p>
        A <strong>version</strong> is an immutable snapshot of a collection at a point in time. Each
        version contains:
      </p>
      <ul>
        <li>
          A <strong>JSON Schema</strong> describing the structure of the records
        </li>
        <li>
          A set of <strong>records</strong> — the actual data
        </li>
        <li>
          References to <strong>files</strong> — binary assets
        </li>
        <li>
          A <strong>metadata</strong> bag — a JSON object that can contain <code>readme</code>,{' '}
          <code>license</code>, and other fields
        </li>
      </ul>
      <p>
        Versions are identified by <strong>semver</strong> (e.g. <code>v1.0.0</code>,{' '}
        <code>v1.1.0</code>, <code>v2.0.0</code>). The semver is derived automatically from what
        changed:
      </p>
      <ul>
        <li>Schema changes → major bump</li>
        <li>Record or file changes → minor bump</li>
        <li>Metadata-only changes (readme, license, etc.) → patch bump</li>
      </ul>
      <p>
        Each version also has a <strong>hash</strong> — a SHA-256 digest of the canonical
        representation of the schema, records, and file references. Two versions with the same hash
        have identical content.
      </p>

      <h2>Record</h2>
      <p>
        A <strong>record</strong> is a flat JSON object with an <code>id</code>, a <code>type</code>
        , and a <code>data</code> payload. Records are the rows of your data.
      </p>
      <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
        <code>{recordExample}</code>
      </pre>
      <p>
        Records are <strong>content-addressed</strong>: each record is identified by the SHA-256
        hash of its canonical JSON (<code>{'{"id":...,"type":...,"data":...}'}</code>). This means:
      </p>
      <ul>
        <li>The same record appearing in multiple collections is stored only once.</li>
        <li>
          Pushing a new version only transfers records the server doesn't already have (via the{' '}
          <Link to="/protocol#push" className="text-link underline">
            negotiate protocol
          </Link>
          ).
        </li>
        <li>
          Any record can be traced back to every collection and version that includes it (
          <Link to="/protocol#provenance" className="text-link underline">
            provenance
          </Link>
          ).
        </li>
      </ul>
      <p>
        Relationships between records are expressed as ID references — just strings. There are no
        joins, no foreign keys. An LLM or application can resolve references by reading the schema
        and records together.
      </p>
      <p>
        Records are validated against the schema on push. If a record contains fields not defined in
        the schema, the push is rejected with a 422 listing the extra fields. Set{' '}
        <code>strip_unknown_fields</code> to accept stripping them automatically.
      </p>
      <p>
        Binary data is referenced via <code>{fileRef}</code> — a pointer to a content-addressed file
        in the registry. The wire format for records is JSONL — one record per line, independently
        hashable and streamable.
      </p>

      <h2>File</h2>
      <p>
        A <strong>file</strong> is a binary blob (PDF, image, dataset, anything) stored by its
        SHA-256 hash. Files are content-addressed: the same bytes always produce the same hash, so
        identical files are stored only once regardless of how many records reference them.
      </p>
      <p>
        Files are uploaded before pushing a version. When you push, the registry verifies that every{' '}
        <code>$file</code> reference in your records points to an existing file.
      </p>

      <h2>Accounts</h2>
      <p>Underlay has two account types:</p>
      <ul>
        <li>
          <strong>Users</strong> — individual accounts with email/password login
        </li>
        <li>
          <strong>Organizations</strong> — group accounts with members who have roles (owner, admin,
          member)
        </li>
      </ul>
      <p>
        Both can own collections. API keys are scoped to an account and optionally to a specific
        collection, with permission levels: <code>read</code>, <code>write</code>, or{' '}
        <code>admin</code>.
      </p>

      <h2>Privacy &amp; Visibility</h2>
      <p>
        Underlay supports fine-grained privacy at three levels, allowing you to store sensitive data
        alongside public data in the same collection.
      </p>

      <h3>Collection-level</h3>
      <p>
        A collection can be <strong>public</strong> (listed in browse, readable by anyone) or{' '}
        <strong>private</strong> (visible only to the owner and org members).
      </p>

      <h3>Type-level</h3>
      <p>
        Mark an entire record type as private in the schema by adding <code>"private": true</code>{' '}
        to the type definition. All records of that type are hidden from public readers, and the
        type is stripped from the schema response.
      </p>

      <h3>Field-level</h3>
      <p>
        Mark individual fields within a type as private by adding <code>"private": true</code> to
        the field definition. The type remains visible, but those fields are stripped from records
        returned to public readers.
      </p>

      <h3>Record-level</h3>
      <p>
        Mark individual records as private by including <code>"private": true</code> in the record
        when pushing. The record is hidden from public queries but visible to the collection owner.
      </p>

      <p>
        Private content is excluded from the <strong>public hash</strong> (used for verifying
        publicly-visible content) but included in the <strong>private hash</strong> (used by owners
        for full integrity verification).
      </p>
    </DocsLayout>
  )
}
