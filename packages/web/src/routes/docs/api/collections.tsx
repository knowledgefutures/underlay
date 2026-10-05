import DocsLayout from '~/components/DocsLayout'

const browseRes = `{
  "collections": [
    {
      "id": "uuid",
      "slug": "pubpub-archive",
      "name": "PubPub Archive",
      "public": true,
      "ownerSlug": "knowledge-futures",
      "ownerName": "Knowledge Futures",
      "createdAt": "2026-01-15T00:00:00.000Z",
      "updatedAt": "2026-04-01T00:00:00.000Z",
      "description": "Full archive of PubPub publications",
      "tags": ["publishing"],
      "latestVersion": "v3.2.0",
      "recordCount": 4521,
      "fileCount": 892,
      "totalBytes": 1073741824,
      "lastPushAt": "2026-04-01T00:00:00.000Z"
    }
  ],
  "facets": {
    "owners": [{ "slug": "knowledge-futures", "name": "Knowledge Futures", "count": 12 }],
    "tags": [{ "name": "publishing", "count": 4 }]
  },
  "featuredTags": ["publishing"],
  "featuredCollections": []
}`

const createReq = `{
  "slug": "my-dataset",
  "name": "My Dataset",
  "description": "What the collection holds",
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
  "public": true,
  "ownerSlug": "knowledge-futures",
  "ownerName": "Knowledge Futures",
  "createdAt": "2026-01-15T00:00:00.000Z",
  "updatedAt": "2026-04-01T00:00:00.000Z",
  "description": "Full archive of PubPub publications",
  "ark": "https://underlay.org/ark:12345/ulb9bq4n5gmv3k0",
  "versionCount": 14,
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

const updateRes = `{ "ok": true, "slug": "pubpub-archive" }`

const okRes = `{ "ok": true }`

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
  "hash": "ulv2:e5f6a7b8...",
  "status": "completed"
}`

const transferReq = `{ "targetOrgSlug": "my-org" }`

const transferRes = `{ "ok": true, "newOwner": "my-org" }`

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
        Create, browse, update, transfer, fork and delete collections. A collection is identified by{' '}
        <code>:owner/:slug</code>.
      </p>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="get-api-collections">GET /api/collections</h2>
        <p className="scope">
          No auth required (<code>mine=true</code> needs a session or an unscoped key)
        </p>
        <p>
          Browse public collections, or with <code>mine=true</code> the collections of every
          organization you belong to, public or not. <code>facets</code> count owners and tags
          across every collection in that set, not just this page and whatever the other filters.{' '}
          <code>featuredTags</code> and <code>featuredCollections</code> are the site&rsquo;s picks
          for the explore page.
        </p>
        <h3>Query parameters</h3>
        <table>
          <tbody>
            <tr>
              <td>
                <code>q</code>
              </td>
              <td>Collections whose name contains this text</td>
            </tr>
            <tr>
              <td>
                <code>owner</code>
              </td>
              <td>Only collections of this account (its slug)</td>
            </tr>
            <tr>
              <td>
                <code>tag</code>
              </td>
              <td>Only collections with this tag</td>
            </tr>
            <tr>
              <td>
                <code>sort</code>
              </td>
              <td>
                <code>name</code> or <code>records</code>; by default, most recently updated first
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
            <tr>
              <td>
                <code>mine</code>
              </td>
              <td>
                <code>true</code> for your organizations&rsquo; collections. Anonymous callers and
                collection-scoped keys get <code>401</code>.
              </td>
            </tr>
          </tbody>
        </table>
        <h3>
          Response <span className="text-ink-muted font-normal">200</span>
        </h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{browseRes}</code>
        </pre>
        <p>
          Counts are for the caller: members of the owning organization see totals that include
          private records and files; everyone else sees the public ones.
        </p>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="post-api-accounts-owner-collections">POST /api/accounts/:owner/collections</h2>
        <p className="scope">
          Auth: member of the account, by session or a <code>write</code> or <code>admin</code> key
          not scoped to specific collections
        </p>
        <p>
          Create a new collection under an account. Only <code>slug</code> is required.{' '}
          <code>name</code> defaults to the slug. <code>public</code> defaults to <code>false</code>
          . <code>description</code> is optional; it shows until a version&rsquo;s metadata gives
          one.
        </p>
        <h3>Request</h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{createReq}</code>
        </pre>
        <h3>
          Response <span className="text-ink-muted font-normal">201</span>
        </h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{createRes}</code>
        </pre>
        <h3>Errors</h3>
        <table>
          <tbody>
            <tr>
              <td>
                <code>401</code>
              </td>
              <td>Not authenticated.</td>
            </tr>
            <tr>
              <td>
                <code>403</code>
              </td>
              <td>
                Not a member of the account, or a <code>read</code> key or a key scoped to specific
                collections.
              </td>
            </tr>
            <tr>
              <td>
                <code>404</code>
              </td>
              <td>No account with that slug.</td>
            </tr>
            <tr>
              <td>
                <code>409</code>
              </td>
              <td>The account already has a collection with this slug.</td>
            </tr>
            <tr>
              <td>
                <code>422</code>
              </td>
              <td>The slug is missing or not a valid slug.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="get-api-collections-owner-slug">GET /api/collections/:owner/:slug</h2>
        <p className="scope">No auth for public collections</p>
        <p>Get collection metadata and latest version summary.</p>
        <h3>
          Response <span className="text-ink-muted font-normal">200</span>
        </h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{getRes}</code>
        </pre>
        <p>
          Counts are for the caller: <code>recordCount</code>, <code>fileCount</code> and{' '}
          <code>totalBytes</code> include private records and files for the collection&rsquo;s
          members, and leave them out for everyone else. <code>ark</code> is null when the
          collection&rsquo;s ARK is off. <code>latestVersion</code> is null before the first push.
        </p>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="patch-api-collections-owner-slug">PATCH /api/collections/:owner/:slug</h2>
        <p className="scope">
          Auth: write access (a member, by session or a <code>write</code> or <code>admin</code>{' '}
          key); changing <code>public</code> also needs the owner or admin role, by session or an{' '}
          <code>admin</code> key
        </p>
        <p>
          Update a collection&rsquo;s <code>name</code>, <code>slug</code> or <code>public</code>.
          Pass only the fields to change. The response gives the collection&rsquo;s slug after the
          change.
        </p>
        <h3>Request</h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{updateReq}</code>
        </pre>
        <h3>
          Response <span className="text-ink-muted font-normal">200</span>
        </h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{updateRes}</code>
        </pre>
        <h3>Errors</h3>
        <table>
          <tbody>
            <tr>
              <td>
                <code>403</code>
              </td>
              <td>
                No write access, or a change to <code>public</code> without the owner or admin role.
              </td>
            </tr>
            <tr>
              <td>
                <code>409</code>
              </td>
              <td>The account already has a collection with the new slug.</td>
            </tr>
            <tr>
              <td>
                <code>422</code>
              </td>
              <td>The new slug is not a valid slug.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="delete-api-collections-owner-slug">DELETE /api/collections/:owner/:slug</h2>
        <p className="scope">
          Auth: owner or admin of the owning organization, by session or an <code>admin</code> key
          (a <code>write</code> key acts as a member and gets <code>403</code>)
        </p>
        <p>
          Delete a collection with its versions, push sessions and webhooks. Stored records and
          files are not deleted with it (they may be shared with other collections).
        </p>
        <h3>
          Response <span className="text-ink-muted font-normal">200</span>
        </h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{okRes}</code>
        </pre>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="get-api-accounts-owner-collections">GET /api/accounts/:owner/collections</h2>
        <p className="scope">No auth required</p>
        <p>
          List an account&rsquo;s collections, most recently updated first. Members of the account
          see all of them; everyone else sees only public ones. An unknown account returns{' '}
          <code>200</code> with an empty list.
        </p>
        <h3>
          Response <span className="text-ink-muted font-normal">200</span>
        </h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{listRes}</code>
        </pre>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="post-api-collections-owner-slug-metadata">
          POST /api/collections/:owner/:slug/metadata
        </h2>
        <p className="scope">Auth: write access</p>
        <p>
          Update version metadata by creating a new patch version. The request body is a JSON object
          (at most 8 MiB) whose fields are merged with the previous version&rsquo;s metadata. Use
          this to update <code>description</code>, <code>readme</code>, <code>license</code>, or any
          other metadata fields without pushing new records.
        </p>
        <h3>Request</h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
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
                Any other key-value pairs. All fields are merged into the previous version&rsquo;s
                metadata object; <code>null</code> removes a field.
              </td>
            </tr>
          </tbody>
        </table>
        <h3>
          Response <span className="text-ink-muted font-normal">201</span>
        </h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{metadataRes}</code>
        </pre>
        <p>
          When nothing changes, the response is <code>200 {'{ "semver", "unchanged": true }'}</code>{' '}
          and no version is made.
        </p>
        <h3>Errors</h3>
        <table>
          <tbody>
            <tr>
              <td>
                <code>400</code>
              </td>
              <td>The body is not a JSON object, or breaks the input rules.</td>
            </tr>
            <tr>
              <td>
                <code>409</code>
              </td>
              <td>
                Version conflict: another version was published while this one was made. Retry.
              </td>
            </tr>
            <tr>
              <td>
                <code>413</code>
              </td>
              <td>The body is over 8 MiB.</td>
            </tr>
            <tr>
              <td>
                <code>422</code>
              </td>
              <td>No versions exist yet. Push a version first before updating metadata.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="post-api-collections-owner-slug-transfer">
          POST /api/collections/:owner/:slug/transfer
        </h2>
        <p className="scope">
          Auth: owner or admin of both the current and the target organization, by session or an{' '}
          <code>admin</code> key
        </p>
        <p>
          Move a collection to another organization. Its slug stays the same, so the target must not
          already have a collection with that slug.
        </p>
        <h3>Request</h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{transferReq}</code>
        </pre>
        <h3>
          Response <span className="text-ink-muted font-normal">200</span>
        </h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{transferRes}</code>
        </pre>
        <h3>Errors</h3>
        <table>
          <tbody>
            <tr>
              <td>
                <code>400</code>
              </td>
              <td>
                <code>targetOrgSlug</code> is missing.
              </td>
            </tr>
            <tr>
              <td>
                <code>403</code>
              </td>
              <td>
                Not an owner or admin of the collection&rsquo;s organization or of the target.
              </td>
            </tr>
            <tr>
              <td>
                <code>404</code>
              </td>
              <td>Collection not found, or no organization with the target slug.</td>
            </tr>
            <tr>
              <td>
                <code>409</code>
              </td>
              <td>The target organization already has a collection with this slug.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="post-api-collections-owner-slug-fork">POST /api/collections/:owner/:slug/fork</h2>
        <p className="scope">
          Auth: member of the target organization, by session or a <code>write</code> or{' '}
          <code>admin</code> key not scoped to specific collections
        </p>
        <p>
          Fork any collection you can read into a target organization. The fork is a new, private
          collection whose first version, <code>v1.0.0</code> with the message{' '}
          <code>Forked from &lt;slug&gt; &lt;semver&gt;</code>, reuses the source&rsquo;s latest
          version. Records, schemas, and files are referenced, not copied, so a fork takes no
          additional storage. Both collections must share a storage location.
        </p>
        <p>
          A member of the source&rsquo;s organization forks both its public and its private records.
          Anyone else forks the public records only.
        </p>
        <h3>Request</h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
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
                Optional slug for the new collection. Defaults to the source collection&rsquo;s
                slug.
              </td>
            </tr>
          </tbody>
        </table>
        <h3>
          Response <span className="text-ink-muted font-normal">201</span>
        </h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{forkRes}</code>
        </pre>
        <h3>Errors</h3>
        <table>
          <tbody>
            <tr>
              <td>
                <code>400</code>
              </td>
              <td>
                <code>targetOrg</code> is missing.
              </td>
            </tr>
            <tr>
              <td>
                <code>401</code>
              </td>
              <td>Not authenticated.</td>
            </tr>
            <tr>
              <td>
                <code>403</code>
              </td>
              <td>
                Not a member of the target org, or a <code>read</code> key or a key scoped to
                specific collections.
              </td>
            </tr>
            <tr>
              <td>
                <code>404</code>
              </td>
              <td>Source collection not found or not readable by you, or target org not found.</td>
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
              <td>
                The slug is not a valid slug, or the source collection has no versions to fork.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </DocsLayout>
  )
}
