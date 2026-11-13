import { Link } from 'react-router'

import DocsLayout, { CodeBlock } from '~/components/DocsLayout'

const layoutFile = `{"underlay": 3, "collection": collection id, "number": n, "through": commit number,
 "createdAt": ISO 8601 UTC,
 "files": [{"id", "labeled", "first", "last", "commits": [lowest, highest],
            "entries", "records", "removals", "bytes"}, …]}`

const storage = `uploads/<session>/<file id>            an upload's files, until its commit checks and installs them
records/<file id>                      sorted-record-files, shared by the collections naming them
assets/<sha256>                        assets, shared the same way
collections/<id>/collection.json
collections/<id>/commits/<number, 16 digits>.json
collections/<id>/layouts/<number, 16 digits>.json
collections/<id>/latest.json           a hint to the newest commit, may be stale
collections/<id>/latest-layout.json    a hint to the newest layout, may be stale
tmp/                                   files being written, before their id is known
trash/records/, trash/assets/          objects the sweep removed, kept for a while
sweep/                                 the sweep's own state`

export default function ProtocolRepositories() {
  return (
    <DocsLayout title="Layouts and collections" eyebrow="Protocol v3 · §§5, 7–9">
      <h2 id="layout-files">Layout files</h2>
      <p>A layout file is the JCS of:</p>
      <CodeBlock>{layoutFile}</CodeBlock>
      <ul>
        <li>
          The files together hold each row written by commits 1 to <code>through</code> that some
          retained version can see. Which versions are retained is the server&rsquo;s choice. A
          layout that no longer holds all versions states which it holds in <code>retained</code>: a
          list of <code>[lowest, highest]</code> ranges of commit numbers, in order. Without it all
          versions are retained.
        </li>
        <li>
          A labeled file&rsquo;s <code>commits</code> is its footer&rsquo;s. An unlabeled file in a
          layout has <code>commits</code> <code>[c, c]</code>: all its rows count as written by{' '}
          <code>c</code>.
        </li>
        <li>
          A layout MAY carry other members for the server&rsquo;s own use, on itself or on a file. A
          reader ignores those it does not know, so such a member never changes what a version reads
          as. A reader MUST refuse a layout whose <code>underlay</code> number it does not know; a
          member that changes how the listed files are read comes with a new number.
        </li>
        <li>
          A layout with number <code>n</code> exists only once, and is created only if absent. The
          layout with the highest number is current. Each layout is complete; earlier ones are not
          needed.
        </li>
      </ul>
      <p>
        A version is read from the current layout and the commits after its <code>through</code>{' '}
        (see <Link to="/docs/protocol/versions#reading-a-version">Reading a version</Link>).
      </p>

      <h2 id="rebuilds">Rebuilds</h2>
      <p>
        A rebuild takes files the current layout or later commits name, writes labeled files that
        hold their rows, then creates the next layout. A layout MAY also list a commit&rsquo;s files
        as they are. A rebuild MUST preserve each retained version: each reads the same before and
        after.
      </p>
      <ul>
        <li>
          <strong>Thinning.</strong> An entry with commit <code>c</code> is seen by versions{' '}
          <code>c</code> up to, but not including, the commit of the next entry for its key. A
          rebuild MAY drop an entry that no retained version sees. It MAY drop a removal that would
          then be the oldest entry for its key only if the removal&rsquo;s commit is before the
          oldest retained version, and no file it leaves out can hold an older entry for that key.
        </li>
        <li>
          <strong>Takedown.</strong> A rebuild MAY replace a record entry by a{' '}
          <code>&quot;w&quot;</code> entry with the same hash, size, and commit, and leave out its
          line. Each file holding the row has to be rebuilt for the bytes to be gone; a file that
          does not hold it can stay listed as it is.
        </li>
      </ul>
      <p>
        Because a file&rsquo;s content depends only on its lines and entries, the files a commit
        named can be recreated from rebuilt files that still hold all of the commit&rsquo;s rows:
        take the entries labeled with its number, in key order, drop the labels, cut them at the{' '}
        <code>first</code> keys the commit recorded, and write each part as a sorted-record-file.
        The results have the ids the commit recorded. A commit with a row that was thinned or
        withheld cannot be recreated in full.
      </p>

      <h2 id="collections">Collections</h2>
      <p>A collection is:</p>
      <ul>
        <li>
          a description: a JSON object with at least <code>id</code>; for a fork, where it was
          forked from (<code>forkedFrom</code>: collection id, commit number, version id) and its{' '}
          <code>lineage</code>: the collections whose ids its earlier commits carry, oldest first,
          each with the last commit number that carries it;
        </li>
        <li>its commits, numbered from 1 with no gaps;</li>
        <li>its layouts;</li>
        <li>the sorted-record-files and assets those name.</li>
      </ul>
      <p>
        A collection names files and assets by id only. It never refers to another
        collection&rsquo;s commits or layouts. A fork begins as a copy of another collection&rsquo;s
        commits up to the fork point, and of its current layout; those commits carry the ids of the
        collections they were made in and are valid under <code>lineage</code>. The fork point is at
        or after the copied layout&rsquo;s <code>through</code>, since labeled files may hold rows
        of all commits up to it.
      </p>
      <p>
        So a fork keeps its parent&rsquo;s history: its versions up to the fork point have the
        parent&rsquo;s version ids and semvers. Who may read a collection is outside the protocol.
        On underlay.org a collection is public or private as a whole, and a fork is created private.
      </p>

      <h2 id="reference-server-storage">Reference server storage</h2>
      <p>
        Informative. These are the choices of the reference server, which runs underlay.org. They
        are not part of the protocol.
      </p>
      <CodeBlock>{storage}</CodeBlock>
      <ul>
        <li>
          <strong>Creating.</strong> Commits and layouts are created with a put that fails if the
          key exists. Nothing else decides a race.
        </li>
        <li>
          <strong>Landing.</strong> The server lands a collection&rsquo;s commits one at a time,
          each against the head it was prepared for, since its counts and schema checks were made
          against that head. A change whose head has moved is not committed at the next free number:
          a push session is refused, and the client pushes again.
        </li>
        <li>
          <strong>Changes are unsigned.</strong> The server keeps no authors&rsquo; keys: it records
          who pushed in its catalog and signs the commit. It refuses a change sent with a{' '}
          <code>keyId</code> and <code>sig</code>, since it could not check them.
        </li>
        <li>
          <strong>Hints.</strong> <code>latest.json</code> is <code>{'{"commit": n}'}</code>,
          overwritten after each commit; <code>latest-layout.json</code> is{' '}
          <code>{'{"layout": m}'}</code>, overwritten after each layout. A reader starts from them
          and probes upward; without them, a reader probes from 1. A failed write of either is
          ignored.
        </li>
        <li>
          <strong>Old layout files are deleted.</strong> The server keeps the two newest, and
          deletes the rest only once the layout hint names the newest. A reader whose hinted layout
          is gone reads the hint again and, if that names none either, lists the layouts.
        </li>
        <li>
          <strong>Stored once.</strong> A file is stored once, whatever number of collections name
          it, and so is an asset. An upload always sends its files&rsquo; bytes into its own
          session; the commit checks them where the uploader cannot write and installs them from
          there. A file already stored under that id is left as it is, and the uploader is not told.
          An asset&rsquo;s bytes are sent to a collection through the file routes, apart from the
          upload, and copied in when a commit first names it.
        </li>
        <li>
          <strong>Rebuild policy.</strong> Each layout file carries <code>size</code>, the
          file&rsquo;s stored bytes, and <code>group</code>, a number shared by the files one merge
          wrote (0 for a commit&rsquo;s own files). A group&rsquo;s files have key ranges that
          don&rsquo;t overlap, so a read checks one file per group. Size tiers are a factor of 10
          apart, the lowest up to 8 MiB of lines. Where 10 or more neighboring groups are each at or
          below a tier, and together are at least twice the largest of them, they are merged. With
          nothing to merge, a layout is still written once 8 commits have landed since the last. Up
          to 4 rounds of merging follow one commit.
        </li>
        <li>
          <strong>Where files are cut.</strong> The server cuts a file after a key picked by a hash
          of the key, toward 512 MiB of lines a file; at a cap of four times that, or 524,288
          entries (262,144 in a rebuild); and where the type changes once the file holds 16 MiB. So
          the same rows give the same files on any machine, and a row added changes the file it
          falls in and no other. The protocol says nothing about how large a file is or where it is
          cut, and a server accepts any cut.
        </li>
        <li>
          <strong>Retention and takedowns.</strong> The server retains all versions and does not
          thin. A takedown leaves the record out of reads by its hash; rebuilds do not yet withhold
          lines.
        </li>
        <li>
          <strong>Sweep.</strong> A file is listed if a collection&rsquo;s current layout, or a
          commit after that layout&rsquo;s <code>through</code>, names it. An asset is listed if a{' '}
          <code>$asset</code> entry in a listed file names it. A sweep pass condemns what nothing
          lists, moves to <code>trash/</code> what has stayed unlisted for a day, moves back
          anything in <code>trash/</code> that is listed again, and deletes what has been in{' '}
          <code>trash/</code> for seven days. An object&rsquo;s age alone is never the test.
        </li>
        <li>
          <strong>Mirrors.</strong> Copies of a collection in another storage location are not
          available yet.
        </li>
      </ul>
    </DocsLayout>
  )
}
