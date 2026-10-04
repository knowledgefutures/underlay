import { Link } from 'react-router'

import DocsLayout from '~/components/DocsLayout'

export default function ProtocolOverview() {
  return (
    <DocsLayout title="The Underlay protocol" eyebrow="Protocol v2">
      <p>
        Underlay is a protocol for publishing versioned, structured data. Every record, schema and
        file is identified by its SHA-256 hash. A version is a set of hash trees under one root, so
        its hash commits to everything in it, and two versions that share most of their content
        share most of their storage.
      </p>

      <h2 id="primitives">Primitives</h2>
      <ul>
        <li>
          <strong>Record</strong>: an <code>id</code>, a <code>type</code> and a <code>data</code>{' '}
          payload of any JSON. Its hash is the SHA-256 of its canonical form.
        </li>
        <li>
          <strong>Schema</strong>: a JSON Schema (draft-07) document per type. Records are validated
          against it, and its hash is the SHA-256 of its canonical JSON.
        </li>
        <li>
          <strong>File</strong>: bytes, addressed by the SHA-256 of their content. Records refer to
          files with <code>{'{"$file": "sha256:…"}'}</code>.
        </li>
        <li>
          <strong>Version</strong>: a root object listing, for each type, its schema hash and the
          root of a tree of that type&rsquo;s records, plus a file tree and metadata. Its hash is{' '}
          <code>ulv2:</code> followed by the SHA-256 of the root.
        </li>
      </ul>

      <h2 id="what-it-guarantees">What it guarantees</h2>
      <ul>
        <li>
          <strong>Same content, same hash.</strong> A tree depends only on its entries, never on the
          order they were added, so a version built in one push or in many has the same hash.
        </li>
        <li>
          <strong>Verifiable without trust.</strong> A reader can check every object it fetches
          against the hash that names it, and a version&rsquo;s whole public content against its
          version hash.
        </li>
        <li>
          <strong>Privacy without leaks.</strong> Each version has a public set and an optional
          private set. Public readers can verify the public set and learn only that a private set
          exists; the private set is committed to with a per-collection salt.
        </li>
        <li>
          <strong>Cost follows change.</strong> A push, a diff or a sync costs in proportion to what
          changed, because unchanged subtrees are reused by hash.
        </li>
        <li>
          <strong>Portable history.</strong> Each collection has a signed, hash-chained log of its
          versions, so a copy of its repository in any bucket can be verified and restored.
        </li>
      </ul>

      <h2 id="in-this-section">In this section</h2>
      <ul>
        <li>
          <Link to="/docs/protocol/records">Records and schemas</Link>: canonical JSON, record and
          schema hashes, input rules, validation, file references.
        </li>
        <li>
          <Link to="/docs/protocol/versions">Trees and versions</Link>: how records become trees,
          the public and private sets, the version root and its hash, semver.
        </li>
        <li>
          <Link to="/docs/protocol/repositories">Repositories</Link>: the storage layout any bucket
          can hold, the signed version log, packs for sync, and the reads every node serves.
        </li>
        <li>
          <Link to="/docs/protocol/push-and-pull">Push and pull</Link>: the HTTP exchanges for
          writing and reading versions, and compatibility with v1 clients.
        </li>
      </ul>

      <h2 id="reference">Reference</h2>
      <p>
        The normative specification is <code>docs/protocol-v2.md</code> in the{' '}
        <a href="https://github.com/knowledgefutures/underlay">Underlay repository</a>. Another
        implementation has to reproduce it byte for byte. The reference implementation is{' '}
        <code>@underlay/protocol</code>, which runs in Node, Cloudflare Workers and browsers, and
        test vectors for every hash and tree are in <code>packages/protocol/test/vectors/</code>.
        The protocol is stewarded by{' '}
        <a href="https://www.knowledgefutures.org">Knowledge Futures</a>.
      </p>
    </DocsLayout>
  )
}
