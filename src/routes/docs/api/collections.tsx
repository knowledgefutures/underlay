import DocsLayout from '~/components/DocsLayout'

const browseRes = `[
  {
    "id": "uuid",
    "slug": "pubpub-archive",
    "name": "PubPub Archive",
    "description": "Full archive of PubPub publications",
    "ownerSlug": "knowledge-futures",
    "ownerName": "Knowledge Futures",
    "createdAt": "2026-01-15T00:00:00.000Z",
    "updatedAt": "2026-04-01T00:00:00.000Z"
  }
]`

const createReq = `{
  "slug": "my-dataset",
  "name": "My Dataset",
  "description": "Optional description",
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
  "ownerType": "org",
  "createdAt": "2026-01-15T00:00:00.000Z",
  "updatedAt": "2026-04-01T00:00:00.000Z",
  "latestVersion": {
    "number": 12,
    "semver": "v3.2.0",
    "recordCount": 4521,
    "fileCount": 892,
    "totalBytes": 1073741824,
    "createdAt": "2026-04-01T00:00:00.000Z",
    "message": "April sync"
  }
}`

const updateReq = `{
  "name": "New Name",
  "description": "Updated description",
  "public": false
}`

const okRes = `{"ok": true}`

const listRes = `[
  {
    "id": "uuid",
    "slug": "pubpub-archive",
    "name": "PubPub Archive",
    "description": "...",
    "public": true,
    "createdAt": "2026-01-15T00:00:00.000Z",
    "updatedAt": "2026-04-01T00:00:00.000Z"
  }
]`

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
              <td>Search name and description</td>
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
    </DocsLayout>
  )
}
