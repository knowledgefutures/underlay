import { Link } from 'react-router'

import DocsLayout from '~/components/DocsLayout'

export default function DocsApi() {
  return (
    <DocsLayout title="API Overview">
      <p>
        The Underlay API is a JSON REST API served at <code>/api</code>. All request and response
        bodies are JSON (except file uploads/downloads). A machine-readable reference is available
        at{' '}
        <a href="/llms.txt" className="text-link underline">
          /llms.txt
        </a>
        .
      </p>

      <h2>Base URL</h2>
      <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
        <code>{'https://underlay.org/api'}</code>
      </pre>

      <hr className="border-rule my-6" />

      <h2>Authentication</h2>
      <p>
        All <code>GET</code> requests are <strong>public</strong>; no authentication required to
        read public data. All write requests (<code>POST</code>, <code>PATCH</code>,{' '}
        <code>PUT</code>, <code>DELETE</code>) require authentication.
      </p>

      <p>There are two authentication methods:</p>

      <h3>API Keys (recommended for scripts &amp; apps)</h3>
      <p>Pass your key as a Bearer token:</p>
      <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
        <code>{'Authorization: Bearer ul_a1b2c3d4e5...'}</code>
      </pre>
      <p>Keys have two grantable scopes:</p>
      <ul>
        <li>
          <code>read</code>: list and download data
        </li>
        <li>
          <code>write</code>: push versions, upload files, manage collections you have rights to
        </li>
      </ul>
      <p>
        <code>admin</code> is not grantable through the API — a request for it is clamped down to{' '}
        <code>write</code>. Destructive actions such as deleting a collection are gated on your{' '}
        <strong>role in the owning organization</strong> (owner or admin), not on a key scope.
      </p>
      <p>
        A key scoped to specific collections (this is how share and agent links work) is confined to
        them: it is rejected with <code>403</code> on account and organization endpoints, cannot
        enumerate other collections, and is treated as anonymous outside its scope.
      </p>
      <p>
        Keys can optionally be scoped to a single collection. Create keys in your{' '}
        <Link to="/settings" className="text-link underline">
          organization settings
        </Link>{' '}
        or via <code>POST /api/auth/api-key/create</code>.
      </p>

      <h3>Session Cookies (browser)</h3>
      <p>
        The web UI authenticates via OAuth2/PKCE sign-in through KF Auth, handled by better-auth at{' '}
        <code>/api/auth/*</code>. Sessions expire after 30 days.
      </p>

      <h3>Invalid Credentials</h3>
      <p>
        If a <code>Bearer</code> token is provided but does not match any key, the request is{' '}
        <strong>immediately rejected</strong> with <code>401</code>. It will not fall through to
        anonymous access.
      </p>

      <hr className="border-rule my-6" />

      <h2>Rate Limits</h2>
      <p>
        All API requests are rate-limited per IP (unauthenticated) or per account (authenticated).
        Authenticated requests get a significantly higher allowance:
      </p>

      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-rule border-b text-left">
            <th className="py-2 pr-4">Auth status</th>
            <th className="py-2">Limit</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-rule border-b">
            <td className="py-2 pr-4">Unauthenticated (by IP)</td>
            <td className="py-2 font-mono">60 requests / minute</td>
          </tr>
          <tr className="border-rule border-b">
            <td className="py-2 pr-4">Authenticated (by account)</td>
            <td className="py-2 font-mono">5,000 requests / minute</td>
          </tr>
        </tbody>
      </table>

      <p className="mt-3">Every response includes rate limit headers:</p>
      <ul>
        <li>
          <code>X-RateLimit-Limit</code>: max requests in the current window
        </li>
        <li>
          <code>X-RateLimit-Remaining</code>: requests remaining
        </li>
        <li>
          <code>X-RateLimit-Reset</code>: seconds until the window resets
        </li>
      </ul>
      <p>
        When you exceed the limit, you'll receive a <code>429 Too Many Requests</code> response with
        a <code>Retry-After</code> header indicating how long to wait.
      </p>
      <p>
        For any automated or scripted access, <strong>always use an API key</strong> to get the
        higher rate limit.
      </p>

      <hr className="border-rule my-6" />

      <h2>Error Responses</h2>
      <p>
        Errors return a JSON body with <code>error</code> and <code>statusCode</code>:
      </p>
      <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
        <code>{`{
  "error": "Authentication required",
  "statusCode": 401
}`}</code>
      </pre>

      <p>Common status codes:</p>
      <ul>
        <li>
          <code>400</code>: Bad request (invalid input)
        </li>
        <li>
          <code>401</code>: Authentication required or invalid credentials
        </li>
        <li>
          <code>403</code>: Insufficient permissions (wrong scope)
        </li>
        <li>
          <code>404</code>: Resource not found
        </li>
        <li>
          <code>409</code>: Version conflict (re-fetch and retry)
        </li>
        <li>
          <code>413</code>: Payload too large (file upload exceeds size limit)
        </li>
        <li>
          <code>422</code>: Validation error (e.g. missing files)
        </li>
        <li>
          <code>429</code>: Rate limited (wait and retry)
        </li>
      </ul>

      <hr className="border-rule my-6" />

      <h2>Endpoints</h2>
      <nav className="space-y-2 text-sm">
        <div>
          <Link to="/docs/api/accounts" className="text-link underline">
            Accounts
          </Link>
          : API keys, profiles
        </div>
        <div>
          <Link to="/docs/api/collections" className="text-link underline">
            Collections
          </Link>
          : create, list, update, delete
        </div>
        <div>
          <Link to="/docs/api/versions" className="text-link underline">
            Versions
          </Link>
          : push snapshots, browse history, diff
        </div>
        <div>
          <Link to="/docs/api/files" className="text-link underline">
            Files
          </Link>
          : upload and download content-addressed files
        </div>
      </nav>
    </DocsLayout>
  )
}
