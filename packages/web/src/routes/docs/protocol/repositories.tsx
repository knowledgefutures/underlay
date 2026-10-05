import DocsLayout, { CodeBlock } from '~/components/DocsLayout'

const layout = `nodes/<nodeHash>                             encoded node, gzip
bodies/<leafHash>.ndjson.gz                  the body of a record leaf
records/<recordHash>.json.gz                 an out-of-line record, gzip
schemas/<schemaHash>.json                    JCS(schema)
roots/<hex>.json                             JCS(root); <hex> is the version hash without "ulv2:"
private/<commitment>.json                    JCS(PrivateSetObject), where private sets are held
files/<fileHash>                             file bytes
collections/<collectionId>/collection.json   collection description
collections/<collectionId>/log/<seq>.json    version log entry
collections/<collectionId>/head.json         log head`

const entry = `entry = {"actorId","appId","baseSemver","collectionId","createdAt","keyId",
         "message","prev","semver","seq","sig","versionHash"}

sig        = base64url(Ed25519 signature over JCS(entry without sig)), no padding
keyId      = first 16 hex characters of SHA-256(raw public key)
entry hash = SHA-256(JCS(entry)), sig included
prev       = entry hash of seq − 1, or null for seq 1
head.json  = JCS({"entryHash","seq","versionHash"}) of the latest entry`

const reads = `GET  <collection>/log?after=<seq>&limit=<n>
     200 {"collection": collection.json | null, "head": head.json | null, "entries": [entry, ...]}

GET  <collection>/versions/<v>/pack?base=<v>&sets=public|all
     200 application/x-tar; x-underlay-version, x-underlay-base, x-underlay-sets

GET  <collection>/versions/<v>/manifest?cursor=<c>&limit=<n>
     200 {"semver", "hash", "schemas": {slug: schemaHash},
          "records": [{"id", "type", "hash", "private"?}],
          "pagination": {"limit", "hasMore", "nextCursor"}}

GET  <collection>/files/<fileHash>     the bytes, or a redirect to them
HEAD <collection>/files/<fileHash>     content-length

<v>: a semver (leading "v" optional), a version hash (ulv2:<hex>), or latest.
     A hash that names several versions (a reverted change repeats one) selects the latest.`

export default function ProtocolRepositories() {
  return (
    <DocsLayout title="Repositories" eyebrow="Protocol v2 · §§11–11.3">
      <h2 id="layout">Layout</h2>
      <p>
        A repository is the representation of collections in a storage location. The layout is
        identical in a server&rsquo;s own storage and in a mirror. Keys are relative to the
        location&rsquo;s prefix.
      </p>
      <CodeBlock>{layout}</CodeBlock>
      <ul>
        <li>
          <strong>Bodies.</strong> One line per entry of the leaf, in entry order, each terminated
          by <code>\n</code>: the record&rsquo;s canonical form, or a pointer{' '}
          <code>{'{"$ref":"<recordHash>"}'}</code> to <code>records/</code>. A body is one or more
          concatenated gzip members; readers MUST accept any number.
        </li>
        <li>
          <strong>Immutability.</strong> Objects outside <code>collections/</code> MUST NOT change
          once written. A reader that does not trust a location MUST verify each object against its
          hash, and body lines against the leaf&rsquo;s entries, before use.
        </li>
        <li>
          <strong>Write order.</strong> A writer MUST write every object a version reaches (leaves
          and bodies, interior nodes, the PrivateSetObject and root) before the log entry, and the
          log entry before <code>head.json</code>.
        </li>
        <li>
          <strong>Self-containment.</strong> No object refers to another location. Readers MUST
          ignore keys outside the layout.
        </li>
      </ul>

      <h2 id="version-log">Version log</h2>
      <p>Each collection has one signed log entry per version.</p>
      <CodeBlock>{entry}</CodeBlock>
      <ul>
        <li>
          <code>collectionId</code> is signed, so that an entry or log cannot be presented as
          another collection&rsquo;s.
        </li>
        <li>
          <code>createdAt</code> is ISO 8601 UTC. <code>appId</code>, <code>actorId</code>,{' '}
          <code>baseSemver</code> and <code>message</code> MAY be <code>null</code>; writers SHOULD
          write <code>actorId</code> as <code>null</code>.
        </li>
        <li>
          <code>collection.json</code> holds the collection&rsquo;s <code>id</code>,{' '}
          <code>owner</code>, <code>slug</code>, <code>name</code> and <code>keys</code>, an array
          of <code>{'{"id", "alg": "Ed25519", "publicKey"}'}</code>. It is neither hashed nor
          signed; readers MUST NOT depend on its serialization.
        </li>
        <li>A verifier MUST use a key only under the id derived from it.</li>
      </ul>
      <p>
        A log is valid if and only if every entry from 1 to <code>head.seq</code> is present, each
        names the collection being read, each <code>prev</code> chains, each signature verifies
        under a trusted key, and <code>head.entryHash</code> and <code>head.versionHash</code> equal
        the last entry&rsquo;s. Which keys are trusted is not yet specified.
      </p>

      <h2 id="packs">Packs</h2>
      <p>
        A version is transferred as a <strong>pack</strong>: the objects it reaches that the
        receiver&rsquo;s base version does not, under their repository keys, as an uncompressed
        POSIX tar (PAX headers for names over 100 bytes). File bytes and <code>collections/</code>{' '}
        objects are not carried. Order:
      </p>
      <ol>
        <li>the schemas the base lacks;</li>
        <li>
          for each set sent, public first: for each record tree, the tree nodes not at the same
          position in the base&rsquo;s tree of that type, parents before children, and after each
          new leaf the out-of-line records its body points to, then its body; then the new tree
          nodes of the set&rsquo;s file tree;
        </li>
        <li>the PrivateSetObject, if the private set is sent;</li>
        <li>the root.</li>
      </ol>
      <p>
        A receiver MUST NOT depend on any other order than leaf before body, out-of-line records
        before the body that points to them, and the root last.
      </p>
      <p>
        A receiver MUST verify each object against its key before writing it, MUST re-derive every
        received tree by merging the entry changes into its base tree and obtain exactly the
        received root, count and bytes, MUST write the root last, and MUST refuse a pack that fails
        any check. Packs are pull-only: a server MUST NOT accept them from clients.
      </p>

      <h2 id="serving-over-http">Serving over HTTP</h2>
      <p>
        A server serves each collection under a <strong>collection URL</strong>, an absolute URL
        without a trailing slash whose form is the server&rsquo;s choice. On underlay.org it is{' '}
        <code>https://www.underlay.org/api/collections/&lt;owner&gt;/&lt;slug&gt;</code>. A server
        MUST provide these reads:
      </p>
      <CodeBlock>{reads}</CodeBlock>
      <ul>
        <li>
          <strong>Log.</strong> Entries with <code>seq</code> greater than <code>after</code>{' '}
          (default 0), ascending. A server MAY return fewer than <code>limit</code>; the client
          repeats from the last <code>seq</code> received until <code>head.seq</code>.
        </li>
        <li>
          <strong>Pack.</strong> Without <code>base</code>, every object the version reaches.{' '}
          <code>sets</code> defaults to <code>public</code>.
        </li>
        <li>
          <strong>Manifest.</strong> Records in order of type, then id. A caller who cannot read the
          private set receives the public set only. Cursors are opaque; a server MAY cap{' '}
          <code>limit</code>.
        </li>
        <li>
          <strong>Files.</strong> <code>&lt;fileHash&gt;</code> MAY carry a <code>sha256:</code>{' '}
          prefix. A server MUST serve a file only to a caller who may read a set that holds it.
        </li>
      </ul>
      <p>
        Errors carry <code>{'{"error": <message>}'}</code>. <code>404</code>: the collection,
        version, base or file does not exist or may not be read; a server MUST NOT distinguish
        these. <code>403</code>: <code>sets=all</code> without access to the private set.{' '}
        <code>400</code>: an invalid <code>sets</code>. <code>451</code>: a file the caller could
        otherwise read, withheld for legal reasons (a file the caller may not read is a{' '}
        <code>404</code>). Authentication is the server&rsquo;s choice; a server without access
        control MUST serve public sets only.
      </p>
      <p>
        A client MUST NOT trust a server&rsquo;s responses: it verifies the log, receives packs
        under the rules above, and verifies files against their hash. The manifest is not verifiable
        on its own.
      </p>
    </DocsLayout>
  )
}
