import DocsLayout from '~/components/DocsLayout'

const fileRefInline = '{"$file": "sha256:<hash>"}'

const headExample = `curl -I https://underlay.org/api/collections/kf/archive/files/sha256:a1b2c3...
# HTTP/2 200
# Content-Length: 1048576
# Content-Type: application/pdf`

const getExample = `curl -o paper.pdf \\
  https://underlay.org/api/collections/kf/archive/files/sha256:a1b2c3...`

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
  "size": 1048576
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

export const handle = { title: 'Files API — Underlay Docs' }

export default function DocsApiFiles() {
  return (
    <DocsLayout title="Files API">
      <p>
        Files are content-addressed by SHA-256 hash. The same bytes always produce the same hash, so
        identical files are stored only once. Upload files before pushing a version that references
        them.
      </p>

      <h3>Workflow</h3>
      <ol>
        <li>Compute the SHA-256 hash of your file locally</li>
        <li>
          Check if it exists with <code>HEAD</code>
        </li>
        <li>
          If not, upload it with <code>PUT</code>
        </li>
        <li>
          Reference it in records as <code>{fileRefInline}</code>
        </li>
        <li>Push your version — the server verifies all referenced files exist</li>
      </ol>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2>HEAD /api/collections/:owner/:slug/files/:hash</h2>
        <p className="scope">No auth required</p>
        <p>Check if a file exists. Returns headers only, no body.</p>
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
                File exists. <code>Content-Length</code> and <code>Content-Type</code> headers set.
              </td>
            </tr>
            <tr>
              <td>
                <code>404</code>
              </td>
              <td>File not found.</td>
            </tr>
          </tbody>
        </table>
        <h3>Example</h3>
        <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
          <code>{headExample}</code>
        </pre>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2>GET /api/collections/:owner/:slug/files/:hash</h2>
        <p className="scope">No auth required</p>
        <p>
          Download a file. Returns the raw binary data with appropriate content type. Response is
          cacheable (immutable content).
        </p>
        <h3>Headers</h3>
        <table>
          <tbody>
            <tr>
              <td>
                <code>Content-Type</code>
              </td>
              <td>MIME type of the file</td>
            </tr>
            <tr>
              <td>
                <code>Cache-Control</code>
              </td>
              <td>
                <code>public, max-age=31536000, immutable</code>
              </td>
            </tr>
            <tr>
              <td>
                <code>ETag</code>
              </td>
              <td>The file hash</td>
            </tr>
          </tbody>
        </table>
        <h3>Example</h3>
        <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
          <code>{getExample}</code>
        </pre>
      </div>

      <hr className="border-rule my-6" />

      <div className="endpoint">
        <h2>PUT /api/collections/:owner/:slug/files/:hash</h2>
        <p className="scope">Auth: write scope</p>
        <p>
          Upload a file. The server verifies the SHA-256 hash of the uploaded bytes matches the hash
          in the URL. If the file already exists, returns <code>200</code> without re-uploading.
        </p>
        <h3>Request</h3>
        <p>
          Send the file as the raw request body with the appropriate <code>Content-Type</code>{' '}
          header.
        </p>
        <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
          <code>{putExample}</code>
        </pre>
        <h3>
          Response <span className="text-ink-muted font-normal">201</span>
        </h3>
        <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
          <code>{putRes}</code>
        </pre>
        <h3>Errors</h3>
        <table>
          <tbody>
            <tr>
              <td>
                <code>200</code>
              </td>
              <td>
                File already exists: <code>{'{"hash": "...", "status": "exists"}'}</code>
              </td>
            </tr>
            <tr>
              <td>
                <code>400</code>
              </td>
              <td>Hash mismatch — the uploaded bytes don't match the hash in the URL.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <hr className="border-rule my-6" />

      <h2 className="font-sans !text-base">File references in records</h2>
      <p>
        To link a file to a record, use the <code>$file</code> convention:
      </p>
      <pre className="bg-ink text-parchment overflow-x-auto p-3 text-xs">
        <code>{fileRefExample}</code>
      </pre>
      <p>
        When pushing a version, the server scans all record data for <code>$file</code> references
        and verifies each referenced file exists. If any are missing, the push returns{' '}
        <code>422</code> with a list of needed hashes.
      </p>
    </DocsLayout>
  )
}
