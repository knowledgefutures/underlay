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
        identified by <code>:owner/:slug</code>, e.g. <code>knowledge-futures/pubpub-archive</code>.
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
          A <strong>JSON Schema</strong> for each record type
        </li>
        <li>
          A set of <strong>records</strong> (the actual data)
        </li>
        <li>
          References to <strong>files</strong> (binary assets)
        </li>
        <li>
          A <strong>metadata</strong> object that can contain <code>readme</code>,{' '}
          <code>license</code>, and other fields
        </li>
      </ul>
      <p>
        Versions are identified by <strong>semver</strong> (e.g. <code>v1.0.0</code>,{' '}
        <code>v1.1.0</code>, <code>v2.0.0</code>). The semver is derived automatically from what
        changed:
      </p>
      <ul>
        <li>A type added or removed, or a schema changed → major bump</li>
        <li>Records added, removed or changed (including made private or public) → minor bump</li>
        <li>Metadata or file changes only (readme, license, etc.) → patch bump</li>
      </ul>
      <p>
        Each version also has a <strong>hash</strong>: <code>ulv2:</code> followed by the SHA-256 of
        the version root, which covers the metadata, every public schema, record and file, and a
        salted commitment to the private ones. Two versions with the same hash have identical
        content.
      </p>

      <h2>Record</h2>
      <p>
        A <strong>record</strong> has an <code>id</code>, a <code>type</code> and a{' '}
        <code>data</code> payload. Records are the rows of your data. Within a version, a type and
        an id identify one record.
      </p>
      <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
        <code>{recordExample}</code>
      </pre>
      <p>
        Records are <strong>content-addressed</strong>: each record is identified by the SHA-256
        hash of its canonical JSON (<code>{'{"id":...,"type":...,"data":...}'}</code>). This means:
      </p>
      <ul>
        <li>
          Records are stored in content-addressed trees, so versions share every part of the data
          they have in common.
        </li>
        <li>
          Pushing a new version only transfers what changed (see{' '}
          <Link to="/docs/protocol/push-and-pull" className="text-link underline">
            push and pull
          </Link>
          ).
        </li>
        <li>
          A record&rsquo;s hash finds the collections and versions you can read that include it (
          <Link to="/docs/api/records" className="text-link underline">
            provenance
          </Link>
          ).
        </li>
      </ul>
      <p>
        Relationships between records are expressed as ID references (just strings). There are no
        joins, no foreign keys. An LLM or application can resolve references by reading the schema
        and records together.
      </p>
      <p>
        Records are validated against their type&rsquo;s schema as they are uploaded. If a record
        has top-level fields the schema&rsquo;s <code>properties</code> don&rsquo;t list, the upload
        is refused with a 422 listing them. Set <code>strip_unknown_fields</code> when opening the
        push to drop them instead.
      </p>
      <p>
        Binary data is referenced via <code>{fileRef}</code>, a pointer to a content-addressed file.
        The wire format for records is NDJSON, one record per line, independently hashable and
        streamable.
      </p>

      <h2>File</h2>
      <p>
        A <strong>file</strong> is a binary blob (PDF, image, dataset, anything) stored by its
        SHA-256 hash. Files are content-addressed: the same bytes always produce the same hash, so
        identical files are stored only once regardless of how many records reference them.
      </p>
      <p>
        Files are uploaded before the commit that references them. The commit is refused unless
        every <code>$file</code> reference in your records points to a file this collection holds:
        uploaded to it, or already in one of its versions.
      </p>

      <h2>Accounts</h2>
      <p>Underlay has two account types:</p>
      <ul>
        <li>
          <strong>Users</strong>: people, who sign in with KF Auth. Each user has a personal account
          that can own collections.
        </li>
        <li>
          <strong>Organizations</strong>: group accounts with members who have roles (owner, admin,
          member)
        </li>
      </ul>
      <p>
        API keys belong to a user or an organization and may be confined to some collections. A key
        has the scope <code>read</code>, <code>write</code> or <code>admin</code>, and never exceeds
        its holder&rsquo;s role: <code>read</code> and <code>write</code> keys act as a member, and
        an <code>admin</code> key keeps an owner&rsquo;s or admin&rsquo;s powers. A
        collection-scoped key is refused on account and organization endpoints.
      </p>

      <h2>Privacy &amp; Visibility</h2>
      <p>
        Underlay has privacy at three levels, so private data can sit alongside public data in the
        same collection. Each version has a public set and a private set; members of the owning
        organization read both, everyone else the public set.
      </p>

      <h3>Collection-level</h3>
      <p>
        A collection can be <strong>public</strong> (listed in browse, readable by anyone) or{' '}
        <strong>private</strong> (visible only to the owner and org members).
      </p>
      <p>
        A published version never changes, so anonymous reads of it are cached for up to about
        eleven minutes. Making a collection private can therefore take that long to reach every
        reader; making it public takes effect at once.
      </p>

      <h3>Type-level</h3>
      <p>
        Mark an entire record type as private in the schema by adding <code>"private": true</code>{' '}
        at the root of the type&rsquo;s schema. All records of that type are hidden from public
        readers, and the type is absent from every read, schemas included.
      </p>

      <h3>Record-level</h3>
      <p>
        Mark an individual record private by adding <code>"private": true</code> to its line when
        you upload it. The flag is not part of the record&rsquo;s data or its hash:
      </p>
      <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
        <code>{'{"id": "pub-001", "type": "Publication", "data": {...}, "private": true}'}</code>
      </pre>
      <p>
        The record is absent from listings, manifests, diffs, exports and the NDJSON stream for
        non-members; members of the owning org still see it.
      </p>
      <p>
        <strong>Privacy belongs to the version, not the record.</strong> A record keeps its set from
        one version to the next until you upload it again: uploading it with{' '}
        <code>"private": true</code> makes it private, and uploading it without the flag makes it
        public. Read the current flags back from <code>GET .../versions/:semver/manifest</code>,
        which marks private entries with <code>private</code>.
      </p>
      <p>
        Redaction is <strong>forward-only</strong>: marking a record private in a new version hides
        it from that version on. Earlier versions are immutable and still serve it. Because file
        access resolves across every version, a file referenced publicly in an earlier version also
        stays downloadable after the referencing record is made private.
      </p>

      <h3>Fields</h3>
      <p>
        <code>"private": true</code> on a field inside a schema is refused. Put private fields in a
        private type, or push the whole record as private.
      </p>

      <p>
        A version&rsquo;s hash covers the private set only through a salted commitment, so public
        readers can verify everything they can see without learning anything about the private
        content. Members can check the private set against the commitment.
      </p>
    </DocsLayout>
  )
}
