import { Link } from 'react-router'

import DocsLayout, { CodeBlock } from '~/components/DocsLayout'

const batchExample = `curl -X POST https://underlay.org/api/records/batch \\
  -H "Content-Type: application/json" \\
  -d '{"hashes": ["3f2a9c...", "sha256:9c1e4b..."]}'`

const batchRes = `HTTP/1.1 200 OK
Content-Type: application/x-ndjson

{"id":"pub-001","type":"Publication","data":{"title":"..."},"hash":"3f2a9c..."}
{"id":"pub-002","type":"Publication","data":{"title":"..."},"hash":"9c1e4b..."}`

const provenanceRes = `{
  "hash": "3f2a9c...",
  "recordHash": "3f2a9c...",
  "recordId": "pub-001",
  "type": "Publication",
  "data": { "title": "An Example Paper" },
  "size": 182,
  "firstSeen": "2026-01-15T00:00:00.000Z",
  "createdAt": "2026-01-15T00:00:00.000Z",
  "references": [
    {
      "owner": "kf",
      "collection": "archive",
      "collectionName": "PubPub Archive",
      "semver": "v1.0.0",
      "versionCreatedAt": "2026-01-15T00:00:00.000Z"
    },
    {
      "owner": "kf",
      "collection": "archive",
      "collectionName": "PubPub Archive",
      "semver": "v1.1.0",
      "versionCreatedAt": "2026-02-02T00:00:00.000Z"
    }
  ]
}`

const firstRes = `{
  "hash": "3f2a9c...",
  "kind": "record",
  "owner": "kf",
  "collection": "archive",
  "semver": "v1.0.0",
  "createdAt": "2026-01-15T00:00:00.000Z",
  "type": "Publication",
  "id": "pub-001"
}`

const schemasRes = `[
  {
    "id": "b41c07...",
    "schemaHash": "b41c07...",
    "schema": { "type": "object", "properties": { "title": { "type": "string" } } },
    "createdAt": "2026-01-15T00:00:00.000Z",
    "labels": ["scholarly-publication"]
  }
]`

const schemaOneRes = `{
  "id": "b41c07...",
  "schemaHash": "b41c07...",
  "schema": { "type": "object", "properties": { "title": { "type": "string" } } },
  "createdAt": "2026-01-15T00:00:00.000Z",
  "labels": ["scholarly-publication"],
  "usageCount": 3
}`

const schemaRes = `{
  "id": "b41c07...",
  "schemaHash": "b41c07...",
  "schema": { "type": "object", "properties": { "title": { "type": "string" } } },
  "createdAt": "2026-01-15T00:00:00.000Z",
  "labels": [
    { "label": "scholarly-publication", "createdAt": "2026-03-01T00:00:00.000Z" }
  ],
  "usage": [
    { "slug": "Publication", "semver": "v3.2.0", "collection": "kf/archive" }
  ]
}`

const collectionSchemasRes = `{
  "version": "v3.2.0",
  "semver": "v3.2.0",
  "schemas": [
    {
      "slug": "Publication",
      "schemaId": "b41c07...",
      "schemaHash": "b41c07...",
      "schema": {
        "type": "object",
        "properties": { "title": { "type": "string" } },
        "x-underlay-labels": ["scholarly-publication"]
      }
    }
  ]
}`

const labelExample = `curl -X POST https://underlay.org/api/schemas/b41c07.../labels \\
  -H "Authorization: Bearer $KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"label": "scholarly-publication"}'`

const labelRes = `{
  "status": "created",
  "schemaId": "b41c07...",
  "label": "scholarly-publication"
}`

export default function DocsApiRecords() {
  return (
    <DocsLayout title="Records and schemas API">
      <p>
        A record&rsquo;s hash identifies it in every collection that holds it. These endpoints look
        records up by hash across collections, and find the schemas collections use. Record hashes
        are 64 lowercase hex characters, with or without a <code>sha256:</code> prefix.
      </p>

      <h2 id="visibility">Visibility</h2>
      <p>
        Every answer is limited to what the caller can read: the public set of a public collection,
        plus both sets of the collections in the caller&rsquo;s own organizations. A record or
        schema the caller can&rsquo;t read is treated as not existing, and counts include only what
        the caller can see. All of these endpoints work anonymously.
      </p>
      <p>
        The index that finds records by hash is updated by a background job after each push, so a
        version pushed in the last few seconds may not show up yet in the record endpoints below.
      </p>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="post-api-records-batch">POST /api/records/batch</h2>
        <p className="scope">No auth required</p>
        <p>
          Fetch up to 100 records by hash in one request. Body:{' '}
          <code>{'{"hashes": ["<hash>", …]}'}</code>. The response is NDJSON, one{' '}
          <code>{'{"id", "type", "data", "hash"}'}</code> per line, in the order the hashes were
          given. A hash that isn&rsquo;t found, or that the caller can&rsquo;t read, is left out
          rather than reported, so the response can have fewer lines than the request had hashes, or
          none at all.
        </p>
        <p>This request counts as 5 requests against your rate limit.</p>
        <h3>Example</h3>
        <CodeBlock>{batchExample}</CodeBlock>
        <CodeBlock>{batchRes}</CodeBlock>
        <h3>Errors</h3>
        <table>
          <tbody>
            <tr>
              <td>
                <code>400</code>
              </td>
              <td>
                <code>hashes</code> is missing, empty, or has more than 100 entries.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="get-api-records-hash-provenance">GET /api/records/:hash/provenance</h2>
        <p className="scope">No auth required</p>
        <p>
          A record and every version that contains it, across the collections the caller can read.{' '}
          <code>references</code> has one entry per version, oldest first; <code>firstSeen</code>{' '}
          (and its older name, <code>createdAt</code>) is the earliest of them. <code>size</code> is
          the length of the record&rsquo;s canonical form in bytes.
        </p>
        <p>
          Long histories are cut short: <code>references</code> lists at most the first 100 versions
          of each collection, and covers at most 300 runs of consecutive versions overall. This
          request counts as 5 requests against your rate limit.
        </p>
        <h3>
          Response <span className="text-ink-muted font-normal">200</span>
        </h3>
        <CodeBlock>{provenanceRes}</CodeBlock>
        <h3>Errors</h3>
        <table>
          <tbody>
            <tr>
              <td>
                <code>404</code>
              </td>
              <td>No collection the caller can read holds a record with this hash.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="get-api-records-hash-first">GET /api/records/:hash/first</h2>
        <p className="scope">No auth required</p>
        <p>
          Where a record or a file first appeared: the earliest version, among the collections the
          caller can read, that added this hash. Cheaper than provenance when that is all you need.{' '}
          <code>kind</code> is <code>record</code> or <code>file</code>; <code>type</code> and{' '}
          <code>id</code> are present for records only. Returns <code>404</code> when no readable
          collection has it.
        </p>
        <h3>
          Response <span className="text-ink-muted font-normal">200</span>
        </h3>
        <CodeBlock>{firstRes}</CodeBlock>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="get-api-collections-files-hash">GET /api/collections/files/:hash</h2>
        <p className="scope">No auth required</p>
        <p>
          Download a file by hash without naming a collection. If any collection the caller can read
          holds the file, the endpoint 302-redirects to a short-lived presigned storage URL, as the{' '}
          <Link
            to="/docs/api/files#get-api-collections-owner-slug-files-hash"
            className="text-link underline"
          >
            per-collection download
          </Link>{' '}
          does. Returns <code>404</code> when no readable collection has it, and <code>451</code>{' '}
          when the file has been blocked.
        </p>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="get-api-schemas">GET /api/schemas</h2>
        <p className="scope">No auth required</p>
        <p>
          Search the schemas in use, newest first. A schema&rsquo;s id is its hash: SHA-256 of its
          canonical JSON, as bare hex.
        </p>
        <h3>Query parameters</h3>
        <table>
          <tbody>
            <tr>
              <td>
                <code>q</code>
              </td>
              <td>Matches part of a label or of a type name</td>
            </tr>
            <tr>
              <td>
                <code>label</code>
              </td>
              <td>Matches part of a label</td>
            </tr>
            <tr>
              <td>
                <code>slug</code>
              </td>
              <td>
                An exact type name, e.g. <code>Publication</code>: schemas some collection uses for
                that type
              </td>
            </tr>
            <tr>
              <td>
                <code>schema_hash</code>
              </td>
              <td>
                An exact schema hash (bare hex). Returns that one schema as an object instead of a
                list, with <code>usageCount</code>, or <code>404</code>
              </td>
            </tr>
            <tr>
              <td>
                <code>limit</code>
              </td>
              <td>Max results (default 50, max 100)</td>
            </tr>
            <tr>
              <td>
                <code>offset</code>
              </td>
              <td>Pagination offset</td>
            </tr>
          </tbody>
        </table>
        <p>
          Schema bodies are not searched: <code>q</code> looks only at labels and type names.
        </p>
        <h3>
          Response <span className="text-ink-muted font-normal">200</span>
        </h3>
        <CodeBlock>{schemasRes}</CodeBlock>
        <p>
          With <code>schema_hash</code>, <code>usageCount</code> is the number of collections the
          caller can read that have used the schema in any version:
        </p>
        <CodeBlock>{schemaOneRes}</CodeBlock>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="get-api-schemas-id">GET /api/schemas/:id</h2>
        <p className="scope">No auth required</p>
        <p>
          One schema, by hash, with its labels and where it is used now. <code>usage</code> lists up
          to 50 types, in the collections the caller can read, whose latest version uses this
          schema; <code>semver</code> is that collection&rsquo;s latest version. Here each label
          comes with the time it was added. Returns <code>404</code> when the caller can&rsquo;t see
          the schema.
        </p>
        <h3>
          Response <span className="text-ink-muted font-normal">200</span>
        </h3>
        <CodeBlock>{schemaRes}</CodeBlock>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="get-api-collections-owner-slug-schemas">
          GET /api/collections/:owner/:slug/schemas
        </h2>
        <p className="scope">No auth for public collections</p>
        <p>
          The schema of each type in a version. Labels are added to each schema as{' '}
          <code>x-underlay-labels</code> when it has any; pass <code>raw=true</code> for the schemas
          exactly as pushed.
        </p>
        <h3>Query parameters</h3>
        <table>
          <tbody>
            <tr>
              <td>
                <code>version</code>
              </td>
              <td>
                A semver (<code>v1.2.0</code>), a version hash (<code>ulv2:…</code>), or{' '}
                <code>latest</code> (the default)
              </td>
            </tr>
            <tr>
              <td>
                <code>raw</code>
              </td>
              <td>
                <code>true</code> leaves out <code>x-underlay-labels</code>
              </td>
            </tr>
          </tbody>
        </table>
        <h3>
          Response <span className="text-ink-muted font-normal">200</span>
        </h3>
        <CodeBlock>{collectionSchemasRes}</CodeBlock>
        <p>
          Returns <code>404</code> when the collection or version doesn&rsquo;t exist, or the
          collection has no versions.
        </p>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="post-api-schemas-id-labels">POST /api/schemas/:id/labels</h2>
        <p className="scope">Auth: signed in, or a write or admin API key</p>
        <p>
          Add a label to a schema the caller can see, so others can find it. Body:{' '}
          <code>{'{"label": "…"}'}</code>, at most 100 characters after trimming spaces. Adding a
          label the schema already has is not an error.
        </p>
        <h3>Example</h3>
        <CodeBlock>{labelExample}</CodeBlock>
        <h3>
          Response <span className="text-ink-muted font-normal">201</span>
        </h3>
        <CodeBlock>{labelRes}</CodeBlock>
        <h3>Errors</h3>
        <table>
          <tbody>
            <tr>
              <td>
                <code>200</code>
              </td>
              <td>
                The schema already has this label: <code>{'"status": "exists"'}</code>
              </td>
            </tr>
            <tr>
              <td>
                <code>400</code>
              </td>
              <td>The label is empty or longer than 100 characters.</td>
            </tr>
            <tr>
              <td>
                <code>401</code> / <code>403</code>
              </td>
              <td>Not signed in, or a read-only key.</td>
            </tr>
            <tr>
              <td>
                <code>404</code>
              </td>
              <td>The schema doesn&rsquo;t exist or the caller can&rsquo;t see it.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="delete-api-schemas-id-labels-label">DELETE /api/schemas/:id/labels/:label</h2>
        <p className="scope">Auth: admin API key</p>
        <p>
          Remove a label from a schema. Only an API key with the <code>admin</code> scope can; a
          browser session gets <code>403</code>. Returns <code>{'{"ok": true}'}</code>, also when
          the schema didn&rsquo;t have the label.
        </p>
      </div>
    </DocsLayout>
  )
}
