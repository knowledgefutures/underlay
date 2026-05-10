import { Link } from 'react-router'
import { useState, useEffect, type FormEvent } from 'react'
import BaseLayout from '~/components/BaseLayout'
import { useSSRData } from '~/lib/ssr-data'
import { ApiPlayground } from '~/components/ApiPlayground'

interface Key {
  id: string
  label: string
  keyPrefix?: string
  scope: string
  createdAt: string
  lastUsedAt?: string
  expiresAt?: string
}

interface Collection {
  id: string
  slug: string
}

function isExpiringSoon(expiresAt: string | null): boolean {
  if (!expiresAt) return false
  const daysLeft = (new Date(expiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
  return daysLeft > 0 && daysLeft < 7
}

function isExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false
  return new Date(expiresAt) < new Date()
}

export default function SettingsKeys() {
  const me = useSSRData<any>('currentUser')

  const [keys, setKeys] = useState<Key[]>([])
  const [collections, setCollections] = useState<Collection[]>([])
  const [newKeyResult, setNewKeyResult] = useState<{ key: string; label: string } | null>(null)
  const [error, setError] = useState('')

  // Create key form
  const [label, setLabel] = useState('')
  const [scope, setScope] = useState('write')
  const [collectionId, setCollectionId] = useState('')
  const [expiresIn, setExpiresIn] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!me) return

    fetch('/api/accounts/keys', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : []))
      .then(setKeys)

    fetch(`/api/accounts/${me.slug}/collections`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : []))
      .then(setCollections)
  }, [me])

  async function handleCreateKey(e: FormEvent) {
    e.preventDefault()
    setError('')
    setNewKeyResult(null)
    setSubmitting(true)
    try {
      const res = await fetch('/api/accounts/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          label,
          scope,
          collectionId: collectionId || undefined,
          expiresIn: expiresIn ? parseInt(expiresIn) : undefined,
        }),
      })
      if (res.ok) {
        const data = await res.json()
        setNewKeyResult({ key: data.key, label: data.label })
        setLabel('')
        // Refresh keys list
        const keysRes = await fetch('/api/accounts/keys', { credentials: 'include' })
        if (keysRes.ok) setKeys(await keysRes.json())
      } else {
        const body = await res.json().catch(() => ({}))
        setError(body.error ?? 'Failed to create key.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  async function handleRevokeKey(keyId: string) {
    await fetch(`/api/accounts/keys/${keyId}`, {
      method: 'DELETE',
      credentials: 'include',
    })
    setKeys((prev) => prev.filter((k) => k.id !== keyId))
  }

  if (!me) return null

  return (
    <BaseLayout>
      <div className="max-w-4xl mx-auto px-4 py-10">
        <h1 className="text-xl font-semibold tracking-tight mb-6">Settings</h1>

        <nav className="flex gap-4 text-sm border-b border-rule mb-6 pb-2">
          <Link to="/settings" className="text-ink-muted hover:text-ink">Account</Link>
          <Link to="/settings/keys" className="text-ink font-medium">API Keys</Link>
          <Link to="/settings/sessions" className="text-ink-muted hover:text-ink">Sessions</Link>
        </nav>

        {newKeyResult && (
          <div className="border border-green-300 bg-green-50 p-4 mb-4">
            <p className="text-sm font-semibold mb-1">Key created: {newKeyResult.label}</p>
            <p className="text-xs text-ink-muted mb-2">Copy this key now — it won't be shown again.</p>
            <code className="block text-xs font-mono bg-ink text-parchment p-2 break-all">{newKeyResult.key}</code>
          </div>
        )}

        {error && <p className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 mb-4">{error}</p>}

        <div className="border border-rule p-4 mb-6">
          <h2 className="text-sm font-semibold mb-3">Create a new key</h2>
          <form onSubmit={handleCreateKey} className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label htmlFor="label" className="block text-xs text-ink-muted mb-1">Label</label>
                <input
                  type="text"
                  id="label"
                  required
                  placeholder="my-sync-script"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  className="w-full bg-parchment border border-rule px-2 py-1.5 text-sm font-mono focus:outline-none focus:border-ink"
                />
              </div>
              <div>
                <label htmlFor="scope" className="block text-xs text-ink-muted mb-1">Scope</label>
                <select
                  id="scope"
                  value={scope}
                  onChange={(e) => setScope(e.target.value)}
                  className="w-full bg-parchment border border-rule px-2 py-1.5 text-sm focus:outline-none focus:border-ink"
                >
                  <option value="read">read — list and download</option>
                  <option value="write">write — push versions</option>
                  <option value="admin">admin — full access</option>
                </select>
              </div>
              <div>
                <label htmlFor="collectionId" className="block text-xs text-ink-muted mb-1">Scope to collection (optional)</label>
                <select
                  id="collectionId"
                  value={collectionId}
                  onChange={(e) => setCollectionId(e.target.value)}
                  className="w-full bg-parchment border border-rule px-2 py-1.5 text-sm focus:outline-none focus:border-ink"
                >
                  <option value="">All collections</option>
                  {collections.map((c) => (
                    <option key={c.id} value={c.id}>{c.slug}</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="expiresIn" className="block text-xs text-ink-muted mb-1">Expiration (optional)</label>
                <select
                  id="expiresIn"
                  value={expiresIn}
                  onChange={(e) => setExpiresIn(e.target.value)}
                  className="w-full bg-parchment border border-rule px-2 py-1.5 text-sm focus:outline-none focus:border-ink"
                >
                  <option value="">Never expires</option>
                  <option value="7">7 days</option>
                  <option value="30">30 days</option>
                  <option value="90">90 days</option>
                  <option value="365">1 year</option>
                </select>
              </div>
            </div>
            <button
              type="submit"
              disabled={submitting}
              className="bg-ink text-parchment px-4 py-1.5 text-sm font-medium hover:opacity-90 transition-opacity"
            >
              {submitting ? 'Creating…' : 'Create key'}
            </button>
          </form>
        </div>

        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted mb-3">
          Active Keys ({keys.length})
        </h2>

        {keys.length === 0 ? (
          <p className="text-sm text-ink-muted">No API keys yet.</p>
        ) : (
          <div className="space-y-2 mb-8">
            {keys.map((k) => (
              <div
                key={k.id}
                className={`flex items-center justify-between border p-3 ${isExpired(k.expiresAt ?? null) ? 'border-red-200 bg-red-50/50' : isExpiringSoon(k.expiresAt ?? null) ? 'border-yellow-300 bg-yellow-50/50' : 'border-rule'}`}
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{k.label}</span>
                    {k.keyPrefix && <span className="text-xs font-mono text-ink-muted">{k.keyPrefix}…</span>}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5 text-xs text-ink-muted flex-wrap">
                    <span className="border border-rule px-1 py-0.5">{k.scope}</span>
                    <span>Created {new Date(k.createdAt).toLocaleDateString()}</span>
                    {k.lastUsedAt && <span>· Last used {new Date(k.lastUsedAt).toLocaleDateString()}</span>}
                    {k.expiresAt && !isExpired(k.expiresAt) && (
                      <span className={isExpiringSoon(k.expiresAt) ? 'text-yellow-700 font-medium' : ''}>
                        · Expires {new Date(k.expiresAt).toLocaleDateString()}
                      </span>
                    )}
                    {isExpired(k.expiresAt ?? null) && <span className="text-red-700 font-medium">· Expired</span>}
                  </div>
                </div>
                <button
                  onClick={() => handleRevokeKey(k.id)}
                  className="text-xs text-red-700 hover:underline"
                >
                  Revoke
                </button>
              </div>
            ))}
          </div>
        )}

        {/* API Playground */}
        <div className="border-t border-rule pt-8">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted mb-3">API Playground</h2>
          <p className="text-xs text-ink-muted mb-4">Test API calls using your session. Select an endpoint to get started.</p>
          <ApiPlayground
            slug={me.slug}
            collections={collections.map((c) => ({ id: c.id, slug: c.slug }))}
          />
        </div>
      </div>
    </BaseLayout>
  )
}
