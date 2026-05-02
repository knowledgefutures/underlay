import { useState, useEffect, useRef } from "react";

interface Props {
  upstream: string;
  nodeName: string;
  syncSchedule: string;
}

interface MirrorStatus {
  upstream: string;
  nodeName: string;
  syncSchedule: string;
  collections: {
    ownerSlug: string;
    slug: string;
    name: string;
    localVersion: string;
    updatedAt: string;
  }[];
  lastSyncAt: string | null;
}

interface TestResult {
  ok: boolean;
  version?: string;
  collectionCount?: number;
  error?: string;
}

interface SyncProgressEvent {
  type: "start" | "collection" | "version" | "file" | "error" | "done";
  message: string;
  progress: {
    collectionsTotal: number;
    collectionsProcessed: number;
    currentCollection?: string;
    versionsPulled: number;
    filesDownloaded: number;
    filesSkipped: number;
    errors: number;
  };
}

interface SyncHistoryEntry {
  id: string;
  trigger: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  collectionsSynced: number;
  collectionsCreated: number;
  collectionsFailed: number;
  versionsPulled: number;
  filesDownloaded: number;
  filesSkipped: number;
  errors: string[];
}

const PAGE_SIZE = 10;

function PaginatedCollections({ collections }: { collections: MirrorStatus["collections"] }) {
  const [page, setPage] = useState(0);
  const totalPages = Math.ceil(collections.length / PAGE_SIZE);
  const visible = collections.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-rule text-left text-ink-muted">
            <th className="pb-2 font-medium">Collection</th>
            <th className="pb-2 font-medium">Version</th>
            <th className="pb-2 font-medium">Last Updated</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((c) => (
            <tr key={`${c.ownerSlug}/${c.slug}`} className="border-b border-rule/50">
              <td className="py-2">
                <a href={`/${c.ownerSlug}/${c.slug}`} className="text-ink hover:underline">
                  {c.ownerSlug}/{c.slug}
                </a>
                <span className="text-ink-muted ml-2">— {c.name}</span>
              </td>
              <td className="py-2 font-mono">{c.localVersion}</td>
              <td className="py-2 text-ink-muted">
                {new Date(c.updatedAt).toLocaleDateString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-3 text-xs text-ink-muted">
          <span>{collections.length} collections</span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="px-2 py-1 border border-rule rounded disabled:opacity-30 hover:bg-parchment-dark"
            >
              ← Prev
            </button>
            <span>
              {page + 1} / {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              className="px-2 py-1 border border-rule rounded disabled:opacity-30 hover:bg-parchment-dark"
            >
              Next →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function MirrorAdmin({ upstream, nodeName, syncSchedule }: Props) {
  const [status, setStatus] = useState<MirrorStatus | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [progressEvents, setProgressEvents] = useState<SyncProgressEvent[]>([]);
  const [latestProgress, setLatestProgress] = useState<SyncProgressEvent | null>(null);
  const [history, setHistory] = useState<SyncHistoryEntry[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchStatus();
    fetchHistory();
  }, []);

  // Auto-scroll log
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [progressEvents]);

  async function fetchStatus() {
    try {
      const res = await fetch("/api/admin/mirror/status");
      if (res.ok) setStatus(await res.json());
    } catch {
      // ignore
    }
  }

  async function fetchHistory() {
    try {
      const res = await fetch("/api/admin/mirror/history");
      if (res.ok) setHistory(await res.json());
    } catch {
      // ignore
    }
  }

  async function handleTest() {
    setLoading("test");
    setTestResult(null);
    try {
      const res = await fetch("/api/admin/mirror/test", { method: "POST" });
      setTestResult(await res.json());
    } catch (err) {
      setTestResult({ ok: false, error: String(err) });
    }
    setLoading(null);
  }

  async function handleSync() {
    setSyncing(true);
    setProgressEvents([]);
    setLatestProgress(null);

    // Fire the sync POST (fire-and-forget on server)
    await fetch("/api/admin/mirror/sync", { method: "POST" });

    // Connect to SSE for progress
    const evtSource = new EventSource("/api/admin/mirror/sync/progress");
    evtSource.onmessage = (event) => {
      const data: SyncProgressEvent = JSON.parse(event.data);
      setProgressEvents((prev) => [...prev, data]);
      setLatestProgress(data);

      if (data.type === "done") {
        evtSource.close();
        setSyncing(false);
        fetchStatus();
        fetchHistory();
      }
    };
    evtSource.onerror = () => {
      evtSource.close();
      setSyncing(false);
      fetchStatus();
      fetchHistory();
    };
  }

  async function handleStop() {
    await fetch("/api/admin/mirror/sync/stop", { method: "POST" });
  }

  return (
    <div className="space-y-8">
      {/* Server Identity */}
      <section className="border border-rule rounded-lg p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted mb-3">
          Server Identity
        </h2>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <span className="text-ink-muted">Node Name</span>
            <p className="font-medium">{nodeName}</p>
          </div>
          <div>
            <span className="text-ink-muted">Mode</span>
            <p className="font-medium">Mirror (read-only)</p>
          </div>
        </div>
      </section>

      {/* Upstream Configuration */}
      <section className="border border-rule rounded-lg p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted mb-3">
          Upstream Server
        </h2>
        <div className="flex items-center gap-3 mb-4">
          <code className="bg-parchment-dark px-2 py-1 rounded text-sm font-mono flex-1">
            {upstream}
          </code>
          <button
            onClick={handleTest}
            disabled={loading === "test"}
            className="px-3 py-1.5 text-sm bg-ink text-parchment rounded hover:bg-ink/90 disabled:opacity-50"
          >
            {loading === "test" ? "Testing..." : "Test Connection"}
          </button>
        </div>
        {testResult && (
          <div
            className={`text-sm p-3 rounded ${testResult.ok ? "bg-green-50 text-green-800 border border-green-200" : "bg-red-50 text-red-800 border border-red-200"}`}
          >
            {testResult.ok ? (
              <span>
                ✓ Valid Underlay server — {testResult.collectionCount} public
                collection{testResult.collectionCount !== 1 ? "s" : ""} available
              </span>
            ) : (
              <span>✗ {testResult.error}</span>
            )}
          </div>
        )}
      </section>

      {/* Sync Controls */}
      <section className="border border-rule rounded-lg p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted mb-3">
          Sync
        </h2>
        <div className="flex items-center justify-between mb-4">
          <div className="text-sm">
            <span className="text-ink-muted">Schedule: </span>
            <span className="font-mono">{syncSchedule}</span>
            <span className="text-ink-muted ml-2">(weekly)</span>
            {status?.lastSyncAt && (
              <span className="text-ink-muted ml-4">
                Last sync: {new Date(status.lastSyncAt).toLocaleString()}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {syncing && (
              <button
                onClick={handleStop}
                className="px-3 py-1.5 text-sm bg-red-600 text-white rounded hover:bg-red-700"
              >
                Stop
              </button>
            )}
            <button
              onClick={handleSync}
              disabled={syncing}
              className="px-3 py-1.5 text-sm bg-ink text-parchment rounded hover:bg-ink/90 disabled:opacity-50"
            >
              {syncing ? "Syncing..." : "Sync Now"}
            </button>
          </div>
        </div>

        {/* Live progress */}
        {syncing && latestProgress && (
          <div className="mb-4">
            <div className="flex items-center gap-3 text-sm mb-2">
              <span className="inline-block w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              <span className="font-medium">
                {latestProgress.progress.collectionsProcessed} / {latestProgress.progress.collectionsTotal} collections
              </span>
              {latestProgress.progress.currentCollection && (
                <span className="text-ink-muted font-mono text-xs">
                  {latestProgress.progress.currentCollection}
                </span>
              )}
            </div>
            <div className="w-full bg-parchment-dark rounded-full h-2 mb-2">
              <div
                className="bg-ink h-2 rounded-full transition-all duration-300"
                style={{
                  width: `${latestProgress.progress.collectionsTotal > 0
                    ? (latestProgress.progress.collectionsProcessed / latestProgress.progress.collectionsTotal) * 100
                    : 0}%`,
                }}
              />
            </div>
            <div className="grid grid-cols-4 gap-2 text-xs text-ink-muted">
              <span>Versions: {latestProgress.progress.versionsPulled}</span>
              <span>Files ↓: {latestProgress.progress.filesDownloaded}</span>
              <span>Files ✓: {latestProgress.progress.filesSkipped}</span>
              <span>Errors: {latestProgress.progress.errors}</span>
            </div>
          </div>
        )}

        {/* Event log */}
        {progressEvents.length > 0 && (
          <div
            ref={logRef}
            className="text-xs font-mono bg-parchment-dark border border-rule rounded p-3 max-h-48 overflow-y-auto space-y-0.5"
          >
            {progressEvents.map((evt, i) => (
              <div
                key={i}
                className={
                  evt.type === "error"
                    ? "text-red-700"
                    : evt.type === "done"
                      ? "text-green-700 font-semibold"
                      : "text-ink-muted"
                }
              >
                {evt.message}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Mirrored Collections */}
      <section className="border border-rule rounded-lg p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted mb-3">
          Mirrored Collections
        </h2>
        {status && status.collections.length > 0 ? (
          <PaginatedCollections collections={status.collections} />
        ) : status ? (
          <p className="text-sm text-ink-muted">
            No collections mirrored yet. Click "Sync Now" to pull from upstream.
          </p>
        ) : (
          <p className="text-sm text-ink-muted">Loading...</p>
        )}
      </section>

      {/* Sync History */}
      <section className="border border-rule rounded-lg p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted mb-3">
          Sync History
        </h2>
        {history.length > 0 ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-rule text-left text-ink-muted">
                <th className="pb-2 font-medium">When</th>
                <th className="pb-2 font-medium">Trigger</th>
                <th className="pb-2 font-medium">Status</th>
                <th className="pb-2 font-medium">Duration</th>
                <th className="pb-2 font-medium">Collections</th>
                <th className="pb-2 font-medium">Versions</th>
                <th className="pb-2 font-medium">Files</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => {
                const duration =
                  h.finishedAt
                    ? Math.round(
                        (new Date(h.finishedAt).getTime() - new Date(h.startedAt).getTime()) / 1000,
                      )
                    : null;
                return (
                  <tr key={h.id} className="border-b border-rule/50">
                    <td className="py-2 text-ink-muted">
                      {new Date(h.startedAt).toLocaleString()}
                    </td>
                    <td className="py-2">
                      <span
                        className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${
                          h.trigger === "cron"
                            ? "bg-blue-50 text-blue-700 border border-blue-200"
                            : "bg-purple-50 text-purple-700 border border-purple-200"
                        }`}
                      >
                        {h.trigger}
                      </span>
                    </td>
                    <td className="py-2">
                      <span
                        className={`text-xs font-medium ${
                          h.status === "completed"
                            ? "text-green-700"
                            : h.status === "running"
                              ? "text-amber-600"
                              : "text-red-700"
                        }`}
                      >
                        {h.status}
                      </span>
                    </td>
                    <td className="py-2 font-mono text-xs">
                      {duration !== null ? `${duration}s` : "—"}
                    </td>
                    <td className="py-2 text-xs">
                      {h.collectionsSynced} synced
                      {h.collectionsCreated > 0 && `, ${h.collectionsCreated} new`}
                      {h.collectionsFailed > 0 && (
                        <span className="text-red-600"> ({h.collectionsFailed} failed)</span>
                      )}
                    </td>
                    <td className="py-2 font-mono text-xs">{h.versionsPulled}</td>
                    <td className="py-2 text-xs">
                      {h.filesDownloaded} ↓ / {h.filesSkipped} ✓
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-ink-muted">No sync runs recorded yet.</p>
        )}
      </section>

      {/* Account Filters */}
      <section className="border border-rule rounded-lg p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted mb-3">
          Account Filters
        </h2>
        <p className="text-sm text-ink-muted mb-4">
          Scope which accounts are included or excluded from mirroring. Leave both empty to mirror all public collections.
        </p>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-ink-muted mb-1">
              Include accounts (one per line)
            </label>
            <textarea
              className="w-full border border-rule rounded px-3 py-2 text-sm font-mono bg-parchment resize-y min-h-[80px]"
              placeholder={"adapt\nkf"}
              disabled
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-muted mb-1">
              Exclude accounts (one per line)
            </label>
            <textarea
              className="w-full border border-rule rounded px-3 py-2 text-sm font-mono bg-parchment resize-y min-h-[80px]"
              placeholder={"test-user\nsandbox"}
              disabled
            />
          </div>
        </div>
        <p className="text-xs text-ink-muted mt-2 italic">
          Coming soon — currently mirrors all public collections from upstream.
        </p>
      </section>
    </div>
  );
}
