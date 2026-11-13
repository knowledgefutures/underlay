import { Link } from 'react-router'

import DocsLayout, { CodeBlock } from '~/components/DocsLayout'

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

const labelExample = `curl -X POST https://www.underlay.org/api/schemas/b41c07.../labels \\
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
        These endpoints find the schemas collections use, and label them. Looking records up by hash
        across collections (a record&rsquo;s provenance, where it first appeared, or fetching
        records by hash in a batch) is not available yet: read records through their collection with
        the{' '}
        <Link to="/docs/api/versions" className="text-link underline">
          Versions API
        </Link>
        .
      </p>

      <h2 id="visibility">Visibility</h2>
      <p>
        Every answer is limited to what the caller can read: public collections, plus the
        collections of the caller&rsquo;s own organizations. A schema the caller can&rsquo;t read is
        treated as not existing, and counts include only what the caller can see. The read endpoints
        work anonymously.
      </p>

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
                A semver (<code>v1.2.0</code>), a version id (<code>ulv3:…</code>), or{' '}
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
        <p className="scope">Auth: Underlay stewards only (session, or a write or admin key)</p>
        <p>
          Remove a label from a schema. A label is shared by every collection that uses the schema,
          so only Underlay&rsquo;s stewards (Knowledge Futures administrators) can remove one,
          signed in or with a personal write or admin key. Anyone else is <code>403</code>; a read
          key, or a key confined to collections or held by an organization, is <code>401</code>.
          Returns <code>{'{"ok": true}'}</code>, also when the schema didn&rsquo;t have the label.
        </p>
      </div>
    </DocsLayout>
  )
}
