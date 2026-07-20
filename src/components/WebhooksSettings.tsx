import { type FormEvent, useState } from 'react'

const BUMP_TYPES = ['major', 'minor', 'patch'] as const
type BumpType = (typeof BUMP_TYPES)[number]

interface Webhook {
  id: string
  url: string
  bumpFilter: string[]
  enabled: boolean
  createdAt: string
  lastDeliveryAt: string | null
}

interface Delivery {
  id: string
  event: string
  semver: string | null
  bumpType: string
  status: 'pending' | 'success' | 'failed'
  attempts: number
  responseCode: number | null
  error: string | null
  durationMs: number | null
  createdAt: string
  deliveredAt: string | null
}

const STATUS_STYLES: Record<Delivery['status'], string> = {
  success: 'text-green-700',
  failed: 'text-red-700',
  pending: 'text-ink-muted',
}

export default function WebhooksSettings({
  owner,
  collection,
  initialWebhooks,
}: {
  owner: string
  collection: string
  initialWebhooks: Webhook[]
}) {
  const base = `/api/collections/${owner}/${collection}/webhooks`

  const [webhooks, setWebhooks] = useState<Webhook[]>(initialWebhooks)
  const [url, setUrl] = useState('')
  const [filter, setFilter] = useState<BumpType[]>(['major', 'minor', 'patch'])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [newSecret, setNewSecret] = useState<string | null>(null)

  // Per-webhook delivery logs, loaded on demand
  const [deliveries, setDeliveries] = useState<Record<string, Delivery[]>>({})
  const [loadingLog, setLoadingLog] = useState<string | null>(null)

  function toggleFilter(bump: BumpType) {
    setFilter((prev) => (prev.includes(bump) ? prev.filter((b) => b !== bump) : [...prev, bump]))
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault()
    setError('')
    setNotice('')
    setNewSecret(null)
    if (filter.length === 0) {
      setError('Select at least one version type to trigger on.')
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ url: url.trim(), bumpFilter: filter }),
      })
      const body = await res.json().catch(() => ({}))
      if (res.ok) {
        setNewSecret(body.secret)
        setWebhooks((prev) => [
          {
            id: body.id,
            url: body.url,
            bumpFilter: body.bumpFilter,
            enabled: body.enabled,
            createdAt: body.createdAt,
            lastDeliveryAt: null,
          },
          ...prev,
        ])
        setUrl('')
        setFilter(['major', 'minor', 'patch'])
      } else {
        setError(body.error ?? 'Failed to create webhook.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  async function handleToggle(hook: Webhook) {
    const res = await fetch(`${base}/${hook.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ enabled: !hook.enabled }),
    })
    if (res.ok) {
      setWebhooks((prev) => prev.map((w) => (w.id === hook.id ? { ...w, enabled: !w.enabled } : w)))
    }
  }

  async function handleDelete(id: string) {
    const res = await fetch(`${base}/${id}`, { method: 'DELETE', credentials: 'include' })
    if (res.ok) setWebhooks((prev) => prev.filter((w) => w.id !== id))
  }

  async function handleTest(id: string) {
    setNotice('')
    setError('')
    const res = await fetch(`${base}/${id}/test`, { method: 'POST', credentials: 'include' })
    if (res.ok) {
      setNotice('Test delivery sent. Open the delivery log to see the result.')
      // Refresh the log if it's already open
      if (deliveries[id]) await loadDeliveries(id)
    } else {
      const body = await res.json().catch(() => ({}))
      setError(body.error ?? 'Test delivery failed.')
    }
  }

  async function loadDeliveries(id: string) {
    setLoadingLog(id)
    try {
      const res = await fetch(`${base}/${id}/deliveries`, { credentials: 'include' })
      if (res.ok) {
        const body = await res.json()
        setDeliveries((prev) => ({ ...prev, [id]: body.deliveries ?? [] }))
      }
    } finally {
      setLoadingLog(null)
    }
  }

  async function handleRetry(webhookId: string, deliveryId: string) {
    const res = await fetch(`${base}/${webhookId}/deliveries/${deliveryId}/retry`, {
      method: 'POST',
      credentials: 'include',
    })
    if (res.ok) {
      // Give the dispatch a moment, then refresh
      setTimeout(() => loadDeliveries(webhookId), 800)
    }
  }

  return (
    <div className="border-rule mb-10 border-t pt-6">
      <h2 className="text-ink-muted mb-3 text-sm font-semibold tracking-wide uppercase">
        Webhooks
      </h2>
      <p className="text-ink-muted mb-3 text-sm">
        POST a signed payload to a URL whenever a new version is created. Choose which version bump
        types trigger each endpoint. Requests are signed with{' '}
        <code className="bg-parchment-dark px-1">HMAC-SHA256</code> in the{' '}
        <code className="bg-parchment-dark px-1">X-Underlay-Signature</code> header.
      </p>

      {newSecret && (
        <div className="mb-4 border border-green-300 bg-green-50 p-4">
          <p className="mb-1 text-sm font-semibold">Webhook created</p>
          <p className="text-ink-muted mb-2 text-xs">
            Copy the signing secret now — it won't be shown again.
          </p>
          <code className="bg-ink text-parchment block p-2 font-mono text-xs break-all">
            {newSecret}
          </code>
        </div>
      )}

      {error && (
        <p className="mb-4 border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      {notice && (
        <p className="mb-4 border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
          {notice}
        </p>
      )}

      {/* Create form */}
      <form onSubmit={handleCreate} className="border-rule mb-6 space-y-4 border p-4">
        <div>
          <label htmlFor="webhookUrl" className="mb-1 block text-sm font-medium">
            Endpoint URL
          </label>
          <input
            type="url"
            id="webhookUrl"
            required
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.org/hooks/underlay"
            className="bg-parchment border-rule focus:border-ink w-full border px-3 py-2 text-sm focus:outline-none"
          />
        </div>
        <div>
          <span className="mb-1 block text-sm font-medium">Trigger on</span>
          <div className="flex flex-wrap gap-4">
            {BUMP_TYPES.map((bump) => (
              <label key={bump} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={filter.includes(bump)}
                  onChange={() => toggleFilter(bump)}
                  className="accent-ink"
                />
                {bump}
              </label>
            ))}
          </div>
        </div>
        <button
          type="submit"
          disabled={submitting}
          className="bg-ink text-parchment px-4 py-2 text-sm font-medium transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {submitting ? 'Adding…' : 'Add webhook'}
        </button>
      </form>

      {/* List */}
      {webhooks.length === 0 ? (
        <p className="text-ink-muted text-sm">No webhooks configured.</p>
      ) : (
        <div className="space-y-3">
          {webhooks.map((hook) => (
            <div key={hook.id} className="border-rule border p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-mono text-sm">{hook.url}</p>
                  <div className="text-ink-muted mt-1 flex flex-wrap items-center gap-2 text-xs">
                    {hook.bumpFilter.map((b) => (
                      <span key={b} className="border-rule border px-1 py-0.5">
                        {b}
                      </span>
                    ))}
                    {!hook.enabled && <span className="text-amber-700">· disabled</span>}
                    {hook.lastDeliveryAt && (
                      <span>· last fired {new Date(hook.lastDeliveryAt).toLocaleString()}</span>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-3 text-xs">
                  <button onClick={() => handleTest(hook.id)} className="text-link hover:underline">
                    Test
                  </button>
                  <button
                    onClick={() => handleToggle(hook)}
                    className="text-ink-muted hover:text-ink hover:underline"
                  >
                    {hook.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    onClick={() => handleDelete(hook.id)}
                    className="text-red-700 hover:underline"
                  >
                    Delete
                  </button>
                </div>
              </div>

              {/* Delivery log */}
              <details
                className="mt-2"
                onToggle={(e) => {
                  if ((e.target as HTMLDetailsElement).open && !deliveries[hook.id]) {
                    loadDeliveries(hook.id)
                  }
                }}
              >
                <summary className="text-ink-muted hover:text-ink cursor-pointer text-xs">
                  Delivery log
                </summary>
                <div className="mt-2">
                  {loadingLog === hook.id && !deliveries[hook.id] ? (
                    <p className="text-ink-muted text-xs">Loading…</p>
                  ) : (deliveries[hook.id]?.length ?? 0) === 0 ? (
                    <p className="text-ink-muted text-xs">No deliveries yet.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs">
                        <thead className="text-ink-muted">
                          <tr className="border-rule border-b">
                            <th className="py-1 pr-3 font-medium">When</th>
                            <th className="py-1 pr-3 font-medium">Event</th>
                            <th className="py-1 pr-3 font-medium">Status</th>
                            <th className="py-1 pr-3 font-medium">Code</th>
                            <th className="py-1 pr-3 font-medium">Attempts</th>
                            <th className="py-1 font-medium"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {deliveries[hook.id]!.map((d) => (
                            <tr key={d.id} className="border-rule/50 border-b align-top">
                              <td className="text-ink-muted py-1 pr-3 whitespace-nowrap">
                                {new Date(d.createdAt).toLocaleString()}
                              </td>
                              <td className="py-1 pr-3">
                                {d.event}
                                {d.semver && <span className="text-ink-muted"> · {d.semver}</span>}
                              </td>
                              <td className={`py-1 pr-3 font-medium ${STATUS_STYLES[d.status]}`}>
                                {d.status}
                                {d.error && d.status === 'failed' && (
                                  <span className="text-ink-muted block font-normal">
                                    {d.error}
                                  </span>
                                )}
                              </td>
                              <td className="py-1 pr-3">{d.responseCode ?? '—'}</td>
                              <td className="py-1 pr-3">{d.attempts}</td>
                              <td className="py-1">
                                {d.status !== 'success' && (
                                  <button
                                    onClick={() => handleRetry(hook.id, d.id)}
                                    className="text-link hover:underline"
                                  >
                                    Retry
                                  </button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </details>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
