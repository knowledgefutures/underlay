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
      <p>A <strong>collection</strong> (plural: <strong>collections</strong>) is a named, versioned body of structured data. It belongs to an account (a user or an organization) and is identified by <code>:owner/:slug</code> — for example, <code>knowledge-futures/pubpub-archive</code>.</p>
      <p>A collection can be public (browsable by anyone) or private (visible only to the owner and org members). Each collection has its own independent version history.</p>

      <h2>Version</h2>
      <p>A <strong>version</strong> is an immutable snapshot of a collection at a point in time. Each version contains:</p>
      <ul>
        <li>A <strong>JSON Schema</strong> describing the structure of the records</li>
        <li>A set of <strong>records</strong> — the actual data</li>
        <li>References to <strong>files</strong> — binary assets</li>
        <li><strong>Metadata</strong> — who pushed it, when, from which app, with what message</li>
      </ul>
      <p>Versions are numbered sequentially (1, 2, 3…) and also carry a semver label. The semver is derived automatically:</p>
      <ul>
        <li>Schema changes → major bump</li>
        <li>Record changes → minor bump</li>
        <li>Metadata-only changes → patch bump</li>
      </ul>
      <p>Each version also has a <strong>hash</strong> — a SHA-256 digest of the canonical representation of the schema, records, and file references. Two versions with the same hash have identical content.</p>

      <h2>Record</h2>
      <p>A <strong>record</strong> is a flat JSON object with an <code>id</code> and a <code>type</code>. Records are the rows of your data.</p>
      <pre className="bg-ink text-parchment p-3 text-xs overflow-x-auto"><code>{recordExample}</code></pre>
      <p>Relationships between records are expressed as ID references — just strings. There are no joins, no foreign keys. An LLM or application can resolve references by reading the schema and records together.</p>
      <p>Binary data is referenced via <code>{fileRef}</code> — a pointer to a content-addressed file in the registry.</p>

      <h2>File</h2>
      <p>A <strong>file</strong> is a binary blob (PDF, image, dataset, anything) stored by its SHA-256 hash. Files are content-addressed: the same bytes always produce the same hash, so identical files are stored only once regardless of how many records reference them.</p>
      <p>Files are uploaded before pushing a version. When you push, the registry verifies that every <code>$file</code> reference in your records points to an existing file.</p>

      <h2>Accounts</h2>
      <p>Underlay has two account types:</p>
      <ul>
        <li><strong>Users</strong> — individual accounts with email/password login</li>
        <li><strong>Organizations</strong> — group accounts with members who have roles (owner, admin, member)</li>
      </ul>
      <p>Both can own collections. API keys are scoped to an account and optionally to a specific collection, with permission levels: <code>read</code>, <code>write</code>, or <code>admin</code>.</p>

      <h2>Privacy &amp; Visibility</h2>
      <p>Underlay supports fine-grained privacy at three levels, allowing you to store sensitive data alongside public data in the same collection.</p>

      <h3>Collection-level</h3>
      <p>A collection can be <strong>public</strong> (listed in browse, readable by anyone) or <strong>private</strong> (visible only to the owner and org members).</p>

      <h3>Type-level</h3>
      <p>Mark an entire record type as private in the schema by adding <code>"private": true</code> to the type definition. All records of that type are hidden from public readers, and the type is stripped from the schema response.</p>

      <h3>Field-level</h3>
      <p>Mark individual fields within a type as private by adding <code>"private": true</code> to the field definition. The type remains visible, but those fields are stripped from records returned to public readers.</p>

      <h3>Record-level</h3>
      <p>Mark individual records as private by including <code>"private": true</code> in the record when pushing. The record is hidden from public queries but visible to the collection owner.</p>

      <p>Private content is excluded from the <strong>public hash</strong> (used for verifying publicly-visible content) but included in the <strong>private hash</strong> (used by owners for full integrity verification).</p>
    </DocsLayout>
  )
}
