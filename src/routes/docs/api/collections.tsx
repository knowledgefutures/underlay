import DocsLayout from '~/components/DocsLayout'

const browseRes = `[
  {
    "id": "uuid",
    "slug": "pubpub-archive",
    "name": "PubPub Archive",
    "description": "Full archive of PubPub publications",
    "ownerSlug": "knowledge-futures",
    "ownerName": "Knowledge Futures",
    "latestVersion": "v3.2.0",
    "createdAt": "2026-01-15T00:00:00.000Z",
    "updatedAt": "2026-04-01T00:00:00.000Z"
  }
]`

const createReq = `{
  "slug": "my-dataset",
  "name": "My Dataset",
  "public": true
}`

const createRes = `{
  "id": "uuid",
  "owner": "yourname",
  "slug": "my-dataset",
  "name": "My Dataset"
}`

const getRes = `{
  "id": "uuid",
  "slug": "pubpub-archive",
  "name": "PubPub Archive",
  "description": "Full archive of PubPub publications",
  "public": true,
  "ownerSlug": "knowledge-futures",
  "ownerName": "Knowledge Futures",
  "createdAt": "2026-01-15T00:00:00.000Z",
  "updatedAt": "2026-04-01T00:00:00.000Z",
  "latestVersion": {
    "semver": "v3.2.0",
    "recordCount": 4521,
    "fileCount": 892,
    "totalBytes": 1073741824,
    "metadata": { "description": "Full archive...", "readme": "..." },
    "createdAt": "2026-04-01T00:00:00.000Z",
    "message": "April sync"
  }
}`

const updateReq = `{
  "name": "New Name",
  "public": false
}`

const okRes = `{"ok": true}`

const listRes = `[
  {
    "id": "uuid",
    "slug": "pubpub-archive",
    "name": "PubPub Archive",
    "public": true,
    "createdAt": "2026-01-15T00:00:00.000Z",
    "updatedAt": "2026-04-01T00:00:00.000Z"
  }
]`

const metadataReq = `{
  "description": "Updated description of the archive",
  "readme": "# My Collection\\nNew readme content.",
  "license": "CC-BY-4.0"
}`

const metadataRes = `{
  "semver": "v3.2.1",
  "hash": "e5f6a7b8...",
  "metadata": {
    "description": "Updated description of the archive",
    "readme": "# My Collection\\nNew readme content.",
    "license": "CC-BY-4.0"
  }
}`

const forkReq = `{
  "targetOrg": "my-org",
  "slug": "my-fork"
}`

const forkRes = `{
  "id": "uuid",
  "owner": "my-org",
  "slug": "my-fork",
  "name": "PubPub Archive",
  "forkedFrom": {
    "owner": "knowledge-futures",
    "slug": "pubpub-archive",
    "version": "v3.2.0"
  },
  "version": {
    "semver": "v1.0.0",
    "recordCount": 4521
  }
}`

export default function DocsApiCollections() {
  return (
    <DocsLayout title="Collections API">
      <p>
        Create, browse, update, and delete collections. A collection is identified by{' '}
        <code>:owner/:slug</code>.
      </p>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2>GET /api/collections</h2>
        <p className="scope">No auth required</p>
        <p>Browse public collections with optional search.</p>
        <h3>Query parameters</h3>
        <table>
          <tbody>
            <tr>
              <td>
                <code>q</code>
              </td>
              <td>Search by collection name</td>
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
        <h3>
          Response <span className="text-ink-muted font-normal">200</span>
        </h3>
        <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
          <code>{browseRes}</code>
        </pre>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2>POST /api/accounts/:owner/collections</h2>
        <p className="scope">Auth: write scope</p>
        <p>
          Create a new collection under an account. You must own the account or be a member of the
          org.
        </p>
        <h3>Request</h3>
        <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
          <code>{createReq}</code>
        </pre>
        <h3>
          Response <span className="text-ink-muted font-normal">201</span>
        </h3>
        <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
          <code>{createRes}</code>
        </pre>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2>GET /api/collections/:owner/:slug</h2>
        <p className="scope">No auth for public collections</p>
        <p>Get collection metadata and latest version summary.</p>
        <h3>
          Response <span className="text-ink-muted font-normal">200</span>
        </h3>
        <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
          <code>{getRes}</code>
        </pre>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2>PATCH /api/collections/:owner/:slug</h2>
        <p className="scope">Auth: write scope</p>
        <p>Update collection metadata. Pass only the fields to change.</p>
        <h3>Request</h3>
        <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
          <code>{updateReq}</code>
        </pre>
        <h3>
          Response <span className="text-ink-muted font-normal">200</span>
        </h3>
        <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
          <code>{okRes}</code>
        </pre>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2>DELETE /api/collections/:owner/:slug</h2>
        <p className="scope">Auth: admin scope</p>
        <p>
          Delete a collection and all its versions, records, and file references. Files themselves
          are not deleted (they may be referenced by other collections).
        </p>
        <h3>
          Response <span className="text-ink-muted font-normal">200</span>
        </h3>
        <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
          <code>{okRes}</code>
        </pre>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2>GET /api/accounts/:owner/collections</h2>
        <p className="scope">No auth required</p>
        <p>List all collections belonging to an account. Non-owners see only public collections.</p>
        <h3>
          Response <span className="text-ink-muted font-normal">200</span>
        </h3>
        <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
          <code>{listRes}</code>
        </pre>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2>PATCH /api/collections/:owner/:slug/metadata</h2>
        <p className="scope">Auth: write scope</p>
        <p>
          Update version metadata by creating a new minor version bump. The request body is a JSON
          object whose fields are merged with the previous version's metadata. Use this to update{' '}
          <code>description</code>, <code>readme</code>, <code>license</code>, or any other metadata
          fields without pushing new records.
        </p>
        <h3>Request</h3>
        <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
          <code>{metadataReq}</code>
        </pre>
        <h3>Fields</h3>
        <table>
          <tbody>
            <tr>
              <td>
                <code>description</code>
              </td>
              <td>Short description of the collection.</td>
            </tr>
            <tr>
              <td>
                <code>readme</code>
              </td>
              <td>Markdown readme content.</td>
            </tr>
            <tr>
              <td>
                <code>license</code>
              </td>
              <td>
                License identifier (e.g. <code>"CC-BY-4.0"</code>).
              </td>
            </tr>
            <tr>
              <td>
                <code>...</code>
              </td>
              <td>
                Any other key-value pairs. All fields are merged into the previous version's
                metadata object.
              </td>
            </tr>
          </tbody>
        </table>
        <h3>
          Response <span className="text-ink-muted font-normal">201</span>
        </h3>
        <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
          <code>{metadataRes}</code>
        </pre>
        <h3>Errors</h3>
        <table>
          <tbody>
            <tr>
              <td>
                <code>422</code>
              </td>
              <td>No versions exist yet — push a version first before updating metadata.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2>POST /api/collections/:owner/:slug/fork</h2>
        <p className="scope">Auth: write scope</p>
        <p>
          Fork a public collection into a target organization. Creates a new collection under the
          target org with the source's latest version. Records, schemas, and files are referenced
          (not copied) — zero additional storage.
        </p>
        <h3>Request</h3>
        <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
          <code>{forkReq}</code>
        </pre>
        <h3>Fields</h3>
        <table>
          <tbody>
            <tr>
              <td>
                <code>targetOrg</code>
              </td>
              <td>
                <strong>Required.</strong> Slug of the organization to fork into. You must be a
                member of this org.
              </td>
            </tr>
            <tr>
              <td>
                <code>slug</code>
              </td>
              <td>
                Optional slug for the new collection. Defaults to the source collection's slug.
              </td>
            </tr>
          </tbody>
        </table>
        <h3>
          Response <span className="text-ink-muted font-normal">201</span>
        </h3>
        <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
          <code>{forkRes}</code>
        </pre>
        <h3>Errors</h3>
        <table>
          <tbody>
            <tr>
              <td>
                <code>404</code>
              </td>
              <td>Source collection not found, not public, or target org not found.</td>
            </tr>
            <tr>
              <td>
                <code>409</code>
              </td>
              <td>A collection with the same slug already exists in the target org.</td>
            </tr>
            <tr>
              <td>
                <code>422</code>
              </td>
              <td>Source collection has no versions to fork.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </DocsLayout>
  )
}
