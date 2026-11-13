import { Link } from 'react-router'

import DocsLayout from '~/components/DocsLayout'

export default function ProtocolOverview() {
  return (
    <DocsLayout title="The Underlay protocol" eyebrow="Protocol v3 · Draft">
      <p>
        Version 3 of the Underlay protocol defines four things: the{' '}
        <strong>sorted-record-file</strong>, which holds records in key order; the{' '}
        <strong>commit</strong>, which names the files one upload added; the{' '}
        <strong>layout file</strong>, which lists the files that hold a collection after a rebuild;
        and the <strong>collection</strong> that holds them. A collection is a log of numbered
        commits, and a version is the log up to one commit.
      </p>
      <p>
        It does not define how a server keeps these objects, when it rebuilds, whether it stores
        identical files once, who may read a collection, or how it bills. Those are choices of each
        server. Records, canonical JSON, the input rules, key order, and schemas are those of
        version 2 unless version 3 changes them.
      </p>
      <p>
        These pages restate the specification, <code>docs/protocol-v3.md</code>, section by section.
        It is a draft: values and formats may still change, and a change to the file format changes
        file ids. Where these pages and the specification differ, the specification is
        authoritative.
      </p>
      <p>
        Collections on underlay.org moved from protocol v2 to v3 on 2026-11-13. Their versions kept
        their semvers, and their old <code>ulv2:</code> version ids still resolve wherever the API
        takes a version id. Responses give the <code>ulv3:</code> id.
      </p>

      <h2 id="conformance">Conformance</h2>
      <p>
        The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be interpreted as described
        in BCP 14 (<a href="https://www.rfc-editor.org/rfc/rfc2119">RFC 2119</a>,{' '}
        <a href="https://www.rfc-editor.org/rfc/rfc8174">RFC 8174</a>) when they appear in all
        capitals. Notes, examples, and sections marked informative are not normative.
      </p>
      <p>
        A conforming writer produces, from the same lines and entries, the same footer content and
        so the same file id, whatever compressor, compression level, or write buffering it uses. A
        conforming reader accepts and refuses the same files, commits, and layouts as the
        specification. Version ids rest on commits and on the unlabeled files they name. A change to
        a line, an unlabeled file, or a commit means a second format beside the first.
      </p>

      <h2 id="terminology">Terminology</h2>
      <ul>
        <li>
          <strong>Record</strong>: an <code>id</code>, a <code>type</code>, and <code>data</code>{' '}
          (any JSON value). Its <strong>key</strong> is (type, id).
        </li>
        <li>
          <strong>Key order</strong>: by type, then by id, each compared as UTF-8 bytes.
        </li>
        <li>
          <strong>Sorted-record-file</strong>: an immutable file of record lines in key order with a
          table of contents, named by its <strong>file id</strong>.
        </li>
        <li>
          <strong>Commit</strong>: a numbered object naming the sorted-record-files one upload
          added.
        </li>
        <li>
          <strong>Version</strong>: the commits of a collection up to and including one commit. Its{' '}
          <strong>version id</strong> is <code>ulv3:</code> followed by the SHA-256 of that
          commit&rsquo;s bytes.
        </li>
        <li>
          <strong>Rebuild</strong>: writing new sorted-record-files that hold the rows of older
          ones.
        </li>
        <li>
          <strong>Layout file</strong>: a numbered object, written by a rebuild, listing the
          sorted-record-files that hold everything through a commit.
        </li>
        <li>
          <strong>Asset</strong>: a byte string named by its SHA-256.
        </li>
        <li>
          <strong>Collection</strong>: a description, its commits, its layouts, and the files and
          assets those name.
        </li>
        <li>
          <strong>Server</strong>: an HTTP service that keeps collections, serves them, and accepts
          uploads. It creates commits and layouts.
        </li>
      </ul>

      <h2 id="properties">Properties</h2>
      <p>Informative. The rules have these consequences:</p>
      <ul>
        <li>
          A sorted-record-file depends only on its rows, so the same rows give the same file id on
          any machine.
        </li>
        <li>
          Creating a commit reads only the commit before it, so it costs the same whatever the
          collection holds. Checking an upload reads the schema rows it touches, and the records of
          a type whose schema it tightens.
        </li>
        <li>
          A version id rests on its commit, and through <code>previous</code> on the commits before
          it and the files they name. Layout files and rebuilt files carry no version id, so a
          server can rebuild without changing any version.
        </li>
        <li>
          A reader checks what it reads against the id that names it: a footer against the file id,
          a key block against the footer, a line against its entry.
        </li>
        <li>
          Who may read a collection is not part of the protocol. On underlay.org a collection is
          public or private as a whole: there are no private records and no private types.
        </li>
      </ul>
      <p>
        Version 3 has no single hash over a version&rsquo;s records (a content root) and no proof
        that a record is in a version. Neither is available yet.
      </p>

      <h2 id="contents">Contents</h2>
      <ul>
        <li>
          <Link to="/docs/protocol/records">Records and schemas</Link> (§2; v2 §§2–5, 7): canonical
          JSON, input rules, record and removal lines, reserved types, key order, schemas,
          validation, and assets.
        </li>
        <li>
          <Link to="/docs/protocol/versions">Files and versions</Link> (§§3, 4, 6): the
          sorted-record-file, commits, version ids, base, signatures, naming a file, semver, and
          reading a version.
        </li>
        <li>
          <Link to="/docs/protocol/repositories">Layouts and collections</Link> (§§5, 7–9): layout
          files, rebuilds, collections and forks, and the reference server&rsquo;s storage.
        </li>
        <li>
          <Link to="/docs/protocol/push-and-pull">Push and pull</Link>: how a commit is made on
          underlay.org through the HTTP API today, how to read a version back, errors, and security
          considerations.
        </li>
      </ul>

      <h2 id="not-available-yet">Not available yet</h2>
      <ul>
        <li>
          Copying a collection by its log and packs: <code>GET …/log</code> and{' '}
          <code>GET …/versions/:v/pack</code> answer <code>501</code> with code{' '}
          <code>not_on_v3</code>.
        </li>
        <li>
          Uploads of sorted-record-files built by a client. Today the server builds the files from a
          push session.
        </li>
        <li>A command-line client.</li>
        <li>Mirrors of a collection to another storage location.</li>
        <li>Content roots and inclusion proofs.</li>
      </ul>

      <h2 id="reference">Reference</h2>
      <p>
        Specification: <code>docs/protocol-v3.md</code> in the{' '}
        <a href="https://github.com/knowledgefutures/underlay">Underlay repository</a>. Reference
        implementation: <code>packages/protocol/src/v3/</code> in the same repository, which runs in
        Node and Cloudflare Workers. It is not published to npm. Test vectors:{' '}
        <code>packages/protocol/test/vectors/v3-files.json</code> and <code>v3-commits.json</code>.
        The protocol is stewarded by{' '}
        <a href="https://www.knowledgefutures.org">Knowledge Futures</a>.
      </p>
    </DocsLayout>
  )
}
