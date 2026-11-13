import { Link } from 'react-router'

import DocsLayout, { CodeBlock } from '~/components/DocsLayout'

/** One endpoint within a section: its method and path, who may call it, and what it does. */
function Endpoint({
  route,
  scope,
  children,
}: {
  route: string
  scope: string
  children?: React.ReactNode
}) {
  return (
    <div className="endpoint">
      <h3 className="!text-ink !mt-5 font-mono !text-[0.85rem] !tracking-normal !normal-case">
        {route}
      </h3>
      <p className="scope">{scope}</p>
      {children}
    </div>
  )
}

const exportExample = `curl -o archive.tar.gz \\
  "https://www.underlay.org/api/collections/kf/archive/export?version=v3.2.0"

tar -tzf archive.tar.gz
# manifest.json
# README.md
# records/Author.ndjson
# records/Publication.ndjson
# files/a1b2c3d4e5f6...`

const manifestRes = `{
  "collection": {
    "id": "uuid",
    "owner": "kf",
    "slug": "archive",
    "name": "PubPub Archive",
    "description": "Full archive of PubPub publications"
  },
  "version": {
    "semver": "v3.2.0",
    "hash": "ulv3:e5f6...",
    "message": "April sync",
    "recordCount": 4521,
    "fileCount": 892,
    "totalBytes": 1073741824,
    "createdAt": "2026-04-01T00:00:00.000Z"
  },
  "schemas": { "Author": { "type": "object" }, "Publication": { "type": "object" } },
  "files_missing": [],
  "files_withheld": []
}`

const webhookCreateReq = `curl -X POST https://www.underlay.org/api/collections/kf/archive/webhooks \\
  -H "Authorization: Bearer $KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"url": "https://example.org/hooks/underlay", "bumpFilter": ["major", "minor"]}'`

const webhookCreateRes = `{
  "id": "uuid",
  "url": "https://example.org/hooks/underlay",
  "bumpFilter": ["major", "minor"],
  "enabled": true,
  "createdAt": "2026-04-01T00:00:00.000Z",
  "lastDeliveryAt": null,
  "secret": "ulwhsec_3f9a..."
}`

const deliveriesRes = `{
  "deliveries": [
    {
      "id": "uuid",
      "event": "version.created",
      "semver": "v3.2.0",
      "bumpType": "minor",
      "status": "success",
      "attempts": 1,
      "responseCode": 200,
      "error": null,
      "durationMs": 184,
      "createdAt": "2026-04-01T00:00:01.000Z",
      "deliveredAt": "2026-04-01T00:00:02.000Z"
    }
  ]
}`

const deliveryBody = `POST /hooks/underlay HTTP/1.1
Content-Type: application/json
User-Agent: Underlay-Webhook/2.0
X-Underlay-Event: version.created
X-Underlay-Delivery: 0b6f...
X-Underlay-Signature: sha256=5d41402abc4b2a76b9719d911017c592...

{
  "event": "version.created",
  "collection": { "owner": "kf", "slug": "archive" },
  "version": {
    "semver": "v3.2.0",
    "hash": "ulv3:e5f6...",
    "major": 3,
    "minor": 2,
    "patch": 0,
    "recordCount": 4521,
    "fileCount": 892
  },
  "bumpType": "minor",
  "delivery": { "id": "0b6f...", "timestamp": "2026-04-01T00:00:01.000Z" }
}`

const verifyExample = `import { createHmac, timingSafeEqual } from 'node:crypto'

// rawBody: the request body exactly as received (a Buffer or string), before JSON.parse.
function verifyUnderlaySignature(secret, rawBody, header) {
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex')
  const a = Buffer.from(expected)
  const b = Buffer.from(header ?? '')
  return a.length === b.length && timingSafeEqual(a, b)
}

// e.g. in an Express handler with express.raw({ type: 'application/json' }):
// if (!verifyUnderlaySignature(SECRET, req.body, req.get('x-underlay-signature')))
//   return res.sendStatus(401)`

const arkShape = `https://underlay.org/ark:<NAAN>/<shoulder><id><check>[.vX.Y.Z][/<Type>/<id>]

https://underlay.org/ark:12345/ulb9bq4n5gmv3k0                    the collection
https://underlay.org/ark:12345/ulb9bq4n5gmv3k0.v3.2.0             a version
https://underlay.org/ark:12345/ulb9bq4n5gmv3k0/Publication/pub-1  a record`

const resolveRes = `{
  "type": "redirect",
  "url": "/kf/archive/v/3.2.0",
  "metadata": {
    "type": "version",
    "who": "Knowledge Futures",
    "what": "PubPub Archive v3.2.0",
    "when": "20260401",
    "where": "https://underlay.org/ark:12345/ulb9bq4n5gmv3k0.v3.2.0",
    "naan": "12345",
    "collectionName": "PubPub Archive",
    "ownerName": "Knowledge Futures",
    "semver": "v3.2.0",
    "message": "April sync",
    "appId": null,
    "createdAt": "2026-04-01T00:00:00.000Z",
    "arkUrl": "https://underlay.org/ark:12345/ulb9bq4n5gmv3k0.v3.2.0"
  }
}`

const healthRes = `{
  "ok": true,
  "version": 2,
  "deployment": "prod",
  "time": "2026-04-01T00:00:00.000Z"
}`

const abuseReq = `{
  "hash": "sha256:a1b2c3d4e5f6...",
  "reason": "This file republishes copyrighted material.",
  "contact": "rights@example.org"
}`

export default function DocsApiSyncAndIntegrations() {
  return (
    <DocsLayout title="Sync and integrations API">
      <p>
        Endpoints for copying collections elsewhere and connecting them to other systems:
        whole-version exports, webhooks, ARK identifiers, and a couple of service endpoints. Paths
        below that start <code>…/:owner/:slug</code> are under <code>/api/collections</code>. Where
        a <code>version</code> is asked for, it is a semver (<code>v1.2.0</code>), a version id (
        <code>ulv3:…</code>) or <code>latest</code>.
      </p>

      <hr className="border-rule my-6" />

      <h2 id="tree-sync">Tree sync</h2>
      <p>
        Reading a collection&rsquo;s log and fetching versions as packs, for mirrors and clients
        that keep a full copy, is not available yet: <code>GET …/:owner/:slug/log</code> and{' '}
        <code>GET …/:owner/:slug/versions/:n/pack</code> answer <code>501</code> with{' '}
        <code>{'"code": "not_on_v3"'}</code>. To copy a version, use the export below, or{' '}
        <Link
          to="/docs/api/versions#get-api-collections-owner-slug-versions-n-records-ndjson"
          className="text-link underline"
        >
          records.ndjson
        </Link>
        .
      </p>

      <hr className="border-rule my-6" />

      <h2 id="export">Export</h2>
      <Endpoint
        route="GET …/:owner/:slug/export?version=&format="
        scope="No auth for public collections"
      >
        <p>
          A whole version as one archive. <code>version</code> defaults to <code>latest</code>;{' '}
          <code>format</code> is <code>tar.gz</code> (the default) or <code>tar</code>. The archive
          is named <code>&lt;owner&gt;-&lt;slug&gt;-&lt;semver&gt;.tar.gz</code> in{' '}
          <code>Content-Disposition</code>. This request counts as 20 requests against your rate
          limit.
        </p>
        <p>Entries, in this order:</p>
        <table>
          <tbody>
            <tr>
              <td>
                <code>manifest.json</code>
              </td>
              <td>Always first: the collection, the version, its schemas, and file notes</td>
            </tr>
            <tr>
              <td>
                <code>README.md</code>
              </td>
              <td>
                The version&rsquo;s <code>metadata.readme</code>, when it has one
              </td>
            </tr>
            <tr>
              <td>
                <code>records/&lt;Type&gt;.ndjson</code>
              </td>
              <td>
                One file per type that has records, one{' '}
                <code>{'{"id", "type", "data", "hash"}'}</code> per line
              </td>
            </tr>
            <tr>
              <td>
                <code>files/&lt;hash&gt;</code>
              </td>
              <td>The bytes of each file, named by its SHA-256 hash</td>
            </tr>
          </tbody>
        </table>
        <CodeBlock>{exportExample}</CodeBlock>
        <p>
          <code>manifest.json</code>: <code>files_missing</code> lists files the version references
          whose bytes the platform doesn&rsquo;t hold, and <code>files_withheld</code> files that
          have been blocked; neither is in <code>files/</code>. Blocked records are left out of the
          NDJSON. <code>totalBytes</code> is the records&rsquo; canonical size plus the files&rsquo;
          size.
        </p>
        <CodeBlock>{manifestRes}</CodeBlock>
        <p>
          The archive streams as it is built, with no limit on the number of records; for very large
          collections, <code>format=tar</code> is quicker to produce. Entries are stamped with the
          time the version was created, so exporting the same version again gives a byte-identical
          archive. If something fails partway, the response is cut off rather than completed, so
          treat an archive that doesn&rsquo;t end cleanly as failed.
        </p>
      </Endpoint>

      <hr className="border-rule my-6" />

      <h2 id="webhooks">Webhooks</h2>
      <p>
        A webhook sends a signed <code>POST</code> to your URL each time a version of the collection
        is published. Managing webhooks takes an owner or admin of the owning organization, signed
        in or with an admin API key; write and read keys, and keys confined to specific collections
        whatever their scope, get <code>403</code>.
      </p>

      <Endpoint route="GET …/:owner/:slug/webhooks" scope="Auth: org owner or admin">
        <p>
          <code>{'{"webhooks": [{id, url, bumpFilter, enabled, createdAt, lastDeliveryAt}]}'}</code>
          , newest first. The secret is never listed.
        </p>
      </Endpoint>

      <Endpoint route="POST …/:owner/:slug/webhooks" scope="Auth: org owner or admin">
        <p>
          Body: <code>{'{"url", "bumpFilter"?, "enabled"?}'}</code>. <code>url</code> must be{' '}
          <code>https</code> and may not name a local or private address (<code>422</code>).{' '}
          <code>bumpFilter</code> is a non-empty list of <code>major</code>, <code>minor</code>,{' '}
          <code>patch</code>, the kinds of version that trigger a delivery (default: all three).{' '}
          <code>enabled</code> defaults to <code>true</code>. The <code>201</code> response is the
          only time the signing <code>secret</code> is shown; store it.
        </p>
        <CodeBlock>{webhookCreateReq}</CodeBlock>
        <CodeBlock>{webhookCreateRes}</CodeBlock>
      </Endpoint>

      <Endpoint route="PATCH …/:owner/:slug/webhooks/:id" scope="Auth: org owner or admin">
        <p>
          Change any of <code>url</code>, <code>bumpFilter</code> and <code>enabled</code>, checked
          as on create. Returns the updated webhook (without the secret).
        </p>
      </Endpoint>

      <Endpoint route="DELETE …/:owner/:slug/webhooks/:id" scope="Auth: org owner or admin">
        <p>
          Returns <code>{'{"ok": true}'}</code>.
        </p>
      </Endpoint>

      <Endpoint route="POST …/:owner/:slug/webhooks/:id/test" scope="Auth: org owner or admin">
        <p>
          Queue a signed test delivery, returning <code>{'{"ok": true, "deliveryId"}'}</code>. Its
          event is <code>ping</code>, its <code>version</code> is <code>null</code> and it carries{' '}
          <code>{'"test": true'}</code>. It is logged with the other deliveries.
        </p>
      </Endpoint>

      <Endpoint
        route="GET …/:owner/:slug/webhooks/:id/deliveries?limit="
        scope="Auth: org owner or admin"
      >
        <p>
          Recent deliveries, newest first (<code>limit</code> default 50, max 200).{' '}
          <code>status</code> is <code>pending</code>, <code>success</code> or <code>failed</code>.
          Deliveries are kept for 30 days.
        </p>
        <CodeBlock>{deliveriesRes}</CodeBlock>
      </Endpoint>

      <Endpoint
        route="POST …/:owner/:slug/webhooks/:id/deliveries/:deliveryId/retry"
        scope="Auth: org owner or admin"
      >
        <p>
          Send a delivery again, with its attempts reset. Returns{' '}
          <code>{'{"ok": true, "status": "pending"}'}</code>.
        </p>
      </Endpoint>

      <h2 id="webhook-deliveries">Webhook deliveries</h2>
      <p>
        Each delivery is a JSON <code>POST</code> to the webhook&rsquo;s URL. Any <code>2xx</code>{' '}
        response within 10 seconds is a success; redirects are not followed. A failed delivery is
        retried up to 5 attempts in all, waiting 1 minute and doubling each time (at most 6 hours
        between attempts). Deliveries to a disabled webhook fail without being sent.
      </p>
      <CodeBlock>{deliveryBody}</CodeBlock>
      <p>
        <code>X-Underlay-Delivery</code> is the same for every attempt of one delivery, so you can
        use it to ignore repeats. <code>X-Underlay-Signature</code> is <code>sha256=</code> followed
        by the hex HMAC-SHA256 of the raw request body, keyed with the webhook&rsquo;s secret. Check
        it against the body bytes as received, before parsing:
      </p>
      <CodeBlock>{verifyExample}</CodeBlock>

      <hr className="border-rule my-6" />

      <h2 id="ark-identifiers">ARK identifiers</h2>
      <p>
        A collection can have an{' '}
        <a href="https://arks.org" className="text-link underline">
          ARK
        </a>
        , a persistent identifier that redirects to the collection, to one of its versions, or to a
        URL a record names. Resolution sees what the caller can read, as everywhere else.
      </p>
      <CodeBlock>{arkShape}</CodeBlock>

      <Endpoint route="GET /ark:<NAAN>/<name>" scope="No auth required">
        <p>
          <code>302</code> to the target: the collection or version page, or the collection&rsquo;s
          custom URL when it has one. A record ARK redirects to the URL in the record field set for
          its type (below), and is a <code>404</code> when none is set, the record isn&rsquo;t
          readable, or the field isn&rsquo;t an http(s) URL. Append <code>?info</code> or{' '}
          <code>??</code> for an Electronic Resource Citation (ERC) as plain text, or{' '}
          <code>?json</code> for the metadata as JSON. <code>/ark:&lt;NAAN&gt;/</code> alone returns
          the NAAN&rsquo;s policy statement.
        </p>
      </Endpoint>

      <Endpoint route="GET /api/ark/resolve?path=" scope="No auth required">
        <p>
          Resolve an ARK without following it. <code>path</code> is anything containing{' '}
          <code>ark:&lt;NAAN&gt;/…</code> (<code>400</code> otherwise). Returns{' '}
          <code>{'{"type": "redirect", "url", "metadata"}'}</code>, or <code>404</code> with{' '}
          <code>{'{"type": "not_found"}'}</code>. A relative <code>url</code> is a page on this
          site.
        </p>
        <CodeBlock>{resolveRes}</CodeBlock>
      </Endpoint>

      <Endpoint
        route="GET | PATCH …/:owner/:slug/ark"
        scope="Auth: org member (PATCH: org owner or admin, signed in or with an admin key)"
      >
        <p>
          GET returns <code>{'{"enabled", "customUrl", "arkUrl", "shoulder", "arkId"}'}</code>.
          PATCH takes <code>{'{"enabled"?, "customUrl"?}'}</code>: <code>customUrl</code> is an
          http(s) URL to redirect the collection and version ARKs to, or <code>null</code> to use
          the Underlay pages. A collection that has no ARK yet gets one on its first PATCH. Returns{' '}
          <code>{'{"ok": true}'}</code>.
        </p>
      </Endpoint>

      <Endpoint
        route="GET | PUT | PATCH | DELETE …/:owner/:slug/ark/record-types"
        scope="Auth: org member (changes: org owner or admin, signed in or with an admin key)"
      >
        <p>
          Which record field a type&rsquo;s record ARKs redirect to. GET returns{' '}
          <code>{'[{"recordType", "redirectUrlField"}]'}</code>. PUT or PATCH{' '}
          <code>{'{"recordType", "redirectUrlField"}'}</code> sets one; PATCH with{' '}
          <code>{'"redirectUrlField": null'}</code>, or{' '}
          <code>DELETE …/record-types/:recordType</code>, removes it. Changes return{' '}
          <code>{'{"ok": true}'}</code>.
        </p>
      </Endpoint>

      <Endpoint
        route="PATCH /api/accounts/:slug/ark"
        scope="Auth: org owner or admin, signed in or with an admin key"
      >
        <p>
          Set the NAAN the organization&rsquo;s ARKs are minted under:{' '}
          <code>{'{"naan": "…"}'}</code> (digits, at most 16), or <code>null</code> for the default.
          A NAAN another organization already uses is a <code>409</code>. Read and write keys, and
          keys confined to specific collections, get <code>403</code>.
        </p>
      </Endpoint>

      <hr className="border-rule my-6" />

      <h2 id="storage-locations-and-mirrors">Storage locations and mirrors</h2>
      <p>
        Mirroring collections to an organization&rsquo;s own S3-compatible bucket is not available
        yet: adding a mirror to a collection (<code>POST …/:owner/:slug/placements</code>) answers{' '}
        <code>501</code> with <code>{'"code": "not_on_v3"'}</code>.
      </p>

      <hr className="border-rule my-6" />

      <h2 id="health">Health</h2>
      <Endpoint route="GET /api/health" scope="No auth required">
        <p>
          Whether the service is up. <code>deployment</code> names the deployment answering:{' '}
          <code>prod</code> or <code>staging</code>.
        </p>
        <CodeBlock>{healthRes}</CodeBlock>
      </Endpoint>

      <h2 id="abuse-reports">Abuse reports</h2>
      <Endpoint route="POST /api/abuse-reports" scope="No auth required">
        <p>
          Report content that shouldn&rsquo;t be served. Body:{' '}
          <code>{'{"hash"?, "url"?, "reason", "contact"?}'}</code>. Name the content with a file or
          record <code>hash</code> (64 hex characters, <code>sha256:</code> prefix optional), a{' '}
          <code>url</code>, or both. <code>reason</code> is required (up to 4,000 characters);{' '}
          <code>contact</code> is how to reach you (up to 320). Returns <code>201</code>{' '}
          <code>{'{"ok": true, "id"}'}</code>.
        </p>
        <CodeBlock>{abuseReq}</CodeBlock>
      </Endpoint>
    </DocsLayout>
  )
}
