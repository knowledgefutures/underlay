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
  "label": "my-sync-script",
  "scope": "write",
  "collectionId": "uuid (optional — scope key to one collection)"
}`

const createKeyRes = `{
  "id": "uuid",
  "key": "ul_a1b2c3d4e5...",
  "label": "my-sync-script",
  "scope": "write",
  "collectionId": null
}`

const deleteKeyRes = `{"ok": true}`

export default function DocsApiAccounts() {
  return (
    <DocsLayout title='Accounts API'>
      <p>Manage accounts and API keys.</p>

      <h2>Authentication</h2>
      <p>There are two authentication methods:</p>
      <ul>
        <li>
          <strong>Session cookies</strong> — set via SSO login through{' '}
          <a href='https://auth.knowledgefutures.org' className='text-link hover:underline'>KF Auth</a>, used by the web
          UI
        </li>
        <li>
          <strong>API keys</strong> — <code>Authorization: Bearer ul_...</code>, used by apps and scripts
        </li>
      </ul>
      <p>
        User accounts are created automatically on first sign-in via KF Auth (OIDC SSO). There are no local signup or
        login endpoints.
      </p>
      <p>
        API keys have three scopes: <code>read</code>, <code>write</code>,{' '}
        <code>admin</code>. A key can optionally be scoped to a single collection.
      </p>

      <hr className='border-rule my-6' />

      <div className='endpoint'>
        <h2>GET /api/accounts/me</h2>
        <p className='scope'>Auth: session or API key (any scope)</p>
        <p>Get the authenticated account.</p>
        <h3>
          Response <span className='text-ink-muted font-normal'>200</span>
        </h3>
        <pre className='bg-ink text-parchment p-3 text-xs overflow-x-auto'><code>{meRes}</code></pre>
      </div>

      <hr className='border-rule my-6' />

      <div className='endpoint'>
        <h2>GET /api/accounts/:slug</h2>
        <p className='scope'>No auth required</p>
        <p>Get public profile for any account.</p>
        <h3>
          Response <span className='text-ink-muted font-normal'>200</span>
        </h3>
        <pre className='bg-ink text-parchment p-3 text-xs overflow-x-auto'><code>{accountRes}</code></pre>
      </div>

      <hr className='border-rule my-6' />

      <div className='endpoint'>
        <h2>POST /api/accounts/keys</h2>
        <p className='scope'>Auth: session or API key (any scope)</p>
        <p>Create a new API key. The raw key is returned only once.</p>
        <h3>Request</h3>
        <pre className='bg-ink text-parchment p-3 text-xs overflow-x-auto'><code>{createKeyReq}</code></pre>
        <h3>
          Response <span className='text-ink-muted font-normal'>201</span>
        </h3>
        <pre className='bg-ink text-parchment p-3 text-xs overflow-x-auto'><code>{createKeyRes}</code></pre>
      </div>

      <hr className='border-rule my-6' />

      <div className='endpoint'>
        <h2>GET /api/accounts/keys</h2>
        <p className='scope'>Auth: session or API key (any scope)</p>
        <p>List all API keys for the authenticated account. The raw key is not included.</p>
      </div>

      <hr className='border-rule my-6' />

      <div className='endpoint'>
        <h2>DELETE /api/accounts/keys/:id</h2>
        <p className='scope'>Auth: session or API key (any scope)</p>
        <p>Revoke an API key.</p>
        <h3>
          Response <span className='text-ink-muted font-normal'>200</span>
        </h3>
        <pre className='bg-ink text-parchment p-3 text-xs overflow-x-auto'><code>{deleteKeyRes}</code></pre>
      </div>
    </DocsLayout>
  )
}
