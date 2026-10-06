import DocsLayout, { CodeBlock } from '~/components/DocsLayout'

const nodes = `leaf:      {"e":[entry, ...],"t":"leaf"}
interior:  {"e":[[lastKey, childHash, count, bytes], ...],"l":level,"t":"node"}

record tree entry:  [id, recordHash, recordSize]     key: id          size: recordSize
file tree entry:    [fileHash, fileSize]             key: fileHash    size: fileSize

node hash = SHA-256(JCS(node))`

const root = `SetObject = {
  "types": { slug: { "schema": schemaHash, "root": treeHash | null, "count": n, "bytes": b } },
  "files": { "root": treeHash | null, "count": n, "bytes": b }
}
PrivateSetObject = SetObject + { "salt": 64 hex characters }

root = {
  "underlay": 2,
  "metadata": object | null,
  "public": SetObject,
  "private": SHA-256(JCS(PrivateSetObject)) | null
}

version hash = "ulv2:" + SHA-256(JCS(root))`

export default function ProtocolVersions() {
  return (
    <DocsLayout title="Trees and versions" eyebrow="Protocol v2 · §§7–10">
      <h2 id="key-order">Key order</h2>
      <p>
        Keys are compared lexicographically by their UTF-8 encodings, octet by octet, a proper
        prefix first: Unicode code point order. Implementations MUST NOT compare UTF-16 code units
        (ECMAScript&rsquo;s default <code>&lt;</code> and <code>sort()</code>), which differ when
        one key has a character at or above U+10000 where the other has one in U+E000–U+FFFF.
      </p>
      <p>
        <strong>Boundary hash</strong> u(k): the first 8 bytes of SHA-256(k) as a big-endian
        unsigned 64-bit integer. <strong>tz(k)</strong>: the number of trailing zero bits of u(k).
      </p>

      <h2 id="trees">Trees</h2>
      <p>A tree is a set of entries with unique keys, in key order, partitioned into tree nodes.</p>
      <ul>
        <li>
          <strong>Leaves (level 0).</strong> The current leaf ends after entry <code>k</code> if
          tz(k) ≥ 10, if it holds 8,192 entries, or if <code>k</code> is the last entry.
        </li>
        <li>
          <strong>Interior level i ≥ 1.</strong> The current node ends after child <code>c</code> if
          10 + 6i ≤ 64 and tz(last key of <code>c</code>) ≥ 10 + 6i, if it has 1,024 children, or if{' '}
          <code>c</code> is the last node of level i − 1.
        </li>
        <li>
          <strong>Root.</strong> The single node of the lowest level that has exactly one node. A
          tree with one leaf has that leaf as its root; an empty tree&rsquo;s root is{' '}
          <code>null</code>.
        </li>
      </ul>
      <CodeBlock>{nodes}</CodeBlock>
      <p>
        Nodes are encoded as JCS. <code>lastKey</code> is the last key under the child,{' '}
        <code>count</code> the number of entries under it and <code>bytes</code> the sum of their
        sizes.
      </p>
      <p>
        A tree is valid if and only if building its entries under these rules yields the same root.
        A receiver of tree nodes MUST also reject a node that is not canonically encoded, whose keys
        are not strictly increasing, whose interior entries do not match their children, whose
        children are not exactly one level below it, or (in a record tree) whose keys are not valid
        record ids; and a record leaf whose body lines do not match its entries by hash, size, id
        and type.
      </p>
      <p>
        Note: a natural boundary depends only on its key, so any range between two boundaries can be
        rebuilt independently. Leaves average 1,024 entries; interior fan-out averages 64.
      </p>

      <h2 id="access-sets">Access sets</h2>
      <p>Each version has two access sets, public and private.</p>
      <ul>
        <li>
          A record published with <code>&quot;private&quot;: true</code>, and every record of a
          private type, belongs to the private set; every other record to the public set.
        </li>
        <li>
          Each set lists, per type it contains, the schema hash and the tree of that set&rsquo;s
          records of the type. A private type appears in the private set only. A public type appears
          in the public set, with a <code>null</code> root if it has no public records, and also in
          the private set if it has private records.
        </li>
        <li>
          A file belongs to each set with a record that references it. A declared file (
          <code>files.add</code>) also belongs to the private set, whether or not records reference
          it, and stays declared in later versions until removed (<code>files.remove</code>).
        </li>
        <li>
          Owners MAY read both sets; other readers the public set only. Whether a collection is
          visible to non-owners at all is collection state outside the version.
        </li>
      </ul>

      <h2 id="version-root">Version root</h2>
      <CodeBlock>{root}</CodeBlock>
      <ul>
        <li>
          <code>count</code> and <code>bytes</code> are the tree root&rsquo;s totals, or 0 for a{' '}
          <code>null</code> root.
        </li>
        <li>
          The salt is 32 random bytes in hex. A writer MUST choose it once per collection and reuse
          it for every version, so that an unchanged private set keeps its commitment.
        </li>
        <li>
          <code>private</code> is <code>null</code> if and only if the private set lists no types
          and no files.
        </li>
        <li>
          A root has no parent pointer. Lineage, semver, messages and authorship are recorded in the
          version log.
        </li>
      </ul>
      <p>
        A reader of the public set can verify the version hash and every public object, and learns
        of the private set only whether it exists. An owner also obtains the PrivateSetObject, salt
        included, and can verify it against the commitment.
      </p>

      <h2 id="semver">Semver</h2>
      <p>
        The server that commits a version MUST assign its semver from the differences against its
        base, with M, m, p the base&rsquo;s components:
      </p>
      <ol>
        <li>
          The first version is <code>v1.0.0</code>.
        </li>
        <li>
          A type added or removed, or a schema hash changed: <code>v(M+1).0.0</code>. Making a type
          private or public changes its schema. Every record of the type carried over from the base
          MUST be validated against the new schema, and the publication refused if any fails.
        </li>
        <li>
          Otherwise, any record added, removed or changed in either set, including a move between
          sets: <code>vM.(m+1).0</code>.
        </li>
        <li>
          Otherwise (metadata or file sets only): <code>vM.m.(p+1)</code>.
        </li>
      </ol>
      <p>
        A publication whose version hash equals its base&rsquo;s MUST NOT create a version. Semvers
        are unique within a collection and strictly increasing.
      </p>
    </DocsLayout>
  )
}
