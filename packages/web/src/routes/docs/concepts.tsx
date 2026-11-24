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
    "pdf": { "$asset": "ul:asset:a1b2c3...", "mediaType": "application/pdf", "fileName": "paper.pdf" }
  }
}`

const assetRef = '{"$asset": "ul:asset:..."}'
const linkExample = `"derivedFrom": {"$link": "ul:rec:9f2c...", "collection": "4f7d1c2e-...",
                "type": "work", "id": "10.1234/abc"}`

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
        metadata edit, adds one commit, which holds only what it changed: records added, changed, or
        removed, and changes to schemas, metadata, and assets. A <strong>version</strong> is the
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
          The <strong>assets</strong> its records attach (PDFs, images, and other bytes)
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
        <li>Records added, removed, or changed → minor bump</li>
        <li>Metadata or asset changes only (readme, license, etc.) → patch bump</li>
      </ul>
      <p>
        Each version also has an <strong>id</strong> (the <code>hash</code> field in API responses):{' '}
        <code>ul:ver:</code> followed by the SHA-256 of its commit. A commit names the commit before
        it, so the id fixes the version&rsquo;s content and its whole history. Wherever the API
        takes a version it also takes the id&rsquo;s bare hex; responses show the{' '}
        <code>ul:ver:</code> id.
      </p>

      <h2>Record</h2>
      <p>
        A <strong>record</strong> has an <code>id</code>, a <code>type</code>, and a{' '}
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
          <Link to="/docs/protocol/v3/push-and-pull" className="text-link underline">
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
        A record attaches binary data with <code>{assetRef}</code>, a reference to an asset. The
        wire format for records is NDJSON, one record per line, independently hashable and
        streamable.
      </p>

      <h2>Asset</h2>
      <p>
        An <strong>asset</strong> is a binary blob (PDF, image, dataset, anything) a collection
        holds beside its records, stored by its SHA-256 hash and named{' '}
        <code>ul:asset:&lt;hash&gt;</code>. Assets are content-addressed: the same bytes always
        produce the same hash, so identical assets are stored only once regardless of how many
        records attach them.
      </p>
      <p>
        Assets are uploaded before the commit whose records attach them. The commit is refused
        unless every <code>$asset</code> reference in your records names an asset this collection
        holds: uploaded to it, or already in its current version. A commit refused for missing
        assets answers <code>422</code> with the hashes in <code>assetsNeeded</code>, and the push
        stays open: upload them and commit again. A <code>$asset</code> that isn&rsquo;t a{' '}
        <code>ul:asset:</code> id is refused when you push, and so is a <code>$file</code>. Records
        written before November 2026 used <code>$file</code>; they were rewritten.
      </p>

      <h2>Links</h2>
      <p>
        Every record, asset, and version has an <strong>Underlay id</strong> built from its hash:{' '}
        <code>ul:rec:&lt;hash&gt;</code>, <code>ul:asset:&lt;hash&gt;</code>, and{' '}
        <code>ul:ver:&lt;hash&gt;</code>. Use them to cite exact data, and to link records across
        collections. A <strong>link</strong> is an object in a record&rsquo;s data:
      </p>
      <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
        <code>{linkExample}</code>
      </pre>
      <p>
        The prefix says what a link points at: <code>ul:rec:</code> a record, <code>ul:asset:</code>{' '}
        an asset, <code>ul:ver:</code> a version. The hash pins exactly what you pointed at;{' '}
        <code>collection</code> (the collection&rsquo;s id) says where you found it, and for a
        record so do <code>type</code> and <code>id</code>, so readers can open it. A record
        page&rsquo;s <em>Copy as $link</em> button gives you the whole object. A <code>$link</code>{' '}
        that isn&rsquo;t a <code>ul:</code> id is refused when you push, but its target is never
        checked: it may be private or on another server. A link to an asset only points at it; to
        attach an asset to your collection, use <code>$asset</code>. See{' '}
        <Link to="/docs/protocol/v3/records#links" className="text-link underline">
          Links
        </Link>
        .
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
        has the scope <code>read</code>, <code>write</code>, or <code>admin</code>, and never
        exceeds its holder&rsquo;s role: <code>read</code> and <code>write</code> keys act as a
        member, and an <code>admin</code> key keeps an owner&rsquo;s or admin&rsquo;s powers. A
        collection-scoped key acts as a member of its collections whatever its scope, and is refused
        on account and organization endpoints.
      </p>

      <h2>Privacy &amp; Visibility</h2>
      <p>
        Privacy is set per collection. A collection is <strong>public</strong> (listed in browse,
        readable by anyone) or <strong>private</strong> (readable only by members of the
        organization that owns it). The setting covers the whole collection: every version, record,
        schema, and asset in it, earlier versions included. Only an organization&rsquo;s owners and
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
