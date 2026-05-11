import { useState, useEffect, type FormEvent } from 'react'
import { Link, useParams } from 'react-router'
import BaseLayout from '~/components/BaseLayout'
import { useSSRData } from '~/lib/ssr-data'
import { ApiPlayground } from '~/components/ApiPlayground'

function isExpiringSoon(expiresAt: string | null): boolean {
  if (!expiresAt) return false
  const daysLeft = (new Date(expiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
  return daysLeft > 0 && daysLeft < 7
}

function isExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false
  return new Date(expiresAt) < new Date()
}

export default function OwnerSettingsKeys() {
  const { owner } = useParams()
  const currentUser = useSSRData<any>('currentUser')

  const [orgData, setOrgData] = useState<any>(null)
  const [isAdmin, setIsAdmin] = useState(false)
  const [keys, setKeys] = useState<any[]>([])
  const [collections, setCollections] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [success, setSuccess] = useState('')
  const [error, setError] = useState('')
  const [newKeyResult, setNewKeyResult] = useState<{ key: string; label: string } | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // Create key form
  const [keyLabel, setKeyLabel] = useState('')
  const [keyScope, setKeyScope] = useState('write')
  const [keyCollectionId, setKeyCollectionId] = useState('')
  const [keyExpiresIn, setKeyExpiresIn] = useState('')

  useEffect(() => {
    if (!owner || !currentUser) return

    const org = currentUser.orgs?.find((o: any) => o.slug === owner)
    if (!org) {
      window.location.href = `/${owner}`
      return
    }

    const adminRole = org.role === 'admin' || org.role === 'owner'
    setIsAdmin(adminRole)

    Promise.all([
      fetch(`/api/accounts/${owner}`, { credentials: 'include' }).then((r) =>
        r.ok ? r.json() : null,
      ),
      fetch(`/api/accounts/${owner}/keys`, { credentials: 'include' }).then((r) =>
        r.ok ? r.json() : [],
      ),
      fetch(`/api/accounts/${owner}/collections`, { credentials: 'include' }).then((r) =>
        r.ok ? r.json() : [],
      ),
    ]).then(([org, k, cols]) => {
      if (!org) {
        window.location.href = '/404'
        return
      }
      setOrgData(org)
      setKeys(k)
      setCollections(cols)
      setLoading(false)
    })
  }, [owner, currentUser])

  if (!currentUser) {
    window.location.href = '/login'
    return null
  }

  async function handleCreateKey(e: FormEvent) {
    e.preventDefault()
    setSuccess('')
    setError('')
    setNewKeyResult(null)
    setSubmitting(true)
    try {
      const res = await fetch(`/api/accounts/${owner}/keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          label: keyLabel,
          scope: keyScope,
          collectionId: keyCollectionId || undefined,
          expiresIn: keyExpiresIn ? parseInt(keyExpiresIn) : undefined,
        }),
      })
      if (res.ok) {
        const data = await res.json()
        setNewKeyResult({ key: data.key, label: data.label })
        setKeyLabel('')
        // Refresh keys
        const refreshRes = await fetch(`/api/accounts/${owner}/keys`, { credentials: 'include' })
        if (refreshRes.ok) setKeys(await refreshRes.json())
      } else {
        const body = await res.json().catch(() => ({}))
        setError(body.error ?? 'Failed to create key.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDeleteKey(keyId: string) {
    setSuccess('')
    setError('')
    await fetch(`/api/accounts/${owner}/keys/${keyId}`, {
      method: 'DELETE',
      credentials: 'include',
    })
    setSuccess('Key revoked.')
    const refreshRes = await fetch(`/api/accounts/${owner}/keys`, { credentials: 'include' })
    if (refreshRes.ok) setKeys(await refreshRes.json())
  }

  if (loading || !orgData) {
    return (
      <BaseLayout>
        <div className="max-w-4xl mx-auto px-4 py-10 text-sm text-ink-muted">Loading…</div>
      </BaseLayout>
    )
  }

  return (
    <BaseLayout>
      <div className="max-w-4xl mx-auto px-4 py-10">
        <nav className="text-xs text-ink-muted mb-6">
          <Link to={`/${owner}`} className="hover:text-ink">
            {owner}
          </Link>
          <span className="mx-1">/</span>
          <span className="text-ink font-medium">settings</span>
        </nav>

        <h1 className="text-xl font-semibold tracking-tight mb-6">Organization Settings</h1>

        <nav className="flex gap-4 text-sm border-b border-rule mb-6 pb-2">
          <Link to={`/${owner}/settings`} className="text-ink-muted hover:text-ink">
            Profile
          </Link>
          <Link to={`/${owner}/settings/members`} className="text-ink-muted hover:text-ink">
            Members
          </Link>
          <Link to={`/${owner}/settings/keys`} className="text-ink font-medium">
            API Keys
          </Link>
        </nav>

        {success && (
          <p className="text-sm text-green-800 bg-green-50 border border-green-200 px-3 py-2 mb-4">
            {success}
          </p>
        )}
        {error && (
          <p className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 mb-4">
            {error}
          </p>
        )}

        {newKeyResult && (
          <div className="border border-green-300 bg-green-50 p-4 mb-4">
            <p className="text-sm font-semibold mb-1">Key created: {newKeyResult.label}</p>
            <p className="text-xs text-ink-muted mb-2">
              Copy this key now — it won't be shown again.
            </p>
            <code className="block text-xs font-mono bg-ink text-parchment p-2 break-all">
              {newKeyResult.key}
            </code>
          </div>
        )}

        {isAdmin && (
          <form onSubmit={handleCreateKey} className="border border-rule p-4 mb-6 space-y-3">
            <h2 className="text-sm font-semibold mb-1">Create a new key</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label htmlFor="keyLabel" className="block text-xs text-ink-muted mb-1">
                  Label
                </label>
                <input
                  type="text"
                  id="keyLabel"
                  value={keyLabel}
                  onChange={(e) => setKeyLabel(e.target.value)}
                  required
                  placeholder="ci-deploy"
                  className="w-full bg-parchment border border-rule px-2 py-1.5 text-sm font-mono focus:outline-none focus:border-ink"
                />
              </div>
              <div>
                <label htmlFor="keyScope" className="block text-xs text-ink-muted mb-1">
                  Scope
                </label>
                <select
                  id="keyScope"
                  value={keyScope}
                  onChange={(e) => setKeyScope(e.target.value)}
                  className="w-full bg-parchment border border-rule px-2 py-1.5 text-sm focus:outline-none focus:border-ink"
                >
                  <option value="read">read — list and download</option>
                  <option value="write">write — push versions</option>
                  <option value="admin">admin — full access</option>
                </select>
              </div>
              <div>
                <label htmlFor="keyCollection" className="block text-xs text-ink-muted mb-1">
                  Collection (optional)
                </label>
                <select
                  id="keyCollection"
                  value={keyCollectionId}
                  onChange={(e) => setKeyCollectionId(e.target.value)}
                  className="w-full bg-parchment border border-rule px-2 py-1.5 text-sm focus:outline-none focus:border-ink"
                >
                  <option value="">All collections</option>
                  {collections.map((c: any) => (
                    <option key={c.id} value={c.id}>
                      {c.slug}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="keyExpiry" className="block text-xs text-ink-muted mb-1">
                  Expiration
                </label>
                <select
                  id="keyExpiry"
                  value={keyExpiresIn}
                  onChange={(e) => setKeyExpiresIn(e.target.value)}
                  className="w-full bg-parchment border border-rule px-2 py-1.5 text-sm focus:outline-none focus:border-ink"
                >
                  <option value="">Never</option>
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
              Create key
            </button>
          </form>
        )}

        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted mb-3">
          Active Keys ({keys.length})
        </h2>

        <div className="text-xs text-ink-muted bg-parchment border border-rule px-3 py-2 mb-4">
          <strong className="text-ink">Rate limits:</strong> Authenticated requests get 5,000
          req/min. Without a key, the API allows 60 req/min per IP.
          <Link to="/docs/api" className="text-link underline ml-1">
            Learn more →
          </Link>
        </div>

        {keys.length === 0 ? (
          <p className="text-sm text-ink-muted">No API keys for this organization.</p>
        ) : (
          <div className="space-y-2 mb-8">
            {keys.map((k: any) => (
              <div
                key={k.id}
                className={`flex items-center justify-between border p-3 ${isExpired(k.expiresAt) ? 'border-red-200 bg-red-50/50' : isExpiringSoon(k.expiresAt) ? 'border-yellow-300 bg-yellow-50/50' : 'border-rule'}`}
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{k.label}</span>
                    {k.keyPrefix && (
                      <span className="text-xs font-mono text-ink-muted">{k.keyPrefix}…</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5 text-xs text-ink-muted flex-wrap">
                    <span className="border border-rule px-1 py-0.5">{k.scope}</span>
                    <span>Created {new Date(k.createdAt).toLocaleDateString()}</span>
                    {k.lastUsedAt && (
                      <span>· Last used {new Date(k.lastUsedAt).toLocaleDateString()}</span>
                    )}
                    {k.expiresAt && !isExpired(k.expiresAt) && (
                      <span
                        className={
                          isExpiringSoon(k.expiresAt) ? 'text-yellow-700 font-medium' : ''
                        }
                      >
                        · Expires {new Date(k.expiresAt).toLocaleDateString()}
                      </span>
                    )}
                    {isExpired(k.expiresAt) && (
                      <span className="text-red-700 font-medium">· Expired</span>
                    )}
                  </div>
                </div>
                {isAdmin && (
                  <button
                    onClick={() => handleDeleteKey(k.id)}
                    className="text-xs text-red-700 hover:underline"
                  >
                    Revoke
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {/* API Playground */}
        <div className="border-t border-rule pt-8">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted mb-3">
            API Playground
          </h2>
          <p className="text-xs text-ink-muted mb-4">
            Test API calls using your session. Select an example to get started.
          </p>
          <ApiPlayground
            slug={owner!}
            collections={collections.map((c: any) => ({ id: c.id, slug: c.slug }))}
          />
        </div>
      </div>
    </BaseLayout>
  )
}
