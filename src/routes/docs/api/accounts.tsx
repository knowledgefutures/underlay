import DocsLayout from '~/components/DocsLayout'

const meRes = `{
  "id": "uuid",
  "slug": "jdoe",
  "type": "user",
  "displayName": "Jane Doe",
  "email": "user@example.com",
  "createdAt": "2026-01-15T00:00:00.000Z"
}`

const accountRes = `{
  "id": "uuid",
  "slug": "knowledge-futures",
  "type": "org",
  "displayName": "Knowledge Futures",
  "createdAt": "2026-01-15T00:00:00.000Z"
}`

const createKeyReq = `{
  "name": "my-sync-script",
  "metadata": { "scope": "write" },
  "prefix": "ul"
}`

const createKeyRes = `{
  "id": "uuid",
  "key": "ul_a1b2c3d4e5...",
  "name": "my-sync-script",
  "metadata": { "scope": "write" },
  "prefix": "ul"
}`

const deleteKeyReq = `{ "keyId": "uuid" }`

const deleteKeyRes = `{"ok": true}`

export default function DocsApiAccounts() {
  return (
    <DocsLayout title="Accounts API">
      <p>Manage accounts and API keys.</p>

      <h2>Authentication</h2>
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
        are no local signup or login endpoints.
      </p>
      <p>
        API keys have two grantable scopes: <code>read</code> and <code>write</code>. The scope is
        stored in key metadata and translated to permissions server-side; because that metadata is
        client-supplied, a request for <code>admin</code> is clamped down to <code>write</code>{' '}
        rather than honored. A key can optionally be scoped to specific collections, in which case
        it is refused on account and organization endpoints.
      </p>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2>GET /api/accounts/me</h2>
        <p className="scope">Auth: session or API key (any scope)</p>
        <p>Get the authenticated account.</p>
        <h3>
          Response <span className="text-ink-muted font-normal">200</span>
        </h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{meRes}</code>
        </pre>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2>GET /api/accounts/:slug</h2>
        <p className="scope">No auth required</p>
        <p>Get public profile for any account.</p>
        <h3>
          Response <span className="text-ink-muted font-normal">200</span>
        </h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{accountRes}</code>
        </pre>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2>POST /api/auth/api-key/create</h2>
        <p className="scope">Auth: session or API key (any scope)</p>
        <p>
          Create a new API key. The raw key is returned only once. Managed by better-auth's apiKey
          plugin.
        </p>
        <h3>Request</h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{createKeyReq}</code>
        </pre>
        <h3>
          Response <span className="text-ink-muted font-normal">200</span>
        </h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{createKeyRes}</code>
        </pre>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2>GET /api/auth/api-key/list</h2>
        <p className="scope">Auth: session or API key (any scope)</p>
        <p>
          List all API keys for the authenticated account. Returns id, name, start, permissions,
          metadata, createdAt, and expiresAt. The raw key is not included.
        </p>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2>POST /api/auth/api-key/delete</h2>
        <p className="scope">Auth: session or API key (any scope)</p>
        <p>Revoke an API key.</p>
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
