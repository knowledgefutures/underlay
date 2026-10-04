import DocsLayout, { CodeBlock } from '~/components/DocsLayout'

const layout = `nodes/<nodeHash>                          node JSON, gzip
bodies/<leafHash>.ndjson.gz               a record leaf's records, one line per entry
records/<recordHash>.json.gz              an out-of-line record, gzip
schemas/<schemaHash>.json                 JCS(schema)
roots/<hex>.json                          JCS(root); <hex> is the version hash without "ulv2:"
private/<commitment>.json                 JCS(private set object), where private sets are held
files/<fileHash>                          file bytes
collections/<collectionId>/collection.json
collections/<collectionId>/log/<seq>.json
collections/<collectionId>/head.json`

const entry = `{"actorId","appId","baseSemver","collectionId","createdAt","keyId",
 "message","prev","semver","seq","sig","versionHash"}

sig        = base64url(Ed25519(JCS(entry without sig)))
keyId      = first 16 hex characters of sha256(raw public key)
entry hash = sha256(JCS(entry))
prev       = the entry hash of seq − 1, or null for seq 1
head.json  = JCS({"entryHash","seq","versionHash"}) of the latest entry`

export default function ProtocolRepositories() {
  return (
    <DocsLayout title="Repositories" eyebrow="Protocol v2">
      <p>
        A repository is how a bucket holds collections. The layout is the same in the
        platform&rsquo;s own storage, in a customer&rsquo;s mirror bucket and in a restore source,
        so any copy can be read, verified and restored without the server that wrote it.
      </p>

      <h2 id="layout">Layout</h2>
      <p>Keys are relative to the location&rsquo;s prefix.</p>
      <CodeBlock>{layout}</CodeBlock>
      <ul>
        <li>
          <strong>Bodies.</strong> A leaf&rsquo;s body has one line per entry, in entry order, each
          ending in <code>\n</code>. A line is the canonical record, or a pointer{' '}
          <code>{'{"$ref":"<recordHash>"}'}</code> to a record stored under <code>records/</code>.
          The body is one or more concatenated gzip members; readers must accept any number. For a
          type with no pointers, its bodies in tree order are its records as gzip NDJSON.
        </li>
        <li>
          <strong>Immutable.</strong> Everything outside <code>collections/</code> is
          content-addressed and never changes once written. A reader that doesn&rsquo;t trust the
          location checks each object against its hash: nodes, body lines against their leaf&rsquo;s
          entries, roots against the version hash.
        </li>
        <li>
          <strong>Write order.</strong> Everything a version reaches (leaves and bodies, interior
          nodes, the root and private set object), then the log entry, then <code>head.json</code>.
          A reader that finds <code>head.json</code> can read everything below it.
        </li>
        <li>
          <strong>Self-contained.</strong> Nothing in a location refers to another location, and the
          platform&rsquo;s internal data (push sessions, uploads, the reference log) is never copied
          into one. Readers ignore keys outside the layout.
        </li>
      </ul>

      <h2 id="version-log">Version log</h2>
      <p>Each collection has one signed log entry per version.</p>
      <CodeBlock>{entry}</CodeBlock>
      <ul>
        <li>
          <code>collectionId</code> is signed, so an entry or a whole log can&rsquo;t pass as
          another collection&rsquo;s. A restored collection keeps its id.
        </li>
        <li>
          Entries form a hash chain through <code>prev</code>, so a dropped, reordered or altered
          entry is detectable.
        </li>
        <li>
          <code>collection.json</code> holds the collection&rsquo;s id, owner, slug, name and
          description, and the public keys that sign its log. A verifier uses a key only under its
          own <code>keyId</code>, so a key list read from an untrusted bucket can&rsquo;t slip a
          stranger&rsquo;s key in under a trusted id.
        </li>
      </ul>
      <p>
        A log is valid when every entry from 1 to <code>head.seq</code> is present, each names the
        collection being read, each <code>prev</code> chains, each signature verifies against a
        trusted key, and <code>head.entryHash</code> is the last entry&rsquo;s hash.
      </p>

      <h2 id="sync">Sync</h2>
      <p>
        A version moves between repositories as a <strong>pack</strong>: the objects it reaches that
        the receiver&rsquo;s base version doesn&rsquo;t, as an uncompressed POSIX tar under their
        repository keys. Most objects are already gzip. File bytes travel separately.
      </p>
      <ol>
        <li>Schemas the base doesn&rsquo;t have.</li>
        <li>
          For each record tree sent, the nodes the base&rsquo;s tree of that type lacks, parents
          before children; after each new leaf, the out-of-line records its body points to, then the
          body.
        </li>
        <li>The same for each file tree (nodes only).</li>
        <li>The private set object, when the private set is sent.</li>
        <li>The root, last.</li>
      </ol>
      <p>
        The receiver checks every object against its key before writing it, then re-derives every
        tree: the changes from its base tree, merged under the tree rules, must give exactly the
        received root, count and bytes. Only then is the root written. A pack that fails any check
        is refused. Packs never carry <code>collections/</code> objects; logs are fetched on their
        own.
      </p>
      <p>
        Sync is pull-only: clients and mirrors fetch packs, and a client publishes through{' '}
        <a href="/docs/protocol/push-and-pull#delta-push">delta push</a>, so a server never accepts
        tree nodes from outside.
      </p>
    </DocsLayout>
  )
}
