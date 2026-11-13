import { Link } from 'react-router'

import DocsLayout, { CodeBlock } from '~/components/DocsLayout'

const fileShape = `[record block]… [key block]… [footer] [trailer]

entry, in a file from an upload:  [kind, type, id, hash, size, block, offset]
entry, in a rebuilt file:         [kind, type, id, hash, size, block, offset, commit]`

const footer = `{"content": {
   "underlay": 3,
   "labeled": boolean,
   "entries": n, "lines": n, "records": n, "removals": n, "withheld": n,
   "bytes": total uncompressed size of the record blocks,
   "first": [type, id] | null, "last": [type, id] | null,
   "commits": [lowest, highest] | null,
   "keyBlocks": [[type, id, hash, entries], …]
 },
 "locator": {
   "recordBlocks": [compressed length, …],
   "keyBlocks": [compressed length, …]
 }}

file id = SHA-256(JCS(content)), lowercase hex
trailer = 55 4C 33 53 52 46 0A 00 ("UL3SRF\\n\\0"), then the footer's compressed
          length as an unsigned 64-bit big-endian integer: 16 bytes`

const commit = `{"underlay": 3,
 "collection": collection id,
 "number": n,                       1 for the first commit
 "previous": version id | null,     of commit n − 1
 "semver": "v1.0.0",
 "createdAt": ISO 8601 UTC,
 "changes": [{"collection": collection id,
              "files": [{"id", "first", "last", "entries", "records", "removals", "bytes"}, …],
              "base": version id | null,
              "message": string | null,
              "keyId": string | null, "sig": string | null}, …],
 "keyId": string | null, "sig": string | null}

version id = "ulv3:" + SHA-256(JCS(commit)), lowercase hex`

export default function ProtocolVersions() {
  return (
    <DocsLayout title="Files and versions" eyebrow="Protocol v3 · §§3, 4, 6">
      <h2 id="sorted-record-files">Sorted-record-files</h2>
      <p>
        A sorted-record-file holds <Link to="/docs/protocol/records#records-and-lines">lines</Link>{' '}
        in key order and a table of contents. Each block and the footer is one gzip member (RFC
        1952). A reader MUST accept any valid gzip member. Nothing that is hashed depends on
        compressed bytes.
      </p>
      <CodeBlock>{fileShape}</CodeBlock>
      <ul>
        <li>
          <strong>Record blocks.</strong> The file&rsquo;s lines, in order, cut into blocks. A block
          closes after the first line that brings its uncompressed size (lines and their{' '}
          <code>\n</code>) to 262,144 bytes or more. The last block closes at the last line. A file
          with no lines has no record blocks.
        </li>
        <li>
          <strong>Key blocks.</strong> The entries, in order, cut into blocks of 1,024 entries; the
          last block holds the rest. A key block&rsquo;s uncompressed bytes are its entries, each as
          JCS followed by <code>\n</code>.
        </li>
        <li>A file holds at most 1,048,576 entries.</li>
      </ul>

      <h2 id="entries">Entries</h2>
      <p>Each line has one or more entries.</p>
      <ul>
        <li>
          <code>kind</code> is <code>&quot;r&quot;</code> for a record line,{' '}
          <code>&quot;x&quot;</code> for a removal line, and <code>&quot;w&quot;</code> for a record
          whose line is withheld (a takedown).
        </li>
        <li>
          <code>hash</code> is the line&rsquo;s hash, or <code>null</code> for a removal.{' '}
          <code>size</code> is the line&rsquo;s size.
        </li>
        <li>
          <code>block</code> is the number of the record block holding the line, from 0.{' '}
          <code>offset</code> is the byte offset of the line within that block&rsquo;s uncompressed
          bytes. Both are <code>null</code> for <code>&quot;w&quot;</code>, which has no line in the
          file.
        </li>
        <li>
          <code>commit</code> is the number of the commit that wrote the row.
        </li>
      </ul>
      <p>
        A file is <strong>labeled</strong> if its entries carry <code>commit</code>, and{' '}
        <strong>unlabeled</strong> otherwise. All entries of a file are one or the other, and{' '}
        <code>&quot;w&quot;</code> entries appear only in labeled files. Entries are in key order;
        in a labeled file, entries with the same key are in ascending <code>commit</code> order, and
        no two have the same <code>commit</code>. In an unlabeled file keys are unique.
      </p>
      <p>
        Lines are in the order of their first entry. In a labeled file, consecutive entries with the
        same key, the same <code>kind</code>, and the same <code>hash</code> (a row rewritten
        unchanged) share one line: they have the same <code>block</code>, <code>offset</code>, and{' '}
        <code>size</code>. No other entries share a line. Sharing is a rule, not a choice, so that
        the entries alone decide the lines.
      </p>

      <h2 id="footer-and-file-id">Footer and file id</h2>
      <p>The footer&rsquo;s uncompressed bytes are the JCS of:</p>
      <CodeBlock>{footer}</CodeBlock>
      <ul>
        <li>
          <code>keyBlocks</code> lists, for each key block, the key of its first entry, the SHA-256
          of its uncompressed bytes, and its number of entries.
        </li>
        <li>
          <code>records</code>, <code>removals</code>, and <code>withheld</code> count entries of
          each kind; <code>lines</code> counts lines. <code>first</code> and <code>last</code> are
          the keys of the first and last entries, <code>null</code> in an empty file.{' '}
          <code>commits</code> is <code>null</code> in an unlabeled file.
        </li>
        <li>
          The locator gives each block&rsquo;s compressed length in file order. Record blocks start
          at byte 0, key blocks follow them, and the footer follows the key blocks.
        </li>
        <li>
          <strong>Determinism.</strong> The same lines and entries produce the same{' '}
          <code>content</code>, and so the same file id, whatever compressor, compression level, or
          write buffering is used. A writer has no choices that reach <code>content</code>.
        </li>
      </ul>

      <h2 id="validity">Validity</h2>
      <p>A file is valid if and only if:</p>
      <ul>
        <li>
          the trailer and footer parse, and the footer is the JCS of an object with exactly these
          members; it has at most 1,048,576 entries;
        </li>
        <li>the footer, each key block, and each record line is UTF-8, with no byte-order mark;</li>
        <li>
          the object&rsquo;s length is what its footer accounts for: the blocks&rsquo; stored
          lengths, the footer, and the trailer;
        </li>
        <li>a file with no entries has no blocks, and each count in its footer is zero;</li>
        <li>
          each key block&rsquo;s uncompressed bytes hash to the listed hash, hold the listed number
          of entries, and its first entry has the listed key; each key block but the last has 1,024
          entries;
        </li>
        <li>entries are in order, each is canonical JSON, with a valid type and id;</li>
        <li>
          each entry&rsquo;s line, read at (<code>block</code>, <code>offset</code>,{' '}
          <code>size</code>), is followed by <code>\n</code>; for <code>&quot;r&quot;</code> it
          hashes to <code>hash</code> and is the canonical form of a record with the entry&rsquo;s
          id and type; for <code>&quot;x&quot;</code> it is exactly the removal line for the
          entry&rsquo;s key; a <code>&quot;w&quot;</code> entry has no line;
        </li>
        <li>
          lines fill each record block exactly, in entry order, shared as above, and blocks are cut
          as above;
        </li>
        <li>
          the counts, <code>bytes</code>, <code>first</code>, <code>last</code>,{' '}
          <code>commits</code>, and <code>labeled</code> match the entries.
        </li>
      </ul>
      <p>
        A reader that does not trust where a file came from MUST check what it reads: the footer
        against the file id, a key block against the footer, a line against its entry. It SHOULD
        also bound what it reads before it has checked it, since a stored length says nothing of
        what a block inflates to. The reference reader refuses a footer over 16 MiB stored or
        inflated, and a key block over 8 MiB or with more than 1,024 lines, before parsing them.
      </p>

      <h2 id="commits">Commits</h2>
      <p>A commit is the JCS of:</p>
      <CodeBlock>{commit}</CodeBlock>
      <p>
        A commit has two parts. A <strong>change</strong> is what an author sent: the files of one
        upload, the version they were working from, and a message. The rest is what the server adds
        when the change lands: its number, the commit before it, the semver, and the time.
      </p>
      <ul>
        <li>
          The files a commit names MUST be unlabeled: files as their author built them, with no
          commit numbers inside. A server MUST refuse a change that names a labeled file. Within one
          commit their key ranges MUST NOT overlap. Each row in them counts as written by this
          commit.
        </li>
        <li>
          <code>first</code> and <code>last</code> are each file&rsquo;s first and last keys, and{' '}
          <code>bytes</code> its footer&rsquo;s <code>bytes</code>. With them the commit&rsquo;s
          rows can be cut into the same files again after a rebuild.
        </li>
        <li>
          A commit with number <code>n</code> exists only once. A writer creates it only if no
          commit <code>n</code> exists, and only if commit <code>n − 1</code> exists and has version
          id <code>previous</code>.
        </li>
        <li>
          A commit, each change, and each file entry has exactly the members shown. A writer MUST
          NOT write a commit a reader would refuse: nothing can be committed after a commit that
          cannot be read, so one would end the log.
        </li>
        <li>
          A change&rsquo;s <code>collection</code> is the commit&rsquo;s. <code>changes</code> is a
          list so that one commit can later carry several authors&rsquo; uploads. A writer today
          makes one change per commit.
        </li>
      </ul>

      <h2 id="version-id">Version id</h2>
      <p>
        A version&rsquo;s id is <code>ulv3:</code> followed by the SHA-256, in lowercase hex, of its
        commit&rsquo;s bytes. Version ids and signatures rest on commits, and through them on the
        unlabeled files commits name, and on nothing else. None rests on a labeled file or a layout
        file, so how those are written can change at the cost of a rebuild.
      </p>
      <p>
        On underlay.org, the API takes a version as its semver, its <code>ulv3:</code> id, or{' '}
        <code>latest</code>. A version converted from v2 also answers to its old <code>ulv2:</code>{' '}
        id.
      </p>

      <h2 id="base">Base</h2>
      <p>
        <code>base</code> is the version id the author was working from when they prepared the
        upload, or <code>null</code>. The author sets it; the server sets <code>previous</code>. The
        two are equal unless another commit landed in between.
      </p>
      <ul>
        <li>
          The server records <code>base</code> as given. It MUST refuse a base that is not the
          version id of an earlier commit in this collection&rsquo;s log (which, for a fork,
          includes the commits of the collections it was forked from).
        </li>
        <li>
          Nothing else depends on it. A commit is never refused because of its base, and reading is
          unchanged: the newest entry wins.
        </li>
        <li>
          What it gives: for any commit, the keys it wrote that other commits changed after its base
          and up to its <code>previous</code> can be listed from key entries alone. Those are the
          changes the author had not seen.
        </li>
      </ul>

      <h2 id="signatures">Signatures</h2>
      <p>
        Both signatures are Ed25519 over the JCS of the signed object without its <code>sig</code>{' '}
        member, base64url without padding. <code>keyId</code> is the first 16 hex characters of the
        SHA-256 of the raw public key. <code>keyId</code> and <code>sig</code> are both{' '}
        <code>null</code>, or neither is.
      </p>
      <ul>
        <li>
          <strong>The author signs the change:</strong> its <code>collection</code>,{' '}
          <code>files</code>, <code>base</code>, <code>message</code>, and <code>keyId</code>. The
          signature does not cover the commit&rsquo;s <code>number</code> or <code>previous</code>.
        </li>
        <li>
          <strong>The server signs the commit:</strong> each member but its own <code>sig</code>,
          the changes and their signatures included.
        </li>
        <li>
          A change that loses the race for a number is committed at the next free number with the
          author&rsquo;s signature unchanged. Only the server&rsquo;s part is made again.
        </li>
        <li>Which keys a reader trusts, for either signature, is not part of this protocol.</li>
      </ul>
      <p>
        On underlay.org changes are unsigned. The server keeps no authors&rsquo; keys: it signs each
        commit with its own key and records who pushed in its catalog, outside the commit. It does
        not move a change to the next free number: a push whose head moved before it landed is
        refused, and the client pushes again.
      </p>

      <h2 id="naming-a-file">Naming a file</h2>
      <p>
        A server MUST NOT accept a change that names a file unless the file&rsquo;s bytes came with
        that upload and check out against the file id. That a file with the id is already stored is
        never enough: otherwise knowing an id would be a way to test whether a file exists, and then
        to read it through a collection of one&rsquo;s own. The one exception is the server&rsquo;s
        own copy of commits from a collection the caller may read, which is how a fork begins.
      </p>
      <p>
        The same holds for an asset (see <Link to="/docs/protocol/records#assets">Assets</Link>).
        The bytes a server checks MUST be the bytes it installs: an uploader who can still write
        where its upload was sent must not be able to change a file between the check and the
        install.
      </p>

      <h2 id="semver">Semver</h2>
      <p>The semver follows from what the commit changes relative to the version before it:</p>
      <ol>
        <li>
          The first commit is <code>v1.0.0</code>.
        </li>
        <li>
          If it adds, removes, or changes a <code>$schema</code> row: major, <code>v(M+1).0.0</code>
          .
        </li>
        <li>
          Otherwise, if it adds, removes, or changes a row of any non-reserved type: minor,{' '}
          <code>vM.(m+1).0</code>.
        </li>
        <li>
          Otherwise (metadata or assets only): patch, <code>vM.m.(p+1)</code>.
        </li>
      </ol>
      <p>
        A <code>$schema</code> row equal to the row it would replace (same key, same hash; or a
        removal of an absent key) is not a change, so a committer always compares schema rows with
        the version before. For other rows a committer MAY make the same comparison, and otherwise
        counts each row as a change. A commit that changes nothing SHOULD NOT be made. The reference
        server compares each row with the version before, leaves out rows that change nothing, and
        makes no commit if none is left.
      </p>

      <h2 id="reading-a-version">Reading a version</h2>
      <p>
        To read version <code>v</code> of a collection:
      </p>
      <ol>
        <li>
          Let <code>L</code> be the current{' '}
          <Link to="/docs/protocol/repositories#layout-files">layout</Link>, or none. The files are{' '}
          <code>L</code>&rsquo;s files plus the files named by commits <code>L.through + 1</code> to{' '}
          <code>v</code> (all commits 1 to <code>v</code> if there is no layout).
        </li>
        <li>
          For a key, among the entries of those files whose commit is at most <code>v</code>, the
          entry with the highest commit wins. If it is a removal, or there is none, the version has
          no record with that key. If it is withheld, the version has a record with that key and
          hash whose line the server no longer holds. Otherwise the record is the entry&rsquo;s
          line.
        </li>
      </ol>
      <p>
        If <code>v</code> is at or below <code>L.through</code> and <code>L</code> does not retain
        it, the read fails. underlay.org retains all versions.
      </p>
      <p>
        The changes between versions <code>a</code> and <code>b</code> (<code>a</code> &lt;{' '}
        <code>b</code>) are the keys with an entry whose commit is above <code>a</code> and at most{' '}
        <code>b</code>. A file whose <code>commits</code> range lies outside that is not read.
      </p>
    </DocsLayout>
  )
}
