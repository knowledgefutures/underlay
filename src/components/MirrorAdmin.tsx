import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'

interface Props {
  upstream: string
  nodeName: string
  syncSchedule: string
}

interface MirrorStatus {
  upstream: string
  nodeName: string
  syncSchedule: string
  collections: {
    ownerSlug: string
    slug: string
    name: string
    localVersion: string
    updatedAt: string
  }[]
  lastSyncAt: string | null
}

interface TestResult {
  ok: boolean
  version?: string
  collectionCount?: number
  error?: string
}

interface SyncProgressEvent {
  type: 'start' | 'collection' | 'version' | 'file' | 'error' | 'done'
  message: string
  progress: {
    collectionsTotal: number
    collectionsProcessed: number
    currentCollection?: string
    versionsPulled: number
    filesDownloaded: number
    filesSkipped: number
    errors: number
  }
}

interface SyncHistoryEntry {
  id: string
  trigger: string
  status: string
  startedAt: string
  finishedAt: string | null
  collectionsSynced: number
  collectionsCreated: number
  collectionsFailed: number
  versionsPulled: number
  filesDownloaded: number
  filesSkipped: number
  errors: string[]
  logs: string[]
}

const PAGE_SIZE = 10

function PaginatedCollections({ collections }: { collections: MirrorStatus['collections'] }) {
  const [page, setPage] = useState(0)
  const totalPages = Math.ceil(collections.length / PAGE_SIZE)
  const visible = collections.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  return (
    <div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-rule text-ink-muted border-b text-left">
            <th className="pb-2 font-medium">Collection</th>
            <th className="pb-2 font-medium">Version</th>
            <th className="pb-2 font-medium">Last Updated</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((c) => (
            <tr key={`${c.ownerSlug}/${c.slug}`} className="border-rule/50 border-b">
              <td className="py-2">
                <Link to={`/${c.ownerSlug}/${c.slug}`} className="text-ink hover:underline">
                  {c.ownerSlug}/{c.slug}
                </Link>
                <span className="text-ink-muted ml-2">— {c.name}</span>
              </td>
              <td className="py-2 font-mono">{c.localVersion}</td>
              <td className="text-ink-muted py-2">{new Date(c.updatedAt).toLocaleDateString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {totalPages > 1 && (
        <div className="text-ink-muted mt-3 flex items-center justify-between text-xs">
          <span>{collections.length} collections</span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="border-rule hover:bg-parchment-dark rounded border px-2 py-1 disabled:opacity-30"
            >
              ← Prev
            </button>
            <span>
              {page + 1} / {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              className="border-rule hover:bg-parchment-dark rounded border px-2 py-1 disabled:opacity-30"
            >
              Next →
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default function MirrorAdmin({ upstream, nodeName, syncSchedule }: Props) {
  const [status, setStatus] = useState<MirrorStatus | null>(null)
  const [testResult, setTestResult] = useState<TestResult | null>(null)
  const [loading, setLoading] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [progressEvents, setProgressEvents] = useState<SyncProgressEvent[]>([])
  const [latestProgress, setLatestProgress] = useState<SyncProgressEvent | null>(null)
  const [history, setHistory] = useState<SyncHistoryEntry[]>([])
  const [expandedRun, setExpandedRun] = useState<string | null>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const evtSourceRef = useRef<EventSource | null>(null)

  useEffect(() => {
    fetchStatus()
    fetchHistory()
    // Check if a sync is already running (e.g. page refresh)
    checkActiveSync()
    return () => {
      evtSourceRef.current?.close()
    }
  }, [])

  // Auto-scroll log
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [progressEvents])

  async function checkActiveSync() {
    try {
      const res = await fetch('/api/admin/mirror/sync/active')
      if (!res.ok) return
      const data = await res.json()
      if (data.running) {
        setSyncing(true)
        // Populate buffered logs
        if (data.logs?.length) {
          setProgressEvents(
            data.logs.map((msg: string) => ({
              type: 'collection' as const,
              message: msg,
              progress: {
                collectionsTotal: 0,
                collectionsProcessed: 0,
                versionsPulled: 0,
                filesDownloaded: 0,
                filesSkipped: 0,
                errors: 0,
              },
            })),
          )
        }
        // Connect to SSE
        connectSSE()
      }
    } catch {
      // ignore
    }
  }

  async function fetchStatus() {
    try {
      const res = await fetch('/api/admin/mirror/status')
      if (res.ok) setStatus(await res.json())
    } catch {
      // ignore
    }
  }

  async function fetchHistory() {
    try {
      const res = await fetch('/api/admin/mirror/history')
      if (res.ok) setHistory(await res.json())
    } catch {
      // ignore
    }
  }

  async function handleTest() {
    setLoading('test')
    setTestResult(null)
    try {
      const res = await fetch('/api/admin/mirror/test', { method: 'POST' })
      setTestResult(await res.json())
    } catch (err) {
      setTestResult({ ok: false, error: String(err) })
    }
    setLoading(null)
  }

  function connectSSE() {
    const evtSource = new EventSource('/api/admin/mirror/sync/progress')
    evtSourceRef.current = evtSource
    evtSource.onmessage = (event) => {
      const data: SyncProgressEvent = JSON.parse(event.data)
      setProgressEvents((prev) => [...prev, data])
      setLatestProgress(data)

      if (data.type === 'done') {
        evtSource.close()
        evtSourceRef.current = null
        setSyncing(false)
        fetchStatus()
        fetchHistory()
      }
    }
    evtSource.onerror = () => {
      evtSource.close()
      evtSourceRef.current = null
      setSyncing(false)
      fetchStatus()
      fetchHistory()
    }
  }

  async function handleSync() {
    setSyncing(true)
    setProgressEvents([])
    setLatestProgress(null)

    // Fire the sync POST (fire-and-forget on server)
    await fetch('/api/admin/mirror/sync', { method: 'POST' })

    // Connect to SSE for progress
    connectSSE()
  }

  async function handleStop() {
    await fetch('/api/admin/mirror/sync/stop', { method: 'POST' })
    // Refresh history to reflect status change (stale rows get cleaned up server-side)
    await fetchHistory()
  }

  return (
    <div className="space-y-8">
      {/* Server Identity */}
      <section className="border-rule rounded-lg border p-5">
        <h2 className="text-ink-muted mb-3 text-sm font-semibold tracking-wide uppercase">
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
      <section className="border-rule rounded-lg border p-5">
        <h2 className="text-ink-muted mb-3 text-sm font-semibold tracking-wide uppercase">
          Upstream Server
        </h2>
        <div className="mb-4 flex items-center gap-3">
          <code className="bg-parchment-dark flex-1 rounded px-2 py-1 font-mono text-sm">
            {upstream}
          </code>
          <button
            onClick={handleTest}
            disabled={loading === 'test'}
            className="bg-ink text-parchment hover:bg-ink/90 rounded px-3 py-1.5 text-sm disabled:opacity-50"
          >
            {loading === 'test' ? 'Testing...' : 'Test Connection'}
          </button>
        </div>
        {testResult && (
          <div
            className={`rounded p-3 text-sm ${
              testResult.ok
                ? 'border border-green-200 bg-green-50 text-green-800'
                : 'border border-red-200 bg-red-50 text-red-800'
            }`}
          >
            {testResult.ok ? (
              <span>
                ✓ Valid Underlay server — {testResult.collectionCount} public collection
                {testResult.collectionCount !== 1 ? 's' : ''} available
              </span>
            ) : (
              <span>✗ {testResult.error}</span>
            )}
          </div>
        )}
      </section>

      {/* Sync Controls + History */}
      <section className="border-rule rounded-lg border p-5">
        <h2 className="text-ink-muted mb-3 text-sm font-semibold tracking-wide uppercase">Sync</h2>
        <div className="mb-4 flex items-center justify-between">
          <div className="text-sm">
            <span className="text-ink-muted">Schedule:</span>
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
                className="rounded bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700"
              >
                Stop
              </button>
            )}
            <button
              onClick={handleSync}
              disabled={syncing}
              className="bg-ink text-parchment hover:bg-ink/90 rounded px-3 py-1.5 text-sm disabled:opacity-50"
            >
              {syncing ? 'Syncing...' : 'Sync Now'}
            </button>
          </div>
        </div>

        {/* Live progress */}
        {syncing && latestProgress && (
          <div className="mb-4">
            <div className="mb-2 flex items-center gap-3 text-sm">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-green-500" />
              <span className="font-medium">
                {latestProgress.progress.collectionsProcessed} /{' '}
                {latestProgress.progress.collectionsTotal} collections
              </span>
              {latestProgress.progress.currentCollection && (
                <span className="text-ink-muted font-mono text-xs">
                  {latestProgress.progress.currentCollection}
                </span>
              )}
            </div>
            <div className="bg-parchment-dark mb-2 h-2 w-full rounded-full">
              <div
                className="bg-ink h-2 rounded-full transition-all duration-300"
                style={{
                  width: `${
                    latestProgress.progress.collectionsTotal > 0
                      ? (latestProgress.progress.collectionsProcessed /
                          latestProgress.progress.collectionsTotal) *
                        100
                      : 0
                  }%`,
                }}
              />
            </div>
            <div className="text-ink-muted grid grid-cols-4 gap-2 text-xs">
              <span>Versions: {latestProgress.progress.versionsPulled}</span>
              <span>Files ↓: {latestProgress.progress.filesDownloaded}</span>
              <span>Files ✓: {latestProgress.progress.filesSkipped}</span>
              <span>Errors: {latestProgress.progress.errors}</span>
            </div>
          </div>
        )}

        {/* Event log (live) */}
        {progressEvents.length > 0 && (
          <div
            ref={logRef}
            className="bg-parchment-dark border-rule mb-4 max-h-48 space-y-0.5 overflow-y-auto rounded border p-3 font-mono text-xs"
          >
            {progressEvents.map((evt, i) => (
              <div
                key={i}
                className={
                  evt.type === 'error'
                    ? 'text-red-700'
                    : evt.type === 'done'
                      ? 'font-semibold text-green-700'
                      : 'text-ink-muted'
                }
              >
                {evt.message}
              </div>
            ))}
          </div>
        )}

        {/* History table */}
        {history.length > 0 && (
          <div className="border-rule mt-4 border-t pt-4">
            <h3 className="text-ink-muted mb-2 text-xs font-semibold tracking-wide uppercase">
              History
            </h3>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-rule text-ink-muted border-b text-left">
                  <th className="pb-2 font-medium">When</th>
                  <th className="pb-2 font-medium">Trigger</th>
                  <th className="pb-2 font-medium">Status</th>
                  <th className="pb-2 font-medium">Duration</th>
                  <th className="pb-2 font-medium">Summary</th>
                  <th className="pb-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => {
                  const duration = h.finishedAt
                    ? Math.round(
                        (new Date(h.finishedAt).getTime() - new Date(h.startedAt).getTime()) / 1000,
                      )
                    : null
                  return (
                    <tr key={h.id} className="border-rule/50 border-b align-top">
                      <td className="text-ink-muted py-2 text-xs">
                        {new Date(h.startedAt).toLocaleString()}
                      </td>
                      <td className="py-2">
                        <span
                          className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${
                            h.trigger === 'cron'
                              ? 'border border-blue-200 bg-blue-50 text-blue-700'
                              : 'border border-purple-200 bg-purple-50 text-purple-700'
                          }`}
                        >
                          {h.trigger}
                        </span>
                      </td>
                      <td className="py-2">
                        <span
                          className={`text-xs font-medium ${
                            h.status === 'completed'
                              ? 'text-green-700'
                              : h.status === 'running'
                                ? 'text-amber-600'
                                : 'text-red-700'
                          }`}
                        >
                          {h.status}
                        </span>
                      </td>
                      <td className="py-2 font-mono text-xs">
                        {duration !== null ? `${duration}s` : '—'}
                      </td>
                      <td className="py-2 text-xs">
                        {h.collectionsSynced} synced, {h.versionsPulled} ver, {h.filesDownloaded}↓{' '}
                        {h.filesSkipped}✓
                        {h.collectionsFailed > 0 && (
                          <span className="ml-1 text-red-600">({h.collectionsFailed} failed)</span>
                        )}
                      </td>
                      <td className="space-x-2 py-2 text-right text-xs">
                        {h.status === 'running' && (
                          <button
                            onClick={handleStop}
                            className="rounded bg-red-600 px-2 py-0.5 text-xs text-white hover:bg-red-700"
                          >
                            Stop
                          </button>
                        )}
                        {h.logs && h.logs.length > 0 && (
                          <button
                            onClick={() => setExpandedRun(expandedRun === h.id ? null : h.id)}
                            className="border-rule hover:bg-parchment-dark rounded border px-2 py-0.5 text-xs"
                          >
                            {expandedRun === h.id ? 'Hide' : 'Logs'}
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {/* Expanded logs for a history entry */}
            {expandedRun &&
              (() => {
                const run = history.find((h) => h.id === expandedRun)
                if (!run?.logs?.length) return null
                return (
                  <div className="bg-parchment-dark border-rule mt-2 max-h-48 space-y-0.5 overflow-y-auto rounded border p-3 font-mono text-xs">
                    {run.logs.map((msg, i) => (
                      <div key={i} className="text-ink-muted">
                        {msg}
                      </div>
                    ))}
                  </div>
                )
              })()}
          </div>
        )}
      </section>

      {/* Mirrored Collections */}
      <section className="border-rule rounded-lg border p-5">
        <h2 className="text-ink-muted mb-3 text-sm font-semibold tracking-wide uppercase">
          Mirrored Collections
        </h2>
        {status && status.collections.length > 0 ? (
          <PaginatedCollections collections={status.collections} />
        ) : status ? (
          <p className="text-ink-muted text-sm">
            No collections mirrored yet. Click "Sync Now" to pull from upstream.
          </p>
        ) : (
          <p className="text-ink-muted text-sm">Loading...</p>
        )}
      </section>

      {/* Account Filters */}
      <section className="border-rule rounded-lg border p-5">
        <h2 className="text-ink-muted mb-3 text-sm font-semibold tracking-wide uppercase">
          Account Filters
        </h2>
        <p className="text-ink-muted mb-4 text-sm">
          Scope which accounts are included or excluded from mirroring. Leave both empty to mirror
          all public collections.
        </p>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-ink-muted mb-1 block text-xs font-medium">
              Include accounts (one per line)
            </label>
            <textarea
              className="border-rule bg-parchment min-h-[80px] w-full resize-y rounded border px-3 py-2 font-mono text-sm"
              placeholder={'adapt\nkf'}
              disabled
            />
          </div>
          <div>
            <label className="text-ink-muted mb-1 block text-xs font-medium">
              Exclude accounts (one per line)
            </label>
            <textarea
              className="border-rule bg-parchment min-h-[80px] w-full resize-y rounded border px-3 py-2 font-mono text-sm"
              placeholder={'test-user\nsandbox'}
              disabled
            />
          </div>
        </div>
        <p className="text-ink-muted mt-2 text-xs italic">
          Coming soon — currently mirrors all public collections from upstream.
        </p>
      </section>
    </div>
  )
}
