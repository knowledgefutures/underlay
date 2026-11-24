import { Link } from 'react-router'

import DocsLayout from '~/components/DocsLayout'

const assetRefInline = '{"$asset": "ul:asset:<hex>"}'

const headExample = `curl -I https://www.underlay.org/api/collections/kf/archive/assets/ul:asset:a1b2c3...
# HTTP/2 200
# Content-Length: 1048576
# Content-Type: application/pdf`

const getExample = `# -L follows the 302 redirect to the short-lived presigned URL;
# -J saves it under the name ?fileName= gives
curl -L -J -O \\
  "https://www.underlay.org/api/collections/kf/archive/assets/ul:asset:a1b2c3...?fileName=paper.pdf"`

const presignReq = `{ "hashes": ["ul:asset:a1b2c3...", "ul:asset:f6e5d4..."] }`

const presignRes = `{
  "ul:asset:a1b2c3...": "https://storage.example/...",
  "ul:asset:f6e5d4...": null
}`

const putExample = `# Compute hash
HASH=$(shasum -a 256 paper.pdf | cut -d' ' -f1)

# Upload
curl -X PUT \\
  "https://www.underlay.org/api/collections/kf/archive/assets/$HASH" \\
  -H "Authorization: Bearer $KEY" \\
  -H "Content-Type: application/pdf" \\
  --data-binary @paper.pdf`

const putRes = `{
  "hash": "a1b2c3d4e5f6...",
  "status": "stored",
  "size": 1048576
}`

const uploadReq = `{
  "hash": "a1b2c3d4e5f6...",
  "size": 21474836480,
  "mediaType": "video/mp4"
}`

const singleTicket = `{
  "id": "uuid",
  "url": "https://storage.example/...",
  "expiresIn": 3600
}`

const multipartTicket = `{
  "id": "uuid",
  "partBytes": 104857600,
  "partCount": 205,
  "parts": [
    { "partNumber": 1, "url": "https://storage.example/..." },
    { "partNumber": 2, "url": "https://storage.example/..." }
  ],
  "expiresIn": 3600
}`

const partsRes = `{
  "parts": [
    { "partNumber": 101, "url": "https://storage.example/..." }
  ]
}`

const completeReq = `{
  "parts": [
    { "partNumber": 1, "etag": "\\"9b2cf535f27731c974343645a3985328\\"" },
    { "partNumber": 2, "etag": "\\"6f1ed002ab5595859014ebf0951522d9\\"" }
  ]
}`

const completeRes = `{ "id": "uuid", "status": "verifying" }`

const uploadStatusRes = `{
  "id": "uuid",
  "hash": "a1b2c3d4e5f6...",
  "size": 21474836480,
  "status": "verified",
  "error": null
}`

const assetRefExample = `{
  "id": "pub-001",
  "type": "Publication",
  "data": {
    "title": "An Example Paper",
    "pdf": {"$asset": "ul:asset:a1b2c3d4e5f6...", "mediaType": "application/pdf",
            "fileName": "paper.pdf"},
    "thumbnail": {"$asset": "ul:asset:f6e5d4c3b2a1...", "mediaType": "image/webp"}
  }
}`

const missingAssetsRes = `{
  "error": "Missing files",
  "assetsNeeded": ["a1b2c3d4e5f6..."],
  "statusCode": 422
}`

export default function DocsApiAssets() {
  return (
    <DocsLayout title="Assets API">
      <p>
        Assets are the bytes a collection holds beside its records: PDFs, images, a dataset&rsquo;s
        attachments. Each is named by the SHA-256 of its bytes, <code>ul:asset:&lt;hex&gt;</code>,
        so identical bytes are stored only once. Upload assets before committing a version whose
        records attach them.
      </p>

      <h3>Workflow</h3>
      <ol>
        <li>Compute the SHA-256 hash of your asset locally</li>
        <li>
          Open a push session that declares the asset in <code>assets.add</code>; its{' '}
          <code>needed_assets</code> lists the declared assets this collection doesn&rsquo;t hold
          yet (see{' '}
          <a href="/docs/api/versions" className="text-link hover:underline">
            Versions
          </a>
          )
        </li>
        <li>
          Upload each needed asset with <code>PUT</code> (up to 32 MiB) or a direct upload (larger)
        </li>
        <li>
          Attach it in records as <code>{assetRefInline}</code>
        </li>
        <li>
          Commit the version. The server checks that this collection holds every attached asset
        </li>
      </ol>
      <p>
        Every collection uploads the bytes of its assets itself, even when the server already has
        the same bytes for another collection. This is proof of possession: a hash alone never lets
        a collection use, or learn about, another collection&rsquo;s asset.
      </p>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="head-api-collections-owner-slug-assets-hash">
          HEAD /api/collections/:owner/:slug/assets/:hash
        </h2>
        <p className="scope">Access follows the collection&rsquo;s visibility</p>
        <p>
          Check whether you can read an asset through this collection. Returns headers only, no
          body. Anyone who can read the collection can read an asset that any of its versions names.
          Members can also read assets uploaded to this collection and verified, before any version
          names them. To learn what to upload, use <code>needed_assets</code> from opening a push
          session.
        </p>
        <h3>Parameters</h3>
        <table>
          <tbody>
            <tr>
              <td>
                <code>:hash</code>
              </td>
              <td>
                SHA-256 hash: bare hex, or prefixed with <code>ul:asset:</code>
              </td>
            </tr>
          </tbody>
        </table>
        <h3>Response</h3>
        <table>
          <tbody>
            <tr>
              <td>
                <code>200</code>
              </td>
              <td>
                The asset is readable. <code>Content-Length</code> and <code>Content-Type</code>{' '}
                headers set.
              </td>
            </tr>
            <tr>
              <td>
                <code>404</code>
              </td>
              <td>
                Not found, not readable by you, or a private collection you aren&rsquo;t a member
                of. An asset you can&rsquo;t read is <code>404</code> even when it has been
                withheld.
              </td>
            </tr>
            <tr>
              <td>
                <code>451</code>
              </td>
              <td>The asset is readable by you but has been withheld.</td>
            </tr>
          </tbody>
        </table>
        <h3>Example</h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{headExample}</code>
        </pre>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="get-api-collections-owner-slug-assets-hash">
          GET /api/collections/:owner/:slug/assets/:hash
        </h2>
        <p className="scope">Access follows the collection&rsquo;s visibility</p>
        <p>
          Download an asset. After an access check in the context of this collection, the endpoint{' '}
          <strong>302-redirects to a short-lived, presigned storage URL</strong>; follow the
          redirect (e.g. <code>curl -L</code>) to fetch the bytes. The same assets are readable as
          for <code>HEAD</code>: for anyone who can read the collection, the assets its versions
          name, and for members (a session, a key, or a share/agent token sent as a{' '}
          <code>Bearer</code> header or <code>?token=</code>) also assets uploaded to it and not yet
          in a version. Inaccessible assets return <code>404</code>, withheld or not; a readable
          asset that has been withheld returns <code>451</code>.
        </p>
        <p>
          The presigned URL lasts 300 seconds and downloads the asset as an attachment, with the
          collection&rsquo;s <code>mediaType</code> for it. It&rsquo;s saved under its hash, or
          under <code>?fileName=</code> when you give one, such as an asset reference&rsquo;s{' '}
          <code>fileName</code> (no <code>/</code> or <code>\</code>, at most 255 characters;
          anything else is ignored). The redirect carries{' '}
          <code>Cache-Control: private, max-age=240</code>, so a browser may reuse it until shortly
          before the URL expires. This API path is the durable locator for the asset; the redirect
          target is <strong>ephemeral and must not be persisted or shared</strong>, so always
          re-fetch through the API path. To resolve many assets in one request, see the presign
          endpoint below. Downloading an asset by its hash alone, outside a collection (
          <code>GET /api/collections/assets/:hash</code>), is not available yet.
        </p>
        <h3>Example</h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{getExample}</code>
        </pre>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="post-api-collections-owner-slug-assets-presign">
          POST /api/collections/:owner/:slug/assets/presign
        </h2>
        <p className="scope">Access follows the collection&rsquo;s visibility</p>
        <p>
          Presign up to 500 assets in one request (more is <code>400</code>). The response maps each
          hash, exactly as sent, to a presigned URL (300 seconds), or to <code>null</code> when the
          hash is invalid, the asset is not readable through this collection, or it has been
          withheld. Same access model as the single download; avoids one round-trip per asset.
        </p>
        <h3>Request</h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{presignReq}</code>
        </pre>
        <h3>
          Response <span className="text-ink-muted font-normal">200</span>
        </h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{presignRes}</code>
        </pre>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="put-api-collections-owner-slug-assets-hash">
          PUT /api/collections/:owner/:slug/assets/:hash
        </h2>
        <p className="scope">Auth: write access</p>
        <p>
          Upload an asset of up to 32 MiB. The server verifies that the SHA-256 hash of the uploaded
          bytes matches the hash in the URL, then records that this collection holds the asset. The
          bytes are always required, even when the server already has them.
        </p>
        <h3>Request</h3>
        <p>
          Send the bytes as the raw request body with the appropriate <code>Content-Type</code>{' '}
          header, or as <code>multipart/form-data</code> with the bytes in an <code>asset</code>{' '}
          part. HTML, XHTML, SVG, and XML types are stored as <code>application/octet-stream</code>.
        </p>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{putExample}</code>
        </pre>
        <h3>
          Response <span className="text-ink-muted font-normal">201</span>
        </h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{putRes}</code>
        </pre>
        <h3>Errors</h3>
        <table>
          <tbody>
            <tr>
              <td>
                <code>400</code>
              </td>
              <td>
                Not a SHA-256 hash; a multipart body with no <code>asset</code> part; or a hash
                mismatch, where the uploaded bytes don&rsquo;t match the hash in the URL:{' '}
                <code>{'{"error": "Hash mismatch", "expected": "..."}'}</code>.
              </td>
            </tr>
            <tr>
              <td>
                <code>413</code>
              </td>
              <td>
                Over 32 MiB. Use a direct upload (<code>POST .../assets/uploads</code>).
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="post-api-collections-owner-slug-assets-uploads">
          POST /api/collections/:owner/:slug/assets/uploads
        </h2>
        <p className="scope">Auth: write access</p>
        <p>
          Start a direct upload to storage, for assets over the 32 MiB the PUT above takes. An asset
          is at most 5 TiB (larger: <code>413</code>); a missing hash or size is <code>400</code>.
        </p>
        <h3>Request</h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{uploadReq}</code>
        </pre>
        <h3>
          Response <span className="text-ink-muted font-normal">201</span>
        </h3>
        <p>
          Up to 5 GiB, the ticket has one presigned <code>url</code> to PUT the bytes to, valid for
          an hour:
        </p>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{singleTicket}</code>
        </pre>
        <p>
          Larger assets are multipart. The ticket gives <code>partBytes</code> (every part but the
          last is that long: at least 100 MiB, more when needed to fit), <code>partCount</code> (at
          most 10,000), and presigned <code>parts</code> for the first 100 parts. Each part URL is
          valid for an hour.
        </p>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{multipartTicket}</code>
        </pre>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="get-api-collections-owner-slug-assets-uploads-id-parts">
          GET /api/collections/:owner/:slug/assets/uploads/:id/parts
        </h2>
        <p className="scope">Auth: write access</p>
        <p>
          The next 100 presigned part URLs of a multipart upload, starting from part{' '}
          <code>?from=n</code> (default 1). Only while the upload is pending; otherwise{' '}
          <code>404</code>. Each part&rsquo;s PUT returns an <code>ETag</code>; keep them for
          completing.
        </p>
        <h3>
          Response <span className="text-ink-muted font-normal">200</span>
        </h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{partsRes}</code>
        </pre>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="post-api-collections-owner-slug-assets-uploads-id-complete">
          POST /api/collections/:owner/:slug/assets/uploads/:id/complete
        </h2>
        <p className="scope">Auth: write access</p>
        <p>
          Finish an upload. A multipart upload sends every part&rsquo;s number and ETag; a single
          PUT upload sends no body. A multipart upload without a non-empty <code>parts</code> list
          is <code>400</code>. The server then hashes the bytes in the background; poll{' '}
          <code>GET .../assets/uploads/:id</code> until <code>status</code> is <code>verified</code>{' '}
          (or <code>failed</code>, with an <code>error</code>).
        </p>
        <h3>Request</h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{completeReq}</code>
        </pre>
        <h3>
          Response <span className="text-ink-muted font-normal">202</span>
        </h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{completeRes}</code>
        </pre>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="get-api-collections-owner-slug-assets-uploads-id">
          GET /api/collections/:owner/:slug/assets/uploads/:id
        </h2>
        <p className="scope">Auth: write access</p>
        <p>
          An upload&rsquo;s state: <code>pending</code> (waiting for the bytes),{' '}
          <code>verifying</code>, <code>verified</code> (this collection now holds the asset), or{' '}
          <code>failed</code>, with the reason in <code>error</code>.
        </p>
        <h3>
          Response <span className="text-ink-muted font-normal">200</span>
        </h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{uploadStatusRes}</code>
        </pre>
      </div>

      <hr className="border-rule my-6" />

      <h2 id="asset-references-in-records" className="font-sans !text-base">
        Asset references in records
      </h2>
      <p>
        A record attaches an asset with an asset reference, an object whose <code>$asset</code> is
        the asset&rsquo;s <code>ul:asset:</code> id. Give it a <code>mediaType</code>, what the
        bytes are (<code>application/pdf</code>), and a <code>fileName</code>, what they&rsquo;re
        saved as. Any other member is yours:
      </p>
      <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
        <code>{assetRefExample}</code>
      </pre>
      <p>
        A reference may be at any depth in a record&rsquo;s <code>data</code>. Each attached asset
        must be held by this collection: named by the version the push builds on, or uploaded to it
        (a <code>PUT</code> or a verified direct upload). An asset that only another collection
        holds does not count. If any are missing, the commit returns <code>422</code> listing up to
        100 of them in <code>assetsNeeded</code>, and the session stays open: upload them and commit
        it again.
      </p>
      <p>
        The collection serves an asset as the <code>mediaType</code> its records declare, over the{' '}
        <code>Content-Type</code> it was uploaded with, and changing the declared type changes it at
        the next commit. It is this collection&rsquo;s type only: another collection holding the
        same bytes declares its own. A <code>mediaType</code> or <code>fileName</code> that
        isn&rsquo;t well formed is ignored, not refused.
      </p>
      <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
        <code>{missingAssetsRes}</code>
      </pre>
      <p>
        A <code>$asset</code> that is not a <code>ul:asset:</code> id is refused when you push the
        record (<code>422</code>), with a message such as{' '}
        <code>$asset at /pdf is a sha256: hash: write ul:asset:&lt;hex&gt;</code>. So is an object
        with both <code>$link</code> and <code>$asset</code>, and so is a <code>$file</code>.
        Records written before November 2026 used <code>$file</code>; they were rewritten.
      </p>
      <p>
        <code>{'{"$link": "ul:asset:<hex>"}'}</code> names the same asset but only points at it: it
        attaches nothing, and the asset need not be held here. Use it for an asset in another
        collection (see{' '}
        <Link to="/docs/api/records#links-in-records" className="text-link underline">
          Links in records
        </Link>
        ). Wherever a route takes an asset hash, it takes bare hex or a <code>ul:asset:</code> id.
      </p>
    </DocsLayout>
  )
}
