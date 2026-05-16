import { useCallback, useState } from 'react'

interface Collection {
  id: string
  slug: string
}

interface ApiPlaygroundProps {
  slug: string
  collections: Collection[]
}

interface ResponseState {
  status: number
  statusText: string
  time: number
  body: string
}

interface Endpoint {
  label: string
  method: string
  path: string
  body: string
  description: string
}

function getEndpoints(slug: string, collectionSlug: string): Endpoint[] {
  return [
    {
      label: 'List collections',
      method: 'GET',
      path: `/api/accounts/${slug}/collections`,
      body: '',
      description: 'Returns all collections for this account.',
    },
    {
      label: 'Get account profile',
      method: 'GET',
      path: `/api/accounts/${slug}`,
      body: '',
      description: 'Returns public profile information.',
    },
    ...(collectionSlug
      ? [
          {
            label: 'Get collection',
            method: 'GET',
            path: `/api/collections/${slug}/${collectionSlug}`,
            body: '',
            description: 'Returns collection metadata and latest version info.',
          },
          {
            label: 'List versions',
            method: 'GET',
            path: `/api/collections/${slug}/${collectionSlug}/versions`,
            body: '',
            description: 'Returns all versions for this collection.',
          },
          {
            label: 'Get latest version',
            method: 'GET',
            path: `/api/collections/${slug}/${collectionSlug}/versions/latest`,
            body: '',
            description: 'Returns the latest version with records and files.',
          },
          {
            label: 'List files',
            method: 'GET',
            path: `/api/collections/${slug}/${collectionSlug}/files`,
            body: '',
            description: 'Returns all files in the latest version.',
          },
        ]
      : []),
  ]
}

export function ApiPlayground({ slug, collections }: ApiPlaygroundProps) {
  const [selectedCollection, setSelectedCollection] = useState<string>(collections[0]?.slug ?? '')
  const [selectedEndpoint, setSelectedEndpoint] = useState<number>(0)
  const [response, setResponse] = useState<ResponseState | null>(null)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [token, setToken] = useState('')

  const endpoints = getEndpoints(slug, selectedCollection)
  const current = endpoints[selectedEndpoint] ?? endpoints[0]

  const sendRequest = useCallback(async () => {
    if (!current) return
    setLoading(true)
    setResponse(null)

    const start = performance.now()
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (token.trim()) {
        headers['Authorization'] = `Bearer ${token.trim()}`
      }
      const opts: RequestInit = {
        method: current.method,
        headers,
        credentials: token.trim() ? 'omit' : 'include',
      }
      if (current.body && current.method !== 'GET') {
        opts.body = current.body
      }
      const res = await fetch(current.path, opts)
      const elapsed = Math.round(performance.now() - start)
      let body: string
      const contentType = res.headers.get('content-type') ?? ''
      if (contentType.includes('json')) {
        const json = await res.json()
        body = JSON.stringify(json, null, 2)
      } else {
        body = await res.text()
      }
      setResponse({ status: res.status, statusText: res.statusText, time: elapsed, body })
    } catch (err: any) {
      setResponse({ status: 0, statusText: 'Network Error', time: 0, body: err.message })
    } finally {
      setLoading(false)
    }
  }, [current, token])

  const copyAsCurl = useCallback(() => {
    if (!current) return
    const keyValue = token.trim() || '<your-api-key>'
    let cmd = `curl -X ${current.method} '${window.location.origin}${current.path}'`
    cmd += ` \\\n  -H 'Authorization: Bearer ${keyValue}'`
    if (current.body && current.method !== 'GET') {
      cmd += ` \\\n  -H 'Content-Type: application/json'`
      cmd += ` \\\n  -d '${current.body}'`
    }
    navigator.clipboard.writeText(cmd)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [current, token])

  return (
    <div className="border-rule border">
      {/* Controls bar */}
      <div className="border-rule bg-parchment-dark flex flex-col gap-2 border-b px-4 py-2 sm:flex-row sm:items-center">
        {collections.length > 0 && (
          <div className="flex items-center gap-2">
            <label className="text-ink-muted text-xs">Collection:</label>
            <select
              value={selectedCollection}
              onChange={(e) => {
                setSelectedCollection(e.target.value)
                setSelectedEndpoint(0)
                setResponse(null)
              }}
              className="bg-parchment border-rule focus:border-ink border px-2 py-1 text-sm focus:outline-none"
            >
              {collections.map((c) => (
                <option key={c.id} value={c.slug}>
                  {c.slug}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="flex items-center gap-2 sm:ml-auto">
          <label className="text-ink-muted text-xs whitespace-nowrap">Bearer token:</label>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Paste key to test it (optional)"
            className="bg-parchment border-rule focus:border-ink w-52 border px-2 py-1 font-mono text-xs focus:outline-none"
          />
        </div>
      </div>

      <div className="flex flex-col md:flex-row">
        {/* Left column: endpoint list */}
        <div className="border-rule border-b p-3 md:w-56 md:border-r md:border-b-0">
          <p className="text-ink-muted mb-2 text-xs font-semibold">Endpoints</p>
          <div className="space-y-0.5">
            {endpoints.map((ep, i) => (
              <button
                key={ep.label}
                onClick={() => {
                  setSelectedEndpoint(i)
                  setResponse(null)
                }}
                className={`block w-full rounded px-2 py-1.5 text-left text-xs transition-colors ${
                  selectedEndpoint === i
                    ? 'bg-parchment-dark font-medium'
                    : 'hover:bg-parchment-dark'
                }`}
              >
                <span
                  className={`mr-1.5 font-mono text-[10px] ${
                    ep.method === 'GET'
                      ? 'text-green-700'
                      : ep.method === 'POST'
                        ? 'text-blue-700'
                        : ep.method === 'DELETE'
                          ? 'text-red-700'
                          : 'text-ink-muted'
                  }`}
                >
                  {ep.method}
                </span>
                {ep.label}
              </button>
            ))}
          </div>

          {collections.length === 0 && (
            <p className="text-ink-muted mt-3 text-[11px] italic">
              No collections yet. Create one to see collection endpoints.
            </p>
          )}
        </div>

        {/* Right column: request + response */}
        <div className="min-w-0 flex-1">
          {current && (
            <>
              {/* Request display */}
              <div className="border-rule border-b px-3 py-2">
                <div className="mb-1 flex items-center gap-2">
                  <span
                    className={`border px-1.5 py-0.5 font-mono text-xs font-bold ${
                      current.method === 'GET'
                        ? 'border-green-300 text-green-700'
                        : current.method === 'POST'
                          ? 'border-blue-300 text-blue-700'
                          : current.method === 'DELETE'
                            ? 'border-red-300 text-red-700'
                            : 'border-rule'
                    }`}
                  >
                    {current.method}
                  </span>
                  <code className="text-ink-muted font-mono text-xs break-all">{current.path}</code>
                </div>
                <p className="text-ink-muted text-xs">{current.description}</p>
              </div>

              {/* Action bar */}
              <div className="border-rule flex items-center gap-2 border-b px-3 py-2">
                <button
                  onClick={sendRequest}
                  disabled={loading}
                  className="bg-ink text-parchment px-3 py-1 text-xs font-medium hover:opacity-90 disabled:opacity-50"
                >
                  {loading ? 'Sending…' : 'Send'}
                </button>
                <button
                  onClick={copyAsCurl}
                  className="border-rule text-ink-muted hover:text-ink border px-2 py-1 text-xs"
                  title="Copy as cURL (with Bearer token placeholder)"
                >
                  {copied ? 'Copied!' : 'Copy cURL'}
                </button>
                <span className="text-ink-muted ml-auto hidden text-[10px] sm:inline">
                  {token.trim() ? 'Using API key' : 'Using your session'}
                </span>
              </div>
            </>
          )}

          {/* Response */}
          {response && (
            <div>
              <div
                className={`border-rule flex items-center gap-3 border-b px-3 py-1.5 text-xs ${
                  response.status >= 200 && response.status < 300
                    ? 'bg-green-50 text-green-800'
                    : response.status >= 400
                      ? 'bg-red-50 text-red-800'
                      : 'bg-parchment-dark'
                }`}
              >
                <span className="font-bold">
                  {response.status} {response.statusText}
                </span>
                <span className="text-ink-muted">{response.time}ms</span>
              </div>
              <pre className="bg-parchment max-h-80 overflow-auto px-3 py-2 font-mono text-xs break-words whitespace-pre-wrap">
                {response.body}
              </pre>
            </div>
          )}

          {!response && !loading && (
            <div className="text-ink-muted px-3 py-8 text-center text-xs">
              Select an endpoint and hit Send to see the response.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
