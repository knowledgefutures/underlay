import { useState, useCallback } from "react";

interface Collection {
  id: string;
  slug: string;
}

interface ApiPlaygroundProps {
  slug: string;
  collections: Collection[];
}

interface ResponseState {
  status: number;
  statusText: string;
  time: number;
  body: string;
}

interface Endpoint {
  label: string;
  method: string;
  path: string;
  body: string;
  description: string;
}

function getEndpoints(slug: string, collectionSlug: string): Endpoint[] {
  return [
    {
      label: "List collections",
      method: "GET",
      path: `/api/accounts/${slug}/collections`,
      body: "",
      description: "Returns all collections for this account.",
    },
    {
      label: "Get account profile",
      method: "GET",
      path: `/api/accounts/${slug}`,
      body: "",
      description: "Returns public profile information.",
    },
    ...(collectionSlug
      ? [
          {
            label: "Get collection",
            method: "GET",
            path: `/api/collections/${slug}/${collectionSlug}`,
            body: "",
            description: "Returns collection metadata and latest version info.",
          },
          {
            label: "List versions",
            method: "GET",
            path: `/api/collections/${slug}/${collectionSlug}/versions`,
            body: "",
            description: "Returns all versions for this collection.",
          },
          {
            label: "Get latest version",
            method: "GET",
            path: `/api/collections/${slug}/${collectionSlug}/versions/latest`,
            body: "",
            description: "Returns the latest version with records and files.",
          },
          {
            label: "List files",
            method: "GET",
            path: `/api/collections/${slug}/${collectionSlug}/files`,
            body: "",
            description: "Returns all files in the latest version.",
          },
        ]
      : []),
  ];
}



export function ApiPlayground({ slug, collections }: ApiPlaygroundProps) {
  const [selectedCollection, setSelectedCollection] = useState<string>(collections[0]?.slug ?? "");
  const [selectedEndpoint, setSelectedEndpoint] = useState<number>(0);
  const [response, setResponse] = useState<ResponseState | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [token, setToken] = useState("");

  const endpoints = getEndpoints(slug, selectedCollection);
  const current = endpoints[selectedEndpoint] ?? endpoints[0];

  const sendRequest = useCallback(async () => {
    if (!current) return;
    setLoading(true);
    setResponse(null);

    const start = performance.now();
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token.trim()) {
        headers["Authorization"] = `Bearer ${token.trim()}`;
      }
      const opts: RequestInit = {
        method: current.method,
        headers,
        credentials: token.trim() ? "omit" : "include",
      };
      if (current.body && current.method !== "GET") {
        opts.body = current.body;
      }
      const res = await fetch(current.path, opts);
      const elapsed = Math.round(performance.now() - start);
      let body: string;
      const contentType = res.headers.get("content-type") ?? "";
      if (contentType.includes("json")) {
        const json = await res.json();
        body = JSON.stringify(json, null, 2);
      } else {
        body = await res.text();
      }
      setResponse({ status: res.status, statusText: res.statusText, time: elapsed, body });
    } catch (err: any) {
      setResponse({ status: 0, statusText: "Network Error", time: 0, body: err.message });
    } finally {
      setLoading(false);
    }
  }, [current, token]);

  const copyAsCurl = useCallback(() => {
    if (!current) return;
    const keyValue = token.trim() || "<your-api-key>";
    let cmd = `curl -X ${current.method} '${window.location.origin}${current.path}'`;
    cmd += ` \\\n  -H 'Authorization: Bearer ${keyValue}'`;
    if (current.body && current.method !== "GET") {
      cmd += ` \\\n  -H 'Content-Type: application/json'`;
      cmd += ` \\\n  -d '${current.body}'`;
    }
    navigator.clipboard.writeText(cmd);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [current, token]);

  return (
    <div className="border border-rule">
      {/* Controls bar */}
      <div className="border-b border-rule px-4 py-2 flex flex-col sm:flex-row sm:items-center gap-2 bg-parchment-dark">
        {collections.length > 0 && (
          <div className="flex items-center gap-2">
            <label className="text-xs text-ink-muted">Collection:</label>
            <select
              value={selectedCollection}
              onChange={(e) => {
                setSelectedCollection(e.target.value);
                setSelectedEndpoint(0);
                setResponse(null);
              }}
              className="text-sm bg-parchment border border-rule px-2 py-1 focus:outline-none focus:border-ink"
            >
              {collections.map((c) => (
                <option key={c.id} value={c.slug}>{c.slug}</option>
              ))}
            </select>
          </div>
        )}
        <div className="flex items-center gap-2 sm:ml-auto">
          <label className="text-xs text-ink-muted whitespace-nowrap">Bearer token:</label>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Paste key to test it (optional)"
            className="text-xs bg-parchment border border-rule px-2 py-1 w-52 font-mono focus:outline-none focus:border-ink"
          />
        </div>
      </div>

      <div className="flex flex-col md:flex-row">
        {/* Left column: endpoint list */}
        <div className="md:w-56 border-b md:border-b-0 md:border-r border-rule p-3">
          <p className="text-xs font-semibold text-ink-muted mb-2">Endpoints</p>
          <div className="space-y-0.5">
            {endpoints.map((ep, i) => (
              <button
                key={ep.label}
                onClick={() => {
                  setSelectedEndpoint(i);
                  setResponse(null);
                }}
                className={`block w-full text-left text-xs px-2 py-1.5 rounded transition-colors ${
                  selectedEndpoint === i ? "bg-parchment-dark font-medium" : "hover:bg-parchment-dark"
                }`}
              >
                <span className={`font-mono text-[10px] mr-1.5 ${
                  ep.method === "GET" ? "text-green-700" :
                  ep.method === "POST" ? "text-blue-700" :
                  ep.method === "DELETE" ? "text-red-700" : "text-ink-muted"
                }`}>
                  {ep.method}
                </span>
                {ep.label}
              </button>
            ))}
          </div>

          {collections.length === 0 && (
            <p className="text-[11px] text-ink-muted mt-3 italic">
              No collections yet. Create one to see collection endpoints.
            </p>
          )}
        </div>

        {/* Right column: request + response */}
        <div className="flex-1 min-w-0">
          {current && (
            <>
              {/* Request display */}
              <div className="border-b border-rule px-3 py-2">
                <div className="flex items-center gap-2 mb-1">
                  <span className={`text-xs font-mono font-bold px-1.5 py-0.5 border ${
                    current.method === "GET" ? "border-green-300 text-green-700" :
                    current.method === "POST" ? "border-blue-300 text-blue-700" :
                    current.method === "DELETE" ? "border-red-300 text-red-700" : "border-rule"
                  }`}>
                    {current.method}
                  </span>
                  <code className="text-xs font-mono text-ink-muted break-all">{current.path}</code>
                </div>
                <p className="text-xs text-ink-muted">{current.description}</p>
              </div>

              {/* Action bar */}
              <div className="border-b border-rule px-3 py-2 flex items-center gap-2">
                <button
                  onClick={sendRequest}
                  disabled={loading}
                  className="bg-ink text-parchment px-3 py-1 text-xs font-medium hover:opacity-90 disabled:opacity-50"
                >
                  {loading ? "Sending…" : "Send"}
                </button>
                <button
                  onClick={copyAsCurl}
                  className="border border-rule px-2 py-1 text-xs text-ink-muted hover:text-ink"
                  title="Copy as cURL (with Bearer token placeholder)"
                >
                  {copied ? "Copied!" : "Copy cURL"}
                </button>
                <span className="text-[10px] text-ink-muted ml-auto hidden sm:inline">
                  {token.trim() ? "Using API key" : "Using your session"}
                </span>
              </div>
            </>
          )}

          {/* Response */}
          {response && (
            <div>
              <div className={`px-3 py-1.5 text-xs border-b border-rule flex items-center gap-3 ${
                response.status >= 200 && response.status < 300 ? "bg-green-50 text-green-800" :
                response.status >= 400 ? "bg-red-50 text-red-800" : "bg-parchment-dark"
              }`}>
                <span className="font-bold">{response.status} {response.statusText}</span>
                <span className="text-ink-muted">{response.time}ms</span>
              </div>
              <pre className="px-3 py-2 text-xs font-mono overflow-auto max-h-80 whitespace-pre-wrap break-words bg-parchment">
                {response.body}
              </pre>
            </div>
          )}

          {!response && !loading && (
            <div className="px-3 py-8 text-center text-xs text-ink-muted">
              Select an endpoint and hit Send to see the response.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
