import DocsLayout from '~/components/DocsLayout'
import { HELP_EMAIL } from '~/lib/contact'

const meRes = `{
  "id": "uuid",
  "name": "Jane Doe",
  "email": "user@example.com",
  "image": "https://...",
  "displayName": "Jane Doe",
  "createdAt": "2026-01-15T00:00:00.000Z",
  "orgs": [
    {
      "organizationId": "uuid",
      "role": "member",
      "slug": "knowledge-futures",
      "name": "Knowledge Futures"
    }
  ]
}`

const accountRes = `{
  "id": "uuid",
  "name": "Knowledge Futures",
  "slug": "knowledge-futures",
  "displayName": "Knowledge Futures",
  "avatarUrl": "https://...",
  "logo": null,
  "bio": "Open infrastructure for knowledge",
  "website": "https://www.knowledgefutures.org",
  "tagline": "Open infrastructure for knowledge",
  "location": "Cambridge, MA",
  "coverColor": "#22394f",
  "coverImageUrl": null,
  "coverTint": true,
  "provenanceNote": null,
  "pinned": ["uuid"],
  "createdAt": "2026-01-15T00:00:00.000Z",
  "arkNaan": "12345",
  "arkShoulder": "ul"
}`

const membersRes = `[
  { "role": "owner", "displayName": "Jane Doe", "public": true, "you": true },
  { "role": "member", "displayName": "Alex Smith", "public": false, "you": false }
]`

const membersPublicRes = `[
  { "displayName": "Jane Doe" }
]`

const membersMeReq = `{ "public": true }`

const updateOrgReq = `{
  "displayName": "Knowledge Futures",
  "tagline": "Open infrastructure for knowledge",
  "bio": "We build **open** tools for publishing and data.",
  "website": "https://www.knowledgefutures.org",
  "coverColor": "#22394f",
  "pinned": ["uuid", "uuid"]
}`

const activityRes = `[
  {
    "collectionSlug": "pubpub-archive",
    "collectionName": "PubPub Archive",
    "semver": "v1.2.0",
    "message": "Add 2025 pubs",
    "recordCount": 48210,
    "createdAt": "2026-04-01T00:00:00.000Z"
  }
]`

const updateOrgRes = `{ "ok": true, "slug": "knowledge-futures" }`

const okRes = `{ "ok": true }`

const createOrgReq = `{
  "name": "My Lab",
  "slug": "my-lab",
  "kfOrgId": "kf-account-id"
}`

const acceptReq = `{ "token": "invitation-id" }`

const acceptRes = `{ "ok": true, "orgSlug": "my-lab" }`

const createKeyReq = `{
  "name": "my-sync-script",
  "metadata": { "scope": "write", "collectionIds": ["uuid"] },
  "expiresIn": 7776000
}`

const createKeyRes = `{
  "id": "uuid",
  "name": "my-sync-script",
  "start": "ul_a1b",
  "prefix": "ul",
  "enabled": true,
  "metadata": { "scope": "write", "collectionIds": ["uuid"] },
  "permissions": { "collections": ["write", "read"] },
  "expiresAt": "2026-04-15T00:00:00.000Z",
  "createdAt": "2026-01-15T00:00:00.000Z",
  "key": "ul_a1b2c3d4e5..."
}`

const listKeyRes = `{
  "apiKeys": [
    {
      "id": "uuid",
      "name": "my-sync-script",
      "start": "ul_a1b",
      "metadata": { "scope": "write", "collectionIds": ["uuid"] },
      "permissions": { "collections": ["write", "read"] },
      "createdAt": "2026-01-15T00:00:00.000Z",
      "expiresAt": "2026-04-15T00:00:00.000Z"
    }
  ],
  "total": 1
}`

const deleteKeyReq = `{ "keyId": "uuid" }`

const deleteKeyRes = `{ "success": true }`

export default function DocsApiAccounts() {
  return (
    <DocsLayout title="Accounts API">
      <p>Manage accounts, organizations and API keys.</p>

      <h2 id="authentication">Authentication</h2>
      <p>There are two authentication methods:</p>
      <ul>
        <li>
          <strong>Session cookies</strong>: set via OAuth2/PKCE sign-in through{' '}
          <a href="https://auth.knowledgefutures.org" className="text-link hover:underline">
            KF Auth
          </a>{' '}
          (handled by better-auth at <code>/api/auth/*</code>), used by the web UI
        </li>
        <li>
          <strong>API keys</strong>: <code>Authorization: Bearer ul_...</code>, used by apps and
          scripts
        </li>
      </ul>
      <p>
        User accounts are created automatically on first sign-in via KF Auth (OAuth2/PKCE). There
        are no local signup or login endpoints. Collections belong to organizations, and each
        organization to a Knowledge Futures account.
      </p>
      <p>
        API keys have three scopes: <code>read</code>, <code>write</code> and <code>admin</code>. A
        key never does more than its holder&rsquo;s role allows; see{' '}
        <a href="/docs/api#authentication" className="text-link hover:underline">
          Authentication
        </a>{' '}
        in the overview. The account endpoints below act for a user, so they take a session or an
        unscoped personal key: a key scoped to specific collections, or a key owned by an
        organization, gets <code>403</code>. Endpoints that change something also refuse{' '}
        <code>read</code> keys. Changing or deleting an organization, setting its NAAN (
        <code>PATCH /api/accounts/:slug/ark</code>) and deleting your own account (
        <code>DELETE /api/accounts/me</code>, from your settings) take a session or an{' '}
        <code>admin</code> key: a <code>write</code> key gets <code>403</code>, even when its holder
        is an owner. The <code>/api/auth/*</code> endpoints (organizations and API keys) need a
        signed-in session.
      </p>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="get-api-accounts-me">GET /api/accounts/me</h2>
        <p className="scope">Auth: session or an unscoped personal API key (any scope)</p>
        <p>
          Get the authenticated user, with every organization they belong to.{' '}
          <code>displayName</code> is the user&rsquo;s name.
        </p>
        <h3>
          Response <span className="text-ink-muted font-normal">200</span>
        </h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{meRes}</code>
        </pre>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="get-api-accounts-slug">GET /api/accounts/:slug</h2>
        <p className="scope">No auth required</p>
        <p>
          Get the public profile of any account: what its page at <code>/:slug</code> shows.{' '}
          <code>bio</code> is Markdown. <code>pinned</code> lists the ids of the collections shown
          first on its page, in order, leaving out private ones unless you are a member.{' '}
          <code>arkNaan</code> and <code>arkShoulder</code> are null when the account has no ARK
          settings of its own. An unknown slug returns <code>404</code>.
        </p>
        <h3>
          Response <span className="text-ink-muted font-normal">200</span>
        </h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{accountRes}</code>
        </pre>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="get-api-accounts-slug-members">GET /api/accounts/:slug/members</h2>
        <p className="scope">No auth required</p>
        <p>
          List an account&rsquo;s members. The organization&rsquo;s own members see everyone, with
          their roles (<code>owner</code>, <code>admin</code> or <code>member</code>), whether each
          is listed publicly, and which is the caller. Anyone else sees only the members who chose
          to be listed, by name, without roles. An unknown slug returns <code>404</code>.
        </p>
        <h3>
          Response to a member <span className="text-ink-muted font-normal">200</span>
        </h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{membersRes}</code>
        </pre>
        <h3>
          Response to anyone else <span className="text-ink-muted font-normal">200</span>
        </h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{membersPublicRes}</code>
        </pre>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="get-api-accounts-slug-activity">GET /api/accounts/:slug/activity</h2>
        <p className="scope">No auth required</p>
        <p>
          Recent versions across an organization&rsquo;s collections, newest first (
          <code>?limit=</code>, default 20, at most 50). Members see their private
          collections&rsquo; versions too; everyone else sees public collections&rsquo; versions
          only. An unknown slug returns <code>404</code>.
        </p>
        <h3>
          Response <span className="text-ink-muted font-normal">200</span>
        </h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{activityRes}</code>
        </pre>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="put-api-accounts-slug-members-me">PUT /api/accounts/:slug/members/me</h2>
        <p className="scope">Auth: a member, by session or a write or admin key</p>
        <p>
          Show or hide your own membership on the organization&rsquo;s public page. Members are
          hidden until they choose to be listed.
        </p>
        <h3>Request</h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{membersMeReq}</code>
        </pre>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="patch-api-accounts-slug">PATCH /api/accounts/:slug</h2>
        <p className="scope">
          Auth: an owner of the account, by session or an unscoped personal <code>admin</code> key
        </p>
        <p>
          Update an organization&rsquo;s profile and page. Pass only the fields to change:{' '}
          <code>slug</code>, <code>displayName</code>, <code>tagline</code> (up to 160 characters),{' '}
          <code>bio</code> (Markdown, up to 5,000), <code>website</code> (an <code>http</code> or{' '}
          <code>https</code> address), <code>location</code>, <code>coverTint</code> (whether a
          cover image takes the cover color), <code>coverColor</code> (<code>#rrggbb</code>),{' '}
          <code>provenanceNote</code> (up to 300), <code>pinned</code> (up to four of its own
          collections&rsquo; ids, in order) and <code>kfOrgId</code> (the KF account it belongs to,
          which must be one you belong to). <code>null</code> or an empty string clears a text field
          or the cover color; <code>kfOrgId</code> can move to another KF account but can&rsquo;t be
          cleared (<code>422</code>).
        </p>
        <h3>Request</h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{updateOrgReq}</code>
        </pre>
        <h3>
          Response <span className="text-ink-muted font-normal">200</span>
        </h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{updateOrgRes}</code>
        </pre>
        <h3>Errors</h3>
        <table>
          <tbody>
            <tr>
              <td>
                <code>403</code>
              </td>
              <td>
                Not an owner of the account, a <code>write</code> key, or a <code>kfOrgId</code> you
                don&rsquo;t belong to.
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
              <td>The new slug is already taken.</td>
            </tr>
            <tr>
              <td>
                <code>422</code>
              </td>
              <td>
                The new slug is not a valid slug, a field is too long, the website or cover color is
                not valid, or <code>pinned</code> names another organization&rsquo;s collection.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="delete-api-accounts-slug">DELETE /api/accounts/:slug</h2>
        <p className="scope">
          Auth: an owner of the organization, by session or an unscoped personal <code>admin</code>{' '}
          key
        </p>
        <p>
          Delete an organization, with its memberships, invitations and API keys. An organization
          that still holds collections is refused with <code>409</code>: delete or transfer them
          first.
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
        <h2 id="post-api-auth-organization-create">POST /api/auth/organization/create</h2>
        <p className="scope">Auth: session</p>
        <p>
          Create an organization, with you as its owner. Managed by better-auth&rsquo;s organization
          plugin; the slug must be a valid, unused account slug, and <code>kfOrgId</code> a
          Knowledge Futures account you belong to (<code>GET /api/accounts/available-kf-orgs</code>
          lists them). Without one the request is refused with <code>403</code>; email{' '}
          <a href={`mailto:${HELP_EMAIL}`} className="text-link hover:underline">
            {HELP_EMAIL}
          </a>{' '}
          to have one set up. <code>GET /api/auth/organization/list</code> lists the organizations
          you belong to.
        </p>
        <h3>Request</h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{createOrgReq}</code>
        </pre>
        <p>
          better-auth&rsquo;s <code>POST /api/auth/organization/update</code> and{' '}
          <code>POST /api/auth/organization/delete</code> are not served: they return{' '}
          <code>404</code> pointing at <code>PATCH</code> and{' '}
          <code>DELETE /api/accounts/:slug</code>, which apply Underlay&rsquo;s rules for slugs and
          for organizations that still hold collections.
        </p>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="post-api-accounts-invitations-accept">POST /api/accounts/invitations/accept</h2>
        <p className="scope">
          Auth: session or an unscoped personal key with <code>write</code> or <code>admin</code>{' '}
          scope
        </p>
        <p>
          Accept an invitation to an organization. <code>token</code> is the invitation&rsquo;s id;
          the invitation must be pending, unexpired and addressed to your account&rsquo;s email.
          Anything else returns <code>404</code>, whatever the reason.
        </p>
        <h3>Request</h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{acceptReq}</code>
        </pre>
        <h3>
          Response <span className="text-ink-muted font-normal">200</span>
        </h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{acceptRes}</code>
        </pre>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="post-api-auth-api-key-create">POST /api/auth/api-key/create</h2>
        <p className="scope">Auth: session</p>
        <p>
          Create a new API key for the signed-in user. Managed by better-auth&rsquo;s apiKey plugin.
          The raw <code>key</code> is in this response only; it is never shown again.
        </p>
        <h3>Request</h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{createKeyReq}</code>
        </pre>
        <h3>Fields</h3>
        <table>
          <tbody>
            <tr>
              <td>
                <code>name</code>
              </td>
              <td>Optional label, at most 32 characters.</td>
            </tr>
            <tr>
              <td>
                <code>metadata.scope</code>
              </td>
              <td>
                <code>read</code> (the default), <code>write</code> or <code>admin</code>.
              </td>
            </tr>
            <tr>
              <td>
                <code>metadata.collectionIds</code>
              </td>
              <td>
                Optional. Collection ids the key is confined to; omit it for a key that works
                wherever its holder does.
              </td>
            </tr>
            <tr>
              <td>
                <code>expiresIn</code>
              </td>
              <td>
                Optional lifetime in seconds, at most 365 days. Omitted, the key never expires.
              </td>
            </tr>
          </tbody>
        </table>
        <h3>
          Response <span className="text-ink-muted font-normal">200</span>
        </h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{createKeyRes}</code>
        </pre>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="get-api-auth-api-key-list">GET /api/auth/api-key/list</h2>
        <p className="scope">Auth: session</p>
        <p>
          List the signed-in user&rsquo;s API keys. The raw key is not included. Takes optional{' '}
          <code>limit</code> and <code>offset</code> query parameters; <code>total</code> counts
          every key.
        </p>
        <h3>
          Response <span className="text-ink-muted font-normal">200</span>
        </h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{listKeyRes}</code>
        </pre>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="post-api-auth-api-key-delete">POST /api/auth/api-key/delete</h2>
        <p className="scope">Auth: session</p>
        <p>Revoke one of your API keys.</p>
        <h3>Request</h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{deleteKeyReq}</code>
        </pre>
        <h3>
          Response <span className="text-ink-muted font-normal">200</span>
        </h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{deleteKeyRes}</code>
        </pre>
      </div>
    </DocsLayout>
  )
}
