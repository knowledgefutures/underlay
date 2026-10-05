import { Link } from 'react-router'

import DocsLayout from '~/components/DocsLayout'

const rateLimitRes = `{
  "error": "Rate limit exceeded",
  "statusCode": 429
}`

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

      <h2 id="base-url">Base URL</h2>
      <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
        <code>{'https://underlay.org/api'}</code>
      </pre>

      <hr className="border-rule my-6" />

      <h2 id="authentication">Authentication</h2>
      <p>
        <code>GET</code> and <code>HEAD</code> requests need no authentication to read public data.
        Writes (<code>POST</code>, <code>PATCH</code>, <code>PUT</code>, <code>DELETE</code>)
        require authentication, with three exceptions. <code>POST /api/records/batch</code> and{' '}
        <code>POST .../files/presign</code> are reads sent as POSTs, because their hash lists are
        too long for a query string; they are reachable anonymously and make the same access checks
        as the matching <code>GET</code>s. <code>POST /api/abuse-reports</code> is open to anyone.
      </p>
      <p>
        A key may also be passed as <code>?token=</code> in the query string (this is how share and
        agent links work). That form is honored on <code>GET</code>/<code>HEAD</code> only, so a
        link prefetch can never drive a mutation; everything else must send an{' '}
        <code>Authorization: Bearer</code> header. An invalid or expired <code>?token=</code> is
        rejected with <code>401</code>, as a Bearer key is; it does not fall back to anonymous
        access.
      </p>

      <p>There are two authentication methods:</p>

      <h3>API Keys (recommended for scripts &amp; apps)</h3>
      <p>Pass your key as a Bearer token:</p>
      <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
        <code>{'Authorization: Bearer ul_a1b2c3d4e5...'}</code>
      </pre>
      <p>
        A key has one of three scopes, set as <code>metadata.scope</code> when it is created:
      </p>
      <ul>
        <li>
          <code>read</code>: list and download what the key&rsquo;s holder can see
        </li>
        <li>
          <code>write</code>: also push versions, upload files, and create and edit collections, as
          a member of the owning organization
        </li>
        <li>
          <code>admin</code>: also the holder&rsquo;s owner or admin powers
        </li>
      </ul>
      <p>
        A key never does more than its holder&rsquo;s role allows, and <code>read</code> and{' '}
        <code>write</code> keys act as a plain member even when the holder is an owner. Owner and
        admin actions on a collection (deleting it, changing whether it is public, transferring it,
        managing its webhooks, storage and mirrors) need a signed-in session or an{' '}
        <code>admin</code> key held by an owner or admin of the owning organization.
      </p>
      <p>
        A key scoped to specific collections (this is how share and agent links work) is confined to
        them: it is rejected with <code>403</code> on account and organization endpoints, cannot
        enumerate other collections, and is treated as anonymous outside its scope.
      </p>
      <p>
        Create keys in your{' '}
        <Link to="/settings" className="text-link underline">
          settings
        </Link>{' '}
        or with <code>POST /api/auth/api-key/create</code>. The <code>/api/auth/api-key/*</code>{' '}
        routes need a signed-in session: a key cannot create, list or revoke keys.
      </p>

      <h3>Session Cookies (browser)</h3>
      <p>
        The web UI authenticates via OAuth2/PKCE sign-in through KF Auth, handled by better-auth at{' '}
        <code>/api/auth/*</code>. A session lasts 7 days and is renewed while it is in use.
      </p>

      <h3>Invalid Credentials</h3>
      <p>
        If a key is provided (as a <code>Bearer</code> token or as <code>?token=</code>) but is not
        a valid key, the request is <strong>immediately rejected</strong> with <code>401</code>. It
        will not fall through to anonymous access.
      </p>

      <hr className="border-rule my-6" />

      <h2 id="rate-limits">Rate Limits</h2>
      <p>
        Every request spends units from a per-minute budget: the caller&rsquo;s own budget when
        authenticated, or one shared by its IP address when anonymous.
      </p>

      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-rule border-b text-left">
            <th className="py-2 pr-4">Caller</th>
            <th className="py-2">Budget</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-rule border-b">
            <td className="py-2 pr-4">
              Anonymous API calls (<code>/api/*</code>), per IP
            </td>
            <td className="py-2 font-mono">60 units / minute</td>
          </tr>
          <tr className="border-rule border-b">
            <td className="py-2 pr-4">
              Anonymous web pages, ARK resolution and the sign-in routes (<code>/api/auth/*</code>),
              per IP
            </td>
            <td className="py-2 font-mono">600 units / minute</td>
          </tr>
          <tr className="border-rule border-b">
            <td className="py-2 pr-4">
              Authenticated (session or API key), per user; a key owned by an organization, per
              organization
            </td>
            <td className="py-2 font-mono">5,000 units / minute</td>
          </tr>
        </tbody>
      </table>

      <p className="mt-3">Most API requests cost one unit. Requests that read a lot cost more:</p>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-rule border-b text-left">
            <th className="py-2 pr-4">Request</th>
            <th className="py-2">Cost</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-rule border-b">
            <td className="py-2 pr-4">
              <code>/api/collections/:owner/:slug/export</code>
            </td>
            <td className="py-2 font-mono">20</td>
          </tr>
          <tr className="border-rule border-b">
            <td className="py-2 pr-4">
              <code>.../versions/:n/pack</code>, <code>.../versions/:n/records.ndjson</code> and{' '}
              <code>.../versions/:n/records.ndjson.gz</code>
            </td>
            <td className="py-2 font-mono">10</td>
          </tr>
          <tr className="border-rule border-b">
            <td className="py-2 pr-4">
              <code>POST /api/records/batch</code>, <code>/api/records/:hash/provenance</code>,{' '}
              <code>.../diff</code> and <code>.../history</code>
            </td>
            <td className="py-2 font-mono">5</td>
          </tr>
          <tr className="border-rule border-b">
            <td className="py-2 pr-4">Web pages (record pages cost 5)</td>
            <td className="py-2 font-mono">2</td>
          </tr>
          <tr className="border-rule border-b">
            <td className="py-2 pr-4">Everything else</td>
            <td className="py-2 font-mono">1</td>
          </tr>
        </tbody>
      </table>

      <p className="mt-3">
        Responses carry no rate-limit headers. A request over budget gets{' '}
        <code>429 Too Many Requests</code> with <code>Retry-After: 60</code> and this body:
      </p>
      <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
        <code>{rateLimitRes}</code>
      </pre>
      <p>
        On Cloudflare Workers the count is kept per Cloudflare location, so the limits are
        approximate. For any automated or scripted access, <strong>always use an API key</strong> to
        get the higher budget.
      </p>

      <hr className="border-rule my-6" />

      <h2 id="error-responses">Error Responses</h2>
      <p>
        Errors return a JSON body with <code>error</code> and <code>statusCode</code>. Some add
        fields of their own, such as <code>filesNeeded</code> on a missing-files <code>422</code>:
      </p>
      <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
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
          <code>403</code>: Insufficient permissions: a scope or role that doesn&rsquo;t allow the
          action, an API key used outside the collections it is scoped to, or a collection-scoped
          key on an account or organization endpoint
        </li>
        <li>
          <code>404</code>: Resource not found, <em>or</em> not visible to you. Private collections
          and inaccessible files return 404 rather than 403, so a response cannot confirm they exist
        </li>
        <li>
          <code>409</code>: Version conflict (re-fetch and retry), a slug that is already taken, or
          no changes: the push has the same content as the latest version
        </li>
        <li>
          <code>413</code>: Payload too large (a body or file over its size limit)
        </li>
        <li>
          <code>422</code>: Validation error (e.g. missing files)
        </li>
        <li>
          <code>429</code>: Rate limited, or too many push sessions open at once; wait for{' '}
          <code>Retry-After</code> and retry
        </li>
        <li>
          <code>451</code>: The file has been withheld and is not served
        </li>
        <li>
          <code>503</code>: Storage is briefly busy while cleanup runs; retry after{' '}
          <code>Retry-After</code> (30 seconds)
        </li>
      </ul>

      <hr className="border-rule my-6" />

      <h2 id="endpoints">Endpoints</h2>
      <nav className="space-y-2 text-sm">
        <div>
          <Link to="/docs/api/accounts" className="text-link underline">
            Accounts
          </Link>
          : profiles, organizations, API keys
        </div>
        <div>
          <Link to="/docs/api/collections" className="text-link underline">
            Collections
          </Link>
          : create, list, update, delete, transfer, fork
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
