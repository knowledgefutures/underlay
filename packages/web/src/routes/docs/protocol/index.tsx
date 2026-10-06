import { Link } from 'react-router'

import DocsLayout from '~/components/DocsLayout'

export default function ProtocolOverview() {
  return (
    <DocsLayout title="The Underlay protocol" eyebrow="Protocol v2 · Stable, frozen 2026-10-03">
      <p>
        Version 2 of the Underlay protocol specifies the canonical encoding and hashing of records,
        schemas and files; the input rules published data must satisfy; the construction of record
        and file trees; the version root and its hash; the repository layout in which collections
        are stored; the signed version log; the pack format by which versions are copied; and the
        HTTP interface by which servers serve and accept versions.
      </p>
      <p>
        These pages restate the normative specification, <code>docs/protocol-v2.md</code>, section
        by section. Where they differ, the specification is authoritative.
      </p>

      <h2 id="conformance">Conformance</h2>
      <p>
        The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be interpreted as described
        in BCP 14 (<a href="https://www.rfc-editor.org/rfc/rfc2119">RFC 2119</a>,{' '}
        <a href="https://www.rfc-editor.org/rfc/rfc8174">RFC 8174</a>) when they appear in all
        capitals. Notes and examples are informative.
      </p>
      <p>
        A conforming implementation accepts and rejects the same inputs, builds the same trees and
        computes the same hashes as the specification, byte for byte. A change to any rule that
        alters what is accepted, how a tree is built or what is hashed requires a new protocol
        version.
      </p>

      <h2 id="terminology">Terminology</h2>
      <ul>
        <li>
          <strong>Collection</strong>: a named sequence of versions, identified by a collection id.
        </li>
        <li>
          <strong>Record</strong>: an <code>id</code>, a <code>type</code> and a JSON value{' '}
          <code>data</code>.
        </li>
        <li>
          <strong>Type</strong>: a named class of records, described by a <strong>schema</strong>{' '}
          (JSON Schema draft-07).
        </li>
        <li>
          <strong>File</strong>: a byte string, identified by its SHA-256 hash.
        </li>
        <li>
          <strong>Access set</strong>: one of a version&rsquo;s two partitions, <code>public</code>{' '}
          and <code>private</code>.
        </li>
        <li>
          <strong>Tree</strong>: a sorted set of entries partitioned into tree nodes by their keys.
        </li>
        <li>
          <strong>Version</strong>: an immutable state of a collection, described by a root
          document. Its <strong>version hash</strong> is <code>ulv2:</code> followed by the SHA-256
          of the root.
        </li>
        <li>
          <strong>Repository</strong>: the objects that represent collections in a storage location.
        </li>
        <li>
          <strong>Server</strong> (also <em>Underlay node</em>): an HTTP service that serves
          collections and may accept publications.
        </li>
        <li>
          <strong>Owner</strong>: a party permitted to read a collection&rsquo;s private set, as
          determined by the server.
        </li>
      </ul>

      <h2 id="properties">Properties</h2>
      <p>Informative. The rules below have these consequences:</p>
      <ul>
        <li>
          A tree depends only on its entries, not on the order of construction, so identical content
          yields an identical version hash.
        </li>
        <li>
          Every object is verifiable against the hash that names it, and a version&rsquo;s public
          content against its version hash.
        </li>
        <li>
          A reader of the public set learns of the private set only whether it exists; the private
          set is committed to with a per-collection salt.
        </li>
        <li>
          Publication, comparison and transfer cost in proportion to what changed, since unchanged
          subtrees are shared by hash.
        </li>
        <li>
          Each collection&rsquo;s versions are recorded in a signed, hash-chained log, so a copy of
          its repository in any location can be verified independently of the server that wrote it.
        </li>
      </ul>

      <h2 id="contents">Contents</h2>
      <ul>
        <li>
          <Link to="/docs/protocol/records">Records and schemas</Link> (§§2–6): canonical JSON,
          input rules, record and schema hashes, the validation dialect, files.
        </li>
        <li>
          <Link to="/docs/protocol/versions">Trees and versions</Link> (§§7–10): key order, tree
          construction and encoding, access sets, the version root, semver.
        </li>
        <li>
          <Link to="/docs/protocol/repositories">Repositories</Link> (§§11–11.3): the repository
          layout, the version log, packs, and the HTTP reads every server provides.
        </li>
        <li>
          <Link to="/docs/protocol/push-and-pull">Push and pull</Link> (§11.4, §13): delta push,
          errors, and security considerations.
        </li>
      </ul>

      <h2 id="reference">Reference</h2>
      <p>
        Specification: <code>docs/protocol-v2.md</code> in the{' '}
        <a href="https://github.com/knowledgefutures/underlay">Underlay repository</a>. Reference
        implementation: <code>@underlay/protocol</code> (<code>packages/protocol</code>), which runs
        in Node, Cloudflare Workers and browsers. Test vectors:{' '}
        <code>packages/protocol/test/vectors/v2.json</code>. The protocol is stewarded by{' '}
        <a href="https://www.knowledgefutures.org">Knowledge Futures</a>.
      </p>
    </DocsLayout>
  )
}
