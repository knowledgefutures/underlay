import DocsLayout, { CodeBlock } from '~/components/DocsLayout'

const nodes = `leaf:      {"e":[entry, entry, ...],"t":"leaf"}
interior:  {"e":[[lastKey, childHash, count, bytes], ...],"l":level,"t":"node"}

record tree entry:  [id, recordHash, recordSize]     key: id
file tree entry:    [fileHash, fileSize]             key: fileHash

node hash = sha256(encoded node)`

const root = `SetObject = {
  "types": { slug: { "schema": schemaHash, "root": treeHash | null, "count": n, "bytes": b } },
  "files": { "root": treeHash | null, "count": n, "bytes": b }
}
PrivateSetObject = SetObject + { "salt": 64 hex characters }

root = {
  "underlay": 2,
  "metadata": object | null,
  "public": SetObject,
  "private": sha256(JCS(PrivateSetObject)) | null
}

version hash = "ulv2:" + sha256(JCS(root))`

export default function ProtocolVersions() {
  return (
    <DocsLayout title="Trees and versions" eyebrow="Protocol v2">
      <p>
        A version holds each type&rsquo;s records in a tree, its files in another, and lists them in
        a root object. The trees are built so that the same entries always give the same tree, which
        makes a version&rsquo;s hash depend only on its content.
      </p>

      <h2 id="key-order">Key order</h2>
      <p>
        Tree keys are compared by their <strong>UTF-8 bytes</strong>, which is Unicode code point
        order. This is not JavaScript&rsquo;s default string comparison (UTF-16 code units): the two
        differ when one string has a character above U+FFFF where the other has one in
        U+E000–U+FFFF.
      </p>

      <h2 id="trees">Trees</h2>
      <p>
        A tree is a sorted set of entries with unique keys, split into nodes by the keys themselves.
        For a key <code>k</code>, let u(k) be the first 8 bytes of SHA-256(k) read as a big-endian
        integer, and tz(k) the number of its trailing zero bits.
      </p>
      <ul>
        <li>
          <strong>Leaves.</strong> Walk the entries in key order. A leaf ends after entry{' '}
          <code>k</code> when tz(k) ≥ 10, when it holds 8,192 entries, or at the last entry. Leaves
          average 1,024 entries.
        </li>
        <li>
          <strong>Interior level i.</strong> Walk the nodes of level i − 1. A node ends after a
          child whose last key has tz ≥ 10 + 6i, when it has 1,024 children, or at the last child.
          Fan-out averages 64.
        </li>
        <li>
          <strong>Root.</strong> The node of the lowest level that has exactly one node. An empty
          tree&rsquo;s root is <code>null</code>.
        </li>
      </ul>
      <p>
        Because a boundary depends only on its key, any range between two boundaries can be rebuilt
        on its own: a change touches only the leaves it falls in and the path above them, and large
        commits can build ranges in parallel.
      </p>
      <CodeBlock>{nodes}</CodeBlock>
      <p>
        Nodes are JCS with members in the order shown. <code>lastKey</code> is the last key under a
        child, <code>count</code> its number of entries and <code>bytes</code> the sum of their
        sizes. A tree is valid exactly when rebuilding its entries gives the same root; a node from
        outside must also have strictly increasing keys, children exactly one level down and totals
        that match them.
      </p>

      <h2 id="access-sets">Access sets</h2>
      <p>A version has a public set and a private set.</p>
      <ul>
        <li>
          A record pushed with <code>&quot;private&quot;: true</code>, or of a private type, is in
          the private set. Every other record is public.
        </li>
        <li>
          Each set lists its types with their schema hash and tree. A private type appears only in
          the private set; a public type with private records appears in both.
        </li>
        <li>
          A file is in every set with a record that references it. A declared file no record
          references is private unless the push marks it public.
        </li>
        <li>
          Members of the owning organization can read both sets. Everyone else reads the public set.
          Whether the collection is listed publicly is collection metadata, not part of the version.
        </li>
      </ul>
      <p>
        Privacy is declared on every push and belongs to the version: a record public in one version
        and private in the next stays readable at the version where it was public.
      </p>

      <h2 id="version-root">Version root</h2>
      <CodeBlock>{root}</CodeBlock>
      <ul>
        <li>
          <code>count</code> and <code>bytes</code> are the tree root&rsquo;s totals, or 0 for a{' '}
          <code>null</code> root.
        </li>
        <li>
          The salt is 32 random bytes, chosen once per collection and reused, so an unchanged
          private set keeps its commitment and nobody can confirm guessed private contents from it.
        </li>
        <li>
          <code>private</code> is <code>null</code> when the private set has no types and no files,
          so public-only versions with the same content have the same hash in any collection.
        </li>
        <li>
          A version hash commits to content only. Lineage, semver, messages and authorship are
          server state, recorded in the signed log.
        </li>
      </ul>
      <p>
        Public readers can verify the version hash and everything in the public set. Owners also get
        the private set object, salt included, and can check it against the commitment.
      </p>

      <h2 id="semver">Semver</h2>
      <p>
        Every node numbers versions the same way, from what changed against the version the push
        started from: <strong>major</strong> when a type was added or removed or a type&rsquo;s
        schema changed (making a type private or public changes its schema), <strong>minor</strong>{' '}
        when records were added, removed or changed (a record moving between the sets counts), and{' '}
        <strong>patch</strong> otherwise, for example a metadata edit. A push that changes nothing
        makes no version. The first version is <code>v1.0.0</code>, and semvers only increase.
      </p>
    </DocsLayout>
  )
}
