import { Link } from 'react-router'

import DocsLayout, { CodeBlock } from '~/components/DocsLayout'

const endpoints = `POST   <collection>/push                  open a session
POST   <collection>/push/<sid>/records    upload records (NDJSON)
POST   <collection>/push/<sid>/deletes    upload deletes (NDJSON)
PUT    <collection>/files/<fileHash>      upload a file
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
{"id":"pub-004","type":"Publication","data":{...}}
{"id":"pub-005","type":"Publication","data":{...},"private":true}
→ 200 {"received": 2}

POST <collection>/push/<sid>/deletes
{"type":"Publication","id":"pub-003"}
→ 200 {"received": 1}

POST <collection>/push/<sid>/commit
→ 201 {"semver": "v1.3.0", "hash": "ulv2:...", "recordCount": 4, "fileCount": 1,
       "changes": {"added": 2, "removed": 1, "updated": 0}}
→ 202 {"session_id": "...", "status": "committing"}         (background commit)`

const openMembers: [string, string][] = [
  [
    'base',
    'The semver of the version the changes are against. If it is not the head, the server MUST answer 409 with currentVersion. null or absent: the head at opening.',
  ],
  [
    'schemas',
    'The complete type set, slug → schema. Replaces the base’s; an omitted type is removed with its records. Absent: the base’s type set.',
  ],
  ['metadata', 'Replaces the base’s metadata. An object or null.'],
  [
    'metadata_patch',
    'An object whose top-level members are merged into the base’s metadata. Ignored if metadata is present.',
  ],
  [
    'files',
    '{"add": [fileHash, …], "remove": [fileHash, …]}: files declared or removed beyond those records reference.',
  ],
  ['message, app_id, actor_id', 'Strings recorded with the version.'],
  ['strip_unknown_fields', 'Boolean; see Records.'],
]

export default function ProtocolPushPull() {
  return (
    <DocsLayout title="Push and pull" eyebrow="Protocol v2 · §11.4, §13">
      <h2 id="delta-push">Delta push</h2>
      <p>
        A client publishes a version by delta push: it opens a session against a base version,
        uploads the records it adds or changes and the (type, id) pairs it deletes, and commits. The
        server builds the trees, writes and signs the log entry, and assigns the semver (
        <Link to="/docs/protocol/versions#semver">semver rules</Link>). Delta push is the only
        publication mechanism; a server MUST NOT accept tree nodes or packs from clients.
      </p>
      <CodeBlock>{endpoints}</CodeBlock>

      <h3>Opening a session</h3>
      <p>The body is a JSON object; every member is OPTIONAL.</p>
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
        The response is 200 with <code>session_id</code>; <code>base</code> (the semver the session
        is against, or <code>null</code>); <code>needed_files</code>, the declared files the server
        does not hold for the collection, which the client MUST upload before committing;{' '}
        <code>expires_at</code>, extended by each records or deletes request; and{' '}
        <code>limits</code>, the server&rsquo;s own, by which a client MUST size its requests:{' '}
        <code>open_bytes</code>, <code>batch_bytes</code>, <code>batch_lines</code>,{' '}
        <code>session_idle_seconds</code>, <code>open_sessions</code> (per user, open or committing)
        and <code>file_bytes</code>.
      </p>

      <h3>Records and deletes</h3>
      <ul>
        <li>
          <code>…/records</code> takes NDJSON record lines and answers{' '}
          <code>{'{"received": n}'}</code>. Each line MUST satisfy the{' '}
          <Link to="/docs/protocol/records#input-rules">input rules</Link> and its type&rsquo;s
          schema, and its type MUST be in the session&rsquo;s type set.
        </li>
        <li>
          A record whose <code>data</code> has top-level members absent from its schema&rsquo;s root{' '}
          <code>properties</code> MUST be refused, unless the session set{' '}
          <code>strip_unknown_fields</code>, in which case they are removed before hashing. A schema
          without root <code>properties</code> admits any members.
        </li>
        <li>
          If any line fails, the server MUST answer 422 with <code>validationErrors</code>, one per
          failing line with its 1-based <code>line</code> among the request&rsquo;s non-empty lines,
          and MUST store nothing from the request. A server MAY list only the first failures, with{' '}
          <code>totalErrors</code> giving their number.
        </li>
        <li>
          <code>…/deletes</code> takes NDJSON <code>{'{"type", "id"}'}</code> lines and answers{' '}
          <code>{'{"received": n}'}</code>. The type MUST be in the session&rsquo;s type set.
          Deleting a pair the base does not hold is not an error. A request with no lines is a 400.
        </li>
        <li>
          Within a session, the later upload of a (type, id) supersedes an earlier one, record or
          delete.
        </li>
      </ul>

      <h3>Files and commit</h3>
      <ul>
        <li>
          <code>PUT …/files/&lt;fileHash&gt;</code> stores a file for the collection: 201, or 400 if
          the bytes do not hash to <code>&lt;fileHash&gt;</code>. A server MAY offer other upload
          mechanisms. Every file a new record references, and every declared file, MUST be held for
          the collection at commit: in a file tree of the base, in the public set of any earlier
          version, or uploaded to the collection. A file held only for another collection is not
          held, and every upload is hashed, even of a file the server already stores.
        </li>
        <li>
          <code>…/commit</code> answers 201 with the version, or 202 when it runs in the background.
          A client MAY request the background with <code>?async=true</code>; a server MAY choose it
          for any commit. The client then polls <code>GET …/push/&lt;sid&gt;</code> until{' '}
          <code>status</code> is <code>committed</code> (<code>result</code> holds the 201 body) or{' '}
          <code>failed</code> (<code>error</code> holds the failure).
        </li>
        <li>Committing a session that has already committed answers 201 with the same body.</li>
        <li>
          A client that holds the base SHOULD compute the new version hash and compare it with the
          returned <code>hash</code>.
        </li>
      </ul>
      <CodeBlock>{exchange}</CodeBlock>

      <h2 id="clients-without-a-copy">Clients without a copy</h2>
      <p>
        Informative. A client that keeps no copy of the collection reads the base&rsquo;s{' '}
        <Link to="/docs/protocol/repositories#serving-over-http">manifest</Link>, compares each of
        its records with it by (type, id), record hash and set, uploads the records that are new,
        changed or moved between sets, and deletes the pairs it no longer has. The upload is then
        proportional to the changes. If another publication intervenes, the session or commit
        answers 409 and the client repeats the comparison against the new head.
      </p>

      <h2 id="pull">Pull</h2>
      <p>
        A client that keeps a copy reads the log after the last entry it holds, verifies it, and
        requests a pack of the new head against the version it last received, which it receives
        under the <Link to="/docs/protocol/repositories#packs">pack rules</Link>. Reads beyond the
        log, packs, the manifest and files are a server&rsquo;s own API (for underlay.org, the{' '}
        <Link to="/docs/api/versions">Versions API</Link>).
      </p>

      <h2 id="errors">Errors</h2>
      <p>
        Errors carry <code>{'{"error": <message>}'}</code>. Authentication and 404 follow the
        reads&rsquo; rules: content the caller may not read is 404, never 403.
      </p>
      <ul>
        <li>
          <code>403</code>: the caller may read the collection but not publish to it, or the session
          belongs to another user.
        </li>
        <li>
          <code>400</code>: a malformed body, a <code>metadata</code> that is neither an object nor{' '}
          <code>null</code>, or a request with no lines.
        </li>
        <li>
          <code>409</code>: <code>base</code> is not the head (with <code>currentVersion</code>);
          the head changed before the commit; the session is not open; or the publication changes
          nothing (with the head&rsquo;s <code>hash</code>).
        </li>
        <li>
          <code>413</code>: a body over <code>open_bytes</code> or <code>batch_bytes</code>, a
          request over <code>batch_lines</code>, or a file over <code>file_bytes</code>.
        </li>
        <li>
          <code>422</code>: records or deletes that fail, a refused schema, records carried over
          from the base that fail a changed schema (<code>validationErrors</code>), or a commit
          lacking files (<code>filesNeeded</code>).
        </li>
        <li>
          <code>429</code>: <code>open_sessions</code> sessions already in progress, or a rate limit
          (with <code>Retry-After</code>).
        </li>
      </ul>

      <h2 id="security-considerations">Security considerations</h2>
      <ul>
        <li>
          A server MUST NOT serve a tree node or body by hash alone, and MUST serve a record, schema
          or file located by hash only where it occurs in a set the caller may read.
        </li>
        <li>
          A server MUST NOT treat content it holds for other collections as present in a session:
          records are always uploaded in full, and a file counts only if it is held for the
          collection.
        </li>
        <li>
          The private-set salt prevents confirmation of guessed private content from the commitment;
          the root reveals only whether a private set exists.
        </li>
        <li>
          A version hash does not prove that a server shows every reader the same versions; the
          signed, hash-chained log makes omission and reordering detectable.
        </li>
        <li>
          Open issue: how a verifier obtains trusted signing keys is not specified. Trusting the
          keys in a <code>collection.json</code> served by an untrusted server admits a forged
          history on first contact.
        </li>
        <li>
          File bytes SHOULD be served from an origin separate from the server&rsquo;s pages, with{' '}
          <code>Content-Disposition: attachment</code>, so that an uploaded HTML or SVG file cannot
          run in the server&rsquo;s origin.
        </li>
      </ul>
    </DocsLayout>
  )
}
