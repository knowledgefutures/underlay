import { useState, useCallback } from "react";

interface ApiKey {
  id: string;
  label: string;
  scope: "read" | "write" | "admin";
  keyPrefix: string | null;
}

interface Collection {
  id: string;
  slug: string;
}

interface ApiPlaygroundProps {
  slug: string;
  keys: ApiKey[];
  collections: Collection[];
}

interface RequestState {
  method: string;
  path: string;
  body: string;
}

interface ResponseState {
  status: number;
  statusText: string;
  time: number;
  body: string;
}

type Example = {
  label: string;
  method: string;
  path: string;
  body: string;
  scope: "read" | "write" | "admin";
};

function getExamples(slug: string, collections: Collection[]): Example[] {
  const firstCollection = collections[0]?.slug ?? "my-collection";
  return [
    {
      label: "List collections",
      method: "GET",
      path: `/api/accounts/${slug}/collections`,
      body: "",
      scope: "read",
    },
    {
      label: "Get account profile",
      method: "GET",
      path: `/api/accounts/${slug}`,
      body: "",
      scope: "read",
    },
    {
      label: "Get collection versions",
      method: "GET",
      path: `/api/collections/${slug}/${firstCollection}/versions`,
      body: "",
      scope: "read",
    },
    {
      label: "Create collection",
      method: "POST",
      path: `/api/accounts/${slug}/collections`,
      body: JSON.stringify(
        { slug: "new-collection", name: "New Collection", description: "A test collection", public: true },
        null,
        2,
      ),
      scope: "write",
    },
    {
      label: "Update collection",
      method: "PATCH",
      path: `/api/collections/${slug}/${firstCollection}`,
      body: JSON.stringify({ description: "Updated description" }, null, 2),
      scope: "write",
    },
    {
      label: "Delete collection",
      method: "DELETE",
      path: `/api/collections/${slug}/${firstCollection}`,
      body: "",
      scope: "admin",
    },
  ];
}

function scopeAllows(keyScope: string, requiredScope: string): boolean {
  const levels = { read: 0, write: 1, admin: 2 };
  return (levels[keyScope as keyof typeof levels] ?? 0) >= (levels[requiredScope as keyof typeof levels] ?? 0);
}

function generateCurl(method: string, path: string, body: string, keyLabel: string): string {
  let cmd = `curl -X ${method} '${window.location.origin}${path}'`;
  cmd += ` \\\n  -H 'Authorization: Bearer <${keyLabel}-key>'`;
  if (body && (method === "POST" || method === "PATCH" || method === "PUT")) {
    cmd += ` \\\n  -H 'Content-Type: application/json'`;
    cmd += ` \\\n  -d '${body}'`;
  }
  return cmd;
}

const HISTORY_KEY = "underlay-api-playground-history";

function loadHistory(): { method: string; path: string; time: string }[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function saveHistory(entry: { method: string; path: string; time: string }) {
  const history = loadHistory();
  history.unshift(entry);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 5)));
}

export function ApiPlayground({ slug, keys, collections }: ApiPlaygroundProps) {
  const [selectedKeyId, setSelectedKeyId] = useState<string>(keys[0]?.id ?? "");
  const [request, setRequest] = useState<RequestState>({ method: "GET", path: `/api/accounts/${slug}/collections`, body: "" });
  const [response, setResponse] = useState<ResponseState | null>(null);
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState(loadHistory);
  const [copied, setCopied] = useState(false);

  const selectedKey = keys.find((k) => k.id === selectedKeyId);
  const examples = getExamples(slug, collections);
  const visibleExamples = selectedKey
    ? examples.filter((e) => scopeAllows(selectedKey.scope, e.scope))
    : examples;

  const sendRequest = useCallback(async () => {
    if (!selectedKeyId) return;
    setLoading(true);
    setResponse(null);

    const start = performance.now();
    try {
      const opts: RequestInit = {
        method: request.method,
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
      };
      if (request.body && request.method !== "GET" && request.method !== "DELETE") {
        opts.body = request.body;
      }
      const res = await fetch(request.path, opts);
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

      const entry = { method: request.method, path: request.path, time: new Date().toISOString() };
      saveHistory(entry);
      setHistory(loadHistory());
    } catch (err: any) {
      setResponse({ status: 0, statusText: "Network Error", time: 0, body: err.message });
    } finally {
      setLoading(false);
    }
  }, [selectedKeyId, request]);

  const copyAsCurl = useCallback(() => {
    if (!selectedKey) return;
    const curl = generateCurl(request.method, request.path, request.body, selectedKey.label);
    navigator.clipboard.writeText(curl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [request, selectedKey]);

  if (keys.length === 0) {
    return (
      <div className="border border-rule border-dashed p-6 text-center">
        <p className="text-sm text-ink-muted">Create an API key above to use the playground.</p>
      </div>
    );
  }

  return (
    <div className="border border-rule">
      {/* Key selector */}
      <div className="border-b border-rule px-4 py-2 flex items-center gap-3 bg-parchment-dark">
        <label className="text-xs text-ink-muted">Key:</label>
        <select
          value={selectedKeyId}
          onChange={(e) => setSelectedKeyId(e.target.value)}
          className="text-sm bg-parchment border border-rule px-2 py-1 focus:outline-none focus:border-ink"
        >
          {keys.map((k) => (
            <option key={k.id} value={k.id}>
              {k.label} ({k.scope}){k.keyPrefix ? ` — ${k.keyPrefix}…` : ""}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col md:flex-row">
        {/* Left column: examples + history */}
        <div className="md:w-56 border-b md:border-b-0 md:border-r border-rule p-3 space-y-3">
          <div>
            <p className="text-xs font-semibold text-ink-muted mb-2">Examples</p>
            <div className="space-y-1">
              {visibleExamples.map((ex) => (
                <button
                  key={ex.label}
                  onClick={() => setRequest({ method: ex.method, path: ex.path, body: ex.body })}
                  className={`block w-full text-left text-xs px-2 py-1.5 rounded hover:bg-parchment-dark transition-colors ${
                    request.path === ex.path && request.method === ex.method ? "bg-parchment-dark font-medium" : ""
                  }`}
                >
                  <span className="font-mono text-[10px] mr-1">{ex.method}</span>
                  {ex.label}
                </button>
              ))}
            </div>
          </div>

          {history.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-ink-muted mb-2">History</p>
              <div className="space-y-1">
                {history.map((h, i) => (
                  <button
                    key={i}
                    onClick={() => setRequest({ method: h.method, path: h.path, body: "" })}
                    className="block w-full text-left text-xs px-2 py-1 text-ink-muted hover:text-ink truncate"
                    title={`${h.method} ${h.path}`}
                  >
                    <span className="font-mono text-[10px] mr-1">{h.method}</span>
                    {h.path.slice(0, 30)}…
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right column: request + response */}
        <div className="flex-1 min-w-0">
          {/* Request bar */}
          <div className="flex items-center gap-2 border-b border-rule px-3 py-2">
            <select
              value={request.method}
              onChange={(e) => setRequest({ ...request, method: e.target.value })}
              className="text-xs font-mono font-bold bg-parchment border border-rule px-2 py-1 focus:outline-none"
            >
              <option>GET</option>
              <option>POST</option>
              <option>PATCH</option>
              <option>PUT</option>
              <option>DELETE</option>
            </select>
            <input
              type="text"
              value={request.path}
              onChange={(e) => setRequest({ ...request, path: e.target.value })}
              className="flex-1 text-xs font-mono bg-parchment border border-rule px-2 py-1 focus:outline-none focus:border-ink"
            />
            <button
              onClick={sendRequest}
              disabled={loading}
              className="bg-ink text-parchment px-3 py-1 text-xs font-medium hover:opacity-90 disabled:opacity-50"
            >
              {loading ? "…" : "Send"}
            </button>
            <button
              onClick={copyAsCurl}
              className="border border-rule px-2 py-1 text-xs text-ink-muted hover:text-ink"
              title="Copy as cURL"
            >
              {copied ? "Copied!" : "cURL"}
            </button>
          </div>

          {/* Body editor */}
          {(request.method === "POST" || request.method === "PATCH" || request.method === "PUT") && (
            <div className="border-b border-rule">
              <textarea
                value={request.body}
                onChange={(e) => setRequest({ ...request, body: e.target.value })}
                placeholder="Request body (JSON)"
                rows={5}
                className="w-full px-3 py-2 text-xs font-mono bg-parchment focus:outline-none resize-none"
              />
            </div>
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
              Select an example or enter a request and hit Send.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
