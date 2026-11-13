import { Link } from 'react-router'

import DocsLayout, { CodeBlock } from '~/components/DocsLayout'

const endpoints = `POST   <collection>/push                  open a session
POST   <collection>/push/<sid>/records    upload records (NDJSON)
POST   <collection>/push/<sid>/deletes    upload deletes (NDJSON)
PUT    <collection>/files/<sha256>        upload a file
POST   <collection>/push/<sid>/commit     commit (?async=true for the background)
GET    <collection>/push/<sid>            session status
DELETE <collection>/push/<sid>            abandon the session`

const exchange = `POST <collection>/push
{"base": "v1.2.0", "schemas": {"Publication": {...}}, "metadata_patch": {"readme": "..."},
 "files": {"add": ["9f86d0..."]}, "message": "Weekly update"}
→ 200 {"session_id": "...", "base": "v1.2.0", "needed_files": ["9f86d0..."],
       "expires_at": "...", "limits": {"open_bytes": ..., "batch_bytes": ..., "batch_lines": ...,
       "session_idle_seconds": ..., "open_sessions": ..., "file_bytes": ...}}

PUT <collection>/files/9f86d0...                       (file bytes)
→ 201

POST <collection>/push/<sid>/records
{"id":"pub-004","type":"Publication","data":{"title":"Notes","pdf":{"$file":"sha256:9f86d0..."}}}
{"id":"pub-005","type":"Publication","data":{"title":"Draft"}}
→ 200 {"received": 2}

POST <collection>/push/<sid>/deletes
{"type":"Publication","id":"pub-003"}
→ 200 {"received": 1}

POST <collection>/push/<sid>/commit
→ 201 {"semver": "v1.3.0", "hash": "ulv3:...", "recordCount": 4, "fileCount": 1,
       "changes": {"added": 2, "removed": 1, "updated": 0}}
→ 202 {"session_id": "...", "status": "committing"}         (background commit)`

const openMembers: [string, string][] = [
  [
    'base',
    'The semver of the version the changes are against. If it is not the head, the server answers 409 with currentVersion. null or absent: the head at opening.',
  ],
  [
    'schemas',
    'The complete type set, type → schema. Replaces the head’s; an omitted type is removed with its records. Absent: the head’s type set.',
  ],
  ['metadata', 'Replaces the head’s metadata. An object or null.'],
  [
    'metadata_patch',
    'An object whose top-level members are merged into the head’s metadata. Ignored if metadata is present.',
  ],
  [
    'files',
    '{"add": [sha256, …], "remove": [sha256, …]}: files declared or removed beyond those records refer to.',
  ],
  ['message', 'The change’s message.'],
  ['app_id, actor_id', 'Strings the server records with the version, outside the commit.'],
  ['strip_unknown_fields', 'Boolean; see Records and deletes.'],
]

export default function ProtocolPushPull() {
  return (
    <DocsLayout title="Push and pull" eyebrow="Protocol v3 · underlay.org today">
      <h2 id="delta-push">Delta push</h2>
      <p>
        On underlay.org you make a commit through a push session: open it against the head, upload
        the records you add or change and the keys you remove, and commit. The server turns the
        session into rows, builds the sorted-record-files, and makes an unsigned change whose{' '}
        <code>base</code> is the head&rsquo;s version id. It then lands the change as the next
        commit, signs the commit, and assigns the semver (
        <Link to="/docs/protocol/versions#semver">semver rules</Link>). A push session is the only
        way to commit today: uploads of files a client builds itself are not available yet.
      </p>
      <p>
        This page describes the reference server, not the protocol. Paths are relative to the
        collection URL,{' '}
        <code>https://www.underlay.org/api/collections/&lt;owner&gt;/&lt;slug&gt;</code>. The{' '}
        <Link to="/docs/api/versions">Versions API</Link> and{' '}
        <Link to="/docs/api/files">Files API</Link> give the full request and response shapes.
      </p>
      <CodeBlock>{endpoints}</CodeBlock>

      <h3>Opening a session</h3>
      <p>The body is a JSON object; each member is optional.</p>
      <table>
        <thead>
          <tr>
            <th>Member</th>
            <th>Meaning</th>
          </tr>
        </thead>
        <tbody>
          {openMembers.map(([m, what]) => (
            <tr key={m}>
              <td>
                <code>{m}</code>
              </td>
              <td>{what}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        Each type MUST be a valid v3 type (see{' '}
        <Link to="/docs/protocol/records#reserved-types">Reserved types</Link>), and each schema
        MUST pass the <Link to="/docs/protocol/records#schemas">schema rules</Link>. A public
        collection refuses a schema with a root <code>&quot;private&quot;: true</code>.
      </p>
      <p>
        The response is 200 with <code>session_id</code>; <code>base</code> (the semver the session
        is against, or <code>null</code>); <code>needed_files</code>, the declared files the
        collection does not yet hold, which the client MUST upload before committing;{' '}
        <code>expires_at</code>, extended by each records or deletes request; and{' '}
        <code>limits</code>, by which a client sizes its requests: <code>open_bytes</code>,{' '}
        <code>batch_bytes</code>, <code>batch_lines</code>, <code>session_idle_seconds</code>,{' '}
        <code>open_sessions</code> (per user, open or committing), and <code>file_bytes</code>.
      </p>

      <h3 id="records-and-deletes">Records and deletes</h3>
      <ul>
        <li>
          <code>…/records</code> takes NDJSON record lines, <code>{'{"id", "type", "data"}'}</code>,
          and answers <code>{'{"received": n}'}</code>. Each line MUST satisfy the{' '}
          <Link to="/docs/protocol/records#input-rules">input rules</Link> and its type&rsquo;s
          schema, and its type MUST be in the session&rsquo;s type set.
        </li>
        <li>
          The envelope is v2&rsquo;s: other members are ignored, and a <code>private</code> member,
          if present, MUST be a boolean. In a public collection a line with{' '}
          <code>&quot;private&quot;: true</code> is refused (422): make the collection private, or
          push to a private collection. In a private collection the mark changes nothing.
        </li>
        <li>
          A record whose <code>data</code> has top-level members absent from its schema&rsquo;s root{' '}
          <code>properties</code> is refused, unless the session set{' '}
          <code>strip_unknown_fields</code>, in which case they are removed before hashing. A schema
          without root <code>properties</code> admits any members.
        </li>
        <li>
          If any line fails, the server answers 422 with <code>validationErrors</code>, one per
          failing line with its 1-based <code>line</code>, and stores nothing from the request. It
          may list only the first failures, with <code>totalErrors</code> giving their number.
        </li>
        <li>
          <code>…/deletes</code> takes NDJSON <code>{'{"type", "id"}'}</code> lines and answers{' '}
          <code>{'{"received": n}'}</code>. The type MUST be in the session&rsquo;s type set.
          Deleting a key the head does not hold is not an error. A request with no lines is a 400.
        </li>
        <li>
          Within a session, the later upload of a key supersedes an earlier one, record or delete.
        </li>
      </ul>

      <h3>Files</h3>
      <p>
        <code>PUT …/files/&lt;sha256&gt;</code> stores a file for the collection: 201, or 400 if the
        bytes do not hash to <code>&lt;sha256&gt;</code>. Larger files go through the upload routes
        of the <Link to="/docs/api/files">Files API</Link>. A file counts as held only if the head
        names it in a <code>$asset</code> row or it was uploaded to this collection. A file held for
        another collection is not held, and each upload is hashed, even of a file the server already
        stores.
      </p>

      <h3 id="what-a-commit-holds">What a commit holds</h3>
      <p>At commit the server builds these rows, in key order:</p>
      <ul>
        <li>
          a <code>$schema</code> row for each type whose schema the session adds or changes, and a
          removal of the <code>$schema</code> row and of each record for each type it drops;
        </li>
        <li>
          a <code>$meta</code> row if the metadata differs from the head&rsquo;s (a removal if it is
          now <code>null</code>);
        </li>
        <li>
          a <code>$asset</code> row, <code>{'{"size", "mediaType"}'}</code>, for each file the
          session declares or its records refer to that the head does not name, and a removal for
          each file in <code>files.remove</code> that the head names and the session&rsquo;s records
          do not refer to;
        </li>
        <li>the session&rsquo;s records and removals, the last upload of each key winning.</li>
      </ul>
      <p>
        Each row is compared with the head, and a row that changes nothing (the same record, or the
        removal of one that is not there) is left out. If none is left, the commit is refused with
        409 and the head&rsquo;s version id. Otherwise the semver is major if a schema changed,
        minor if a record changed, and patch for metadata or assets alone.
      </p>

      <h3>Commit</h3>
      <ul>
        <li>
          <code>…/commit</code> answers 201 with the version, or 202 when it runs in the background.
          A client MAY request the background with <code>?async=true</code>; the server chooses it
          for large commits. The client then polls <code>GET …/push/&lt;sid&gt;</code> until{' '}
          <code>status</code> is <code>committed</code> (<code>result</code> holds the 201 body) or{' '}
          <code>failed</code> (<code>error</code> holds the failure).
        </li>
        <li>
          The commit is made against the head the session opened on. If another commit landed since,
          the commit answers 409 with <code>currentVersion</code>, and the client pushes again. A
          commit body of <code>{'{"rebase": true}'}</code> commits on the head as it is now instead:
          the session&rsquo;s records and deletes apply on top of whatever landed since, and its
          schemas and metadata replace the head&rsquo;s.
        </li>
        <li>
          A commit refused because files are not held (422 with <code>filesNeeded</code>) leaves the
          session open: the client uploads the files and commits the same session again. A polling
          client sees <code>status</code> <code>open</code>, with the refusal in <code>error</code>.
        </li>
        <li>Committing a session that has already committed answers 201 with the same body.</li>
        <li>
          <code>hash</code> in the response is the new version&rsquo;s <code>ulv3:</code> id.
        </li>
      </ul>
      <CodeBlock>{exchange}</CodeBlock>

      <h2 id="clients-without-a-copy">Clients without a copy</h2>
      <p>
        Informative. A client that keeps no copy of the collection reads the head&rsquo;s manifest,{' '}
        <code>GET …/versions/latest/manifest</code>, which lists each record&rsquo;s <code>id</code>
        , <code>type</code>, and <code>hash</code> in key order. It computes the hash of each of its
        own records (the SHA-256 of the record line), uploads the records that are new or changed,
        and deletes the keys it no longer has. The upload is then proportional to the changes. If
        another commit lands first, the session or commit answers 409 and the client repeats the
        comparison against the new head.
      </p>

      <h2 id="pull">Pull</h2>
      <p>
        Copying a collection by its log and packs is not available yet: <code>GET …/log</code> and{' '}
        <code>GET …/versions/&lt;v&gt;/pack</code> answer <code>501</code> with code{' '}
        <code>not_on_v3</code>. To copy a version, read{' '}
        <code>GET …/versions/&lt;v&gt;/records.ndjson.gz</code>. To follow changes, read the
        manifest with <code>?since=&lt;version&gt;</code>, which lists the records added, updated,
        and removed after that version, or the diff between two versions (
        <Link to="/docs/api/versions">Versions API</Link>).
      </p>

      <h2 id="errors">Errors</h2>
      <p>
        Errors carry <code>{'{"error": <message>}'}</code>. Content the caller may not read is 404,
        never 403.
      </p>
      <ul>
        <li>
          <code>403</code>: the caller may read the collection but not push to it, or the session
          belongs to another user.
        </li>
        <li>
          <code>400</code>: a malformed body, a <code>metadata_patch</code> that is not an object, a{' '}
          <code>metadata</code> that is neither an object nor <code>null</code>, or a request with
          no lines.
        </li>
        <li>
          <code>409</code>: <code>base</code> is not the head (with <code>currentVersion</code>);
          the head changed before the commit; the session is not open; or the push changes nothing
          (with the head&rsquo;s <code>hash</code>).
        </li>
        <li>
          <code>413</code>: a body over <code>open_bytes</code> or <code>batch_bytes</code>, a
          request over <code>batch_lines</code>, or a file over <code>file_bytes</code>.
        </li>
        <li>
          <code>422</code>: records or deletes that fail; a refused schema or type; a private mark
          in a public collection; records carried over from the head that fail a changed schema (
          <code>validationErrors</code>); or a commit lacking files (<code>filesNeeded</code>).
        </li>
        <li>
          <code>429</code>: <code>open_sessions</code> sessions already in progress, or a rate limit
          (with <code>Retry-After</code>).
        </li>
        <li>
          <code>501</code>: a route not available for v3 collections yet (code{' '}
          <code>not_on_v3</code>).
        </li>
      </ul>

      <h2 id="security-considerations">Security considerations</h2>
      <ul>
        <li>
          A server MUST NOT accept a change that names a file or asset unless its bytes came with
          the upload or the collection already holds it (
          <Link to="/docs/protocol/versions#naming-a-file">Naming a file</Link>). On underlay.org
          records are always uploaded in full, and a file counts only if it is held for the
          collection.
        </li>
        <li>
          Who may read is decided per collection. A private collection answers 404 to a caller who
          may not read it, as if it did not exist.
        </li>
        <li>
          A version id does not prove that a server shows all readers the same versions. Commits
          chain through <code>previous</code> and the server signs each one, but the log cannot be
          read over HTTP yet.
        </li>
        <li>
          Open issue: how a reader obtains and trusts the server&rsquo;s signing key is not
          specified.
        </li>
        <li>
          File bytes are served from an origin separate from the server&rsquo;s pages, with{' '}
          <code>Content-Disposition: attachment</code>, so that an uploaded HTML or SVG file cannot
          run in the server&rsquo;s origin.
        </li>
      </ul>
    </DocsLayout>
  )
}
