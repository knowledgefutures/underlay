import { Link } from 'react-router'

import DocsLayout from '~/components/DocsLayout'
import { HELP_EMAIL } from '~/lib/contact'

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
        body of structured data. It belongs to an organization and is identified by{' '}
        <code>:owner/:slug</code>, e.g. <code>knowledge-futures/pubpub-archive</code>.
      </p>
      <p>
        A collection is public (readable by anyone) or private (readable only by members of the
        organization that owns it), as a whole. Each collection has its own version history. A fork
        starts with its parent&rsquo;s history up to the fork point, with the same version ids and
        semvers.
      </p>

      <h2>Version</h2>
      <p>
        A collection&rsquo;s history is a log of <strong>commits</strong>. Each push, and each
        metadata edit, adds one commit, which holds only what it changed: records added, changed or
        removed, and changes to schemas, metadata and files. A <strong>version</strong> is the
        collection as of one commit: what the commits up to it add up to, with the newest change to
        each record winning. A published version never changes. Each version contains:
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
        <li>Records added, removed or changed → minor bump</li>
        <li>Metadata or file changes only (readme, license, etc.) → patch bump</li>
      </ul>
      <p>
        Each version also has an <strong>id</strong> (the <code>hash</code> field in API responses):{' '}
        <code>ulv3:</code> followed by the SHA-256 of its commit. A commit names the commit before
        it, so the id fixes the version&rsquo;s content and its whole history. Versions converted
        from Underlay&rsquo;s earlier format kept their semvers, and their old <code>ulv2:</code>{' '}
        ids still work wherever the read API takes a version; responses show the <code>ulv3:</code>{' '}
        id.
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
          A commit stores only the records that changed, so versions share everything they have in
          common.
        </li>
        <li>
          Pushing a new version only transfers what changed (see{' '}
          <Link to="/docs/protocol/push-and-pull" className="text-link underline">
            push and pull
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
        uploaded to it, or already in its current version. A commit refused for missing files
        answers <code>422</code> with the hashes in <code>filesNeeded</code>, and the push stays
        open: upload them and commit again.
      </p>

      <h2>Accounts</h2>
      <p>Underlay has two account types:</p>
      <ul>
        <li>
          <strong>Users</strong>: people, who sign in with KF Auth and belong to organizations.
        </li>
        <li>
          <strong>Organizations</strong>: group accounts with members who have roles (owner, admin,
          member). Collections belong to organizations. Each organization belongs to a Knowledge
          Futures account; to have one set up, email{' '}
          <a href={`mailto:${HELP_EMAIL}`}>{HELP_EMAIL}</a>.
        </li>
      </ul>
      <p>
        API keys belong to a user or an organization and may be confined to some collections. A key
        has the scope <code>read</code>, <code>write</code> or <code>admin</code>, and never exceeds
        its holder&rsquo;s role: <code>read</code> and <code>write</code> keys act as a member, and
        an <code>admin</code> key keeps an owner&rsquo;s or admin&rsquo;s powers. A
        collection-scoped key acts as a member of its collections whatever its scope, and is refused
        on account and organization endpoints.
      </p>

      <h2>Privacy &amp; Visibility</h2>
      <p>
        Privacy is set per collection. A collection is <strong>public</strong> (listed in browse,
        readable by anyone) or <strong>private</strong> (readable only by members of the
        organization that owns it). The setting covers the whole collection: every version, record,
        schema and file in it, earlier versions included. Only an organization&rsquo;s owners and
        admins can change it. A collection created through the API is private unless the request
        sends <code>"public": true</code>.
      </p>
      <p>
        There are no private records or private types inside a collection. To keep some of your data
        private, push it to a separate private collection. A push to a public collection is refused
        with <code>422</code> if it marks a record <code>"private": true</code> or a type&rsquo;s
        schema <code>"private": true</code>. In a private collection the mark is accepted and
        changes nothing, since everything in it is already private. <code>"private": true</code> on
        a field inside a schema is refused in any collection.
      </p>
      <p>
        A published version never changes, so anonymous reads of it are cached for up to about
        eleven minutes. Making a collection private can therefore take that long to reach every
        reader; making it public takes effect at once.
      </p>
    </DocsLayout>
  )
}
