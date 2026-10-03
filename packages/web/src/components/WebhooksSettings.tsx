import { type FormEvent, useState } from 'react'

import { Alert, Badge, Button, Checkbox, Input, Table, Td, Th } from '~/components/ui'

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
    <div>
      <p className="text-ink-muted mb-3 text-sm">
        POST a signed payload to a URL whenever a new version is created. Choose which version bump
        types trigger each endpoint. Requests are signed with{' '}
        <code className="bg-parchment-dark px-1">HMAC-SHA256</code> in the{' '}
        <code className="bg-parchment-dark px-1">X-Underlay-Signature</code> header.
      </p>

      {newSecret && (
        <Alert variant="success" className="mb-4">
          <p className="mb-1 font-semibold">Webhook created</p>
          <p className="text-ink-muted mb-2 text-xs">
            Copy the signing secret now — it won't be shown again.
          </p>
          <code className="bg-ink text-parchment rounded-surface block p-2 font-mono text-xs break-all">
            {newSecret}
          </code>
        </Alert>
      )}

      {error && (
        <Alert variant="error" className="mb-4">
          {error}
        </Alert>
      )}
      {notice && (
        <Alert variant="success" className="mb-4">
          {notice}
        </Alert>
      )}

      {/* Create form */}
      <form
        onSubmit={handleCreate}
        className="border-rule rounded-surface mb-6 space-y-4 border p-4"
      >
        <div>
          <label htmlFor="webhookUrl" className="mb-1 block text-sm font-medium">
            Endpoint URL
          </label>
          <Input
            type="url"
            id="webhookUrl"
            required
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.org/hooks/underlay"
          />
        </div>
        <div>
          <span className="mb-1 block text-sm font-medium">Trigger on</span>
          <div className="flex flex-wrap gap-4">
            {BUMP_TYPES.map((bump) => (
              <label key={bump} className="flex items-center gap-2 text-sm">
                <Checkbox checked={filter.includes(bump)} onChange={() => toggleFilter(bump)} />
                {bump}
              </label>
            ))}
          </div>
        </div>
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Adding…' : 'Add webhook'}
        </Button>
      </form>

      {/* List */}
      {webhooks.length === 0 ? (
        <p className="text-ink-muted text-sm">No webhooks configured.</p>
      ) : (
        <div className="space-y-3">
          {webhooks.map((hook) => (
            <div key={hook.id} className="border-rule rounded-surface border p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-mono text-sm">{hook.url}</p>
                  <div className="text-ink-muted mt-1 flex flex-wrap items-center gap-2 text-xs">
                    {hook.bumpFilter.map((b) => (
                      <Badge key={b}>{b}</Badge>
                    ))}
                    {!hook.enabled && <span className="text-amber-700">· disabled</span>}
                    {hook.lastDeliveryAt && (
                      <span>· last fired {new Date(hook.lastDeliveryAt).toLocaleString()}</span>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-3 text-xs">
                  <Button variant="link" size="sm" onClick={() => handleTest(hook.id)}>
                    Test
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => handleToggle(hook)}>
                    {hook.enabled ? 'Disable' : 'Enable'}
                  </Button>
                  <Button variant="dangerLink" size="sm" onClick={() => handleDelete(hook.id)}>
                    Delete
                  </Button>
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
                    <Table dense>
                      <thead>
                        <tr>
                          <Th>When</Th>
                          <Th>Event</Th>
                          <Th>Status</Th>
                          <Th>Code</Th>
                          <Th>Attempts</Th>
                          <Th></Th>
                        </tr>
                      </thead>
                      <tbody>
                        {deliveries[hook.id]!.map((d) => (
                          <tr key={d.id} className="align-top">
                            <Td className="text-ink-muted whitespace-nowrap">
                              {new Date(d.createdAt).toLocaleString()}
                            </Td>
                            <Td>
                              {d.event}
                              {d.semver && <span className="text-ink-muted"> · {d.semver}</span>}
                            </Td>
                            <Td className={`font-medium ${STATUS_STYLES[d.status]}`}>
                              {d.status}
                              {d.error && d.status === 'failed' && (
                                <span className="text-ink-muted block font-normal">{d.error}</span>
                              )}
                            </Td>
                            <Td>{d.responseCode ?? '—'}</Td>
                            <Td>{d.attempts}</Td>
                            <Td>
                              {d.status !== 'success' && (
                                <Button
                                  variant="link"
                                  size="sm"
                                  onClick={() => handleRetry(hook.id, d.id)}
                                >
                                  Retry
                                </Button>
                              )}
                            </Td>
                          </tr>
                        ))}
                      </tbody>
                    </Table>
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
