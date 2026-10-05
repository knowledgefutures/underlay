import DocsLayout from '~/components/DocsLayout'

const fileRefInline = '{"$file": "sha256:<hash>"}'

const headExample = `curl -I https://underlay.org/api/collections/kf/archive/files/sha256:a1b2c3...
# HTTP/2 200
# Content-Length: 1048576
# Content-Type: application/pdf`

const getExample = `# -L follows the 302 redirect to the short-lived presigned URL
curl -L -o paper.pdf \\
  https://underlay.org/api/collections/kf/archive/files/sha256:a1b2c3...`

const presignReq = `{ "hashes": ["sha256:a1b2c3...", "sha256:f6e5d4..."] }`

const presignRes = `{
  "sha256:a1b2c3...": "https://storage.example/...",
  "sha256:f6e5d4...": null
}`

const putExample = `# Compute hash
HASH=$(shasum -a 256 paper.pdf | cut -d' ' -f1)

# Upload
curl -X PUT \\
  "https://underlay.org/api/collections/kf/archive/files/sha256:$HASH" \\
  -H "Authorization: Bearer $KEY" \\
  -H "Content-Type: application/pdf" \\
  --data-binary @paper.pdf`

const putRes = `{
  "hash": "a1b2c3d4e5f6...",
  "status": "stored",
  "size": 1048576
}`

const uploadReq = `{
  "hash": "sha256:a1b2c3d4e5f6...",
  "size": 21474836480,
  "mimeType": "video/mp4"
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

const fileRefExample = `{
  "id": "pub-001",
  "type": "Publication",
  "data": {
    "title": "An Example Paper",
    "pdf": {"$file": "sha256:a1b2c3d4e5f6..."},
    "thumbnail": {"$file": "sha256:f6e5d4c3b2a1..."}
  }
}`

const missingFilesRes = `{
  "error": "Missing files",
  "filesNeeded": ["sha256:a1b2c3d4e5f6..."],
  "statusCode": 422
}`

export default function DocsApiFiles() {
  return (
    <DocsLayout title="Files API">
      <p>
        Files are content-addressed by SHA-256 hash. The same bytes always produce the same hash, so
        identical files are stored only once. Upload files before committing a version that
        references them.
      </p>

      <h3>Workflow</h3>
      <ol>
        <li>Compute the SHA-256 hash of your file locally</li>
        <li>
          Open a push session that declares the file in <code>files.add</code>; its{' '}
          <code>needed_files</code> lists the declared files this collection doesn&rsquo;t hold yet
          (see{' '}
          <a href="/docs/api/versions" className="text-link hover:underline">
            Versions
          </a>
          )
        </li>
        <li>
          Upload each needed file with <code>PUT</code> (up to 32 MiB) or a direct upload (larger)
        </li>
        <li>
          Reference it in records as <code>{fileRefInline}</code>
        </li>
        <li>
          Commit the version. The server checks that this collection holds every referenced file
        </li>
      </ol>
      <p>
        Every collection uploads the bytes of its files itself, even when the server already has the
        same file for another collection. This is proof of possession: a hash alone never lets a
        collection use, or learn about, another collection&rsquo;s file.
      </p>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="head-api-collections-owner-slug-files-hash">
          HEAD /api/collections/:owner/:slug/files/:hash
        </h2>
        <p className="scope">Access follows the collection&rsquo;s visibility</p>
        <p>
          Check whether you can read a file through this collection. Returns headers only, no body.
          A file is readable here when it is in a published version of this collection that you may
          read: any public version&rsquo;s files for everyone, and for members also the private
          files of the latest version. A file that has been uploaded but not yet committed in a
          version returns <code>404</code>; to learn what to upload, use <code>needed_files</code>{' '}
          from opening a push session.
        </p>
        <h3>Parameters</h3>
        <table>
          <tbody>
            <tr>
              <td>
                <code>:hash</code>
              </td>
              <td>
                SHA-256 hash, optionally prefixed with <code>sha256:</code>
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
                The file is readable. <code>Content-Length</code> and <code>Content-Type</code>{' '}
                headers set.
              </td>
            </tr>
            <tr>
              <td>
                <code>404</code>
              </td>
              <td>
                Not found, not readable by you, not yet in a published version, or the collection is
                private.
              </td>
            </tr>
            <tr>
              <td>
                <code>451</code>
              </td>
              <td>The file has been withheld.</td>
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
        <h2 id="get-api-collections-owner-slug-files-hash">
          GET /api/collections/:owner/:slug/files/:hash
        </h2>
        <p className="scope">Access follows the collection&rsquo;s visibility</p>
        <p>
          Download a file. After an access check in the context of this collection, the endpoint{' '}
          <strong>302-redirects to a short-lived, presigned storage URL</strong>; follow the
          redirect (e.g. <code>curl -L</code>) to fetch the bytes. The same files are readable as
          for <code>HEAD</code>: public-version files anonymously, and for members (a session, a
          key, or a share/agent token sent as a <code>Bearer</code> header or <code>?token=</code>)
          also the private files of the latest version. Inaccessible files return <code>404</code>;
          withheld files return <code>451</code>.
        </p>
        <p>
          The presigned URL lasts 300 seconds and downloads the file as an attachment. The redirect
          carries <code>Cache-Control: private, max-age=240</code>, so a browser may reuse it until
          shortly before the URL expires. This API path is the durable locator for the file; the
          redirect target is <strong>ephemeral and must not be persisted or shared</strong>, so
          always re-fetch through the API path. To resolve many files in one request, see the
          presign endpoint below.
        </p>
        <h3>Example</h3>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{getExample}</code>
        </pre>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="get-api-collections-files-hash">GET /api/collections/files/:hash</h2>
        <p className="scope">No auth for files in public collections</p>
        <p>
          Download a file by hash alone. Redirects (<code>302</code>) to a presigned URL, like the
          download above, when the file is readable through any collection you can read: a public
          collection&rsquo;s public files, or any file of a collection in an organization you belong
          to. Otherwise <code>404</code>; withheld files return <code>451</code>.
        </p>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="post-api-collections-owner-slug-files-presign">
          POST /api/collections/:owner/:slug/files/presign
        </h2>
        <p className="scope">Access follows the collection&rsquo;s visibility</p>
        <p>
          Presign up to 500 files in one request (more is <code>400</code>). The response maps each
          hash, exactly as sent, to a presigned URL (300 seconds), or to <code>null</code> when the
          hash is invalid, the file is not readable through this collection, or it has been
          withheld. Same access model as the single download; avoids one round-trip per file.
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
        <h2 id="put-api-collections-owner-slug-files-hash">
          PUT /api/collections/:owner/:slug/files/:hash
        </h2>
        <p className="scope">Auth: write access</p>
        <p>
          Upload a file of up to 32 MiB. The server verifies that the SHA-256 hash of the uploaded
          bytes matches the hash in the URL, then records that this collection holds the file. The
          bytes are always required, even when the server already has the file.
        </p>
        <h3>Request</h3>
        <p>
          Send the file as the raw request body with the appropriate <code>Content-Type</code>{' '}
          header, or as <code>multipart/form-data</code> with the file in a <code>file</code> field.
          HTML, XHTML, SVG and XML types are stored as <code>application/octet-stream</code>.
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
                Not a SHA-256 hash; a multipart body with no <code>file</code> field; or a hash
                mismatch, where the uploaded bytes don&rsquo;t match the hash in the URL:{' '}
                <code>{'{"error": "Hash mismatch", "expected": "..."}'}</code>.
              </td>
            </tr>
            <tr>
              <td>
                <code>413</code>
              </td>
              <td>
                Over 32 MiB. Use a direct upload (<code>POST .../files/uploads</code>).
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="post-api-collections-owner-slug-files-uploads">
          POST /api/collections/:owner/:slug/files/uploads
        </h2>
        <p className="scope">Auth: write access</p>
        <p>
          Start a direct upload to storage, for files over the 32 MiB the PUT above takes. A file is
          at most 5 TiB (larger: <code>413</code>); a missing hash or size is <code>400</code>.
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
          Larger files are multipart. The ticket gives <code>partBytes</code> (every part but the
          last is that long: at least 100 MiB, more when needed to fit), <code>partCount</code> (at
          most 10,000) and presigned <code>parts</code> for the first 100 parts. Each part URL is
          valid for an hour.
        </p>
        <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
          <code>{multipartTicket}</code>
        </pre>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2 id="get-api-collections-owner-slug-files-uploads-id-parts">
          GET /api/collections/:owner/:slug/files/uploads/:id/parts
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
        <h2 id="post-api-collections-owner-slug-files-uploads-id-complete">
          POST /api/collections/:owner/:slug/files/uploads/:id/complete
        </h2>
        <p className="scope">Auth: write access</p>
        <p>
          Finish an upload. A multipart upload sends every part&rsquo;s number and ETag; a single
          PUT upload sends no body. The server then hashes the bytes in the background; poll{' '}
          <code>GET .../files/uploads/:id</code> until <code>status</code> is <code>verified</code>{' '}
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
        <h2 id="get-api-collections-owner-slug-files-uploads-id">
          GET /api/collections/:owner/:slug/files/uploads/:id
        </h2>
        <p className="scope">Auth: write access</p>
        <p>
          An upload&rsquo;s state: <code>pending</code> (waiting for the bytes),{' '}
          <code>verifying</code>, <code>verified</code> (this collection now holds the file) or{' '}
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

      <h2 id="file-references-in-records" className="font-sans !text-base">
        File references in records
      </h2>
      <p>
        To link a file to a record, use the <code>$file</code> convention:
      </p>
      <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
        <code>{fileRefExample}</code>
      </pre>
      <p>
        A reference is any object, at any depth in a record&rsquo;s <code>data</code>, whose{' '}
        <code>$file</code> is the string <code>sha256:</code> followed by 64 lowercase hex digits.
        Each referenced file must be held by this collection: uploaded to it (a <code>PUT</code> or
        a verified direct upload), or already in the version the push builds on (or, for public
        files, in any earlier version). A file that only another collection holds does not count. If
        any are missing, the commit returns <code>422</code> listing up to 100 of them:
      </p>
      <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
        <code>{missingFilesRes}</code>
      </pre>
    </DocsLayout>
  )
}
