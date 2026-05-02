import { useState, useEffect } from "react";

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
    localVersion: number;
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

interface SyncResult {
  startedAt: string;
  finishedAt: string;
  collections: { synced: number; created: number; failed: number };
  versions: { pulled: number };
  files: { downloaded: number; skipped: number };
  errors: string[];
}

export default function MirrorAdmin({ upstream, nodeName, syncSchedule }: Props) {
  const [status, setStatus] = useState<MirrorStatus | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [loading, setLoading] = useState<string | null>(null);

  useEffect(() => {
    fetchStatus();
  }, []);

  async function fetchStatus() {
    try {
      const res = await fetch("/api/admin/mirror/status");
      if (res.ok) setStatus(await res.json());
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
    setLoading("sync");
    setSyncResult(null);
    try {
      const res = await fetch("/api/admin/mirror/sync", { method: "POST" });
      setSyncResult(await res.json());
      await fetchStatus();
    } catch (err) {
      setSyncResult({
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        collections: { synced: 0, created: 0, failed: 0 },
        versions: { pulled: 0 },
        files: { downloaded: 0, skipped: 0 },
        errors: [String(err)],
      });
    }
    setLoading(null);
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
          </div>
          <button
            onClick={handleSync}
            disabled={loading === "sync"}
            className="px-3 py-1.5 text-sm bg-ink text-parchment rounded hover:bg-ink/90 disabled:opacity-50"
          >
            {loading === "sync" ? "Syncing..." : "Sync Now"}
          </button>
        </div>
        {syncResult && (
          <div className="text-sm border border-rule rounded p-3 space-y-1">
            <p>
              <span className="text-ink-muted">Duration:</span>{" "}
              {Math.round(
                (new Date(syncResult.finishedAt).getTime() -
                  new Date(syncResult.startedAt).getTime()) /
                  1000,
              )}
              s
            </p>
            <p>
              <span className="text-ink-muted">Collections:</span>{" "}
              {syncResult.collections.synced} synced, {syncResult.collections.created}{" "}
              new, {syncResult.collections.failed} failed
            </p>
            <p>
              <span className="text-ink-muted">Versions pulled:</span>{" "}
              {syncResult.versions.pulled}
            </p>
            <p>
              <span className="text-ink-muted">Files:</span>{" "}
              {syncResult.files.downloaded} downloaded, {syncResult.files.skipped}{" "}
              skipped (already had)
            </p>
            {syncResult.errors.length > 0 && (
              <div className="mt-2 text-red-700">
                <p className="font-medium">Errors:</p>
                <ul className="list-disc list-inside">
                  {syncResult.errors.slice(0, 5).map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </div>
            )}
            {syncResult.errors.length === 0 && (
              <p className="text-green-700 font-medium mt-1">✓ Up to date</p>
            )}
          </div>
        )}
      </section>

      {/* Mirrored Collections */}
      <section className="border border-rule rounded-lg p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted mb-3">
          Mirrored Collections
        </h2>
        {status && status.collections.length > 0 ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-rule text-left text-ink-muted">
                <th className="pb-2 font-medium">Collection</th>
                <th className="pb-2 font-medium">Version</th>
                <th className="pb-2 font-medium">Last Updated</th>
              </tr>
            </thead>
            <tbody>
              {status.collections.map((c) => (
                <tr key={`${c.ownerSlug}/${c.slug}`} className="border-b border-rule/50">
                  <td className="py-2">
                    <a
                      href={`/${c.ownerSlug}/${c.slug}`}
                      className="text-ink hover:underline"
                    >
                      {c.ownerSlug}/{c.slug}
                    </a>
                    <span className="text-ink-muted ml-2">— {c.name}</span>
                  </td>
                  <td className="py-2 font-mono">v{c.localVersion}</td>
                  <td className="py-2 text-ink-muted">
                    {new Date(c.updatedAt).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : status ? (
          <p className="text-sm text-ink-muted">
            No collections mirrored yet. Click "Sync Now" to pull from upstream.
          </p>
        ) : (
          <p className="text-sm text-ink-muted">Loading...</p>
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
