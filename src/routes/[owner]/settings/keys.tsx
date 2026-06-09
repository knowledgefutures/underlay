import { type FormEvent, useEffect, useState } from 'react'
import { Link, useLoaderData, useParams } from 'react-router'

import { ApiPlayground } from '~/components/ApiPlayground'
import BaseLayout from '~/components/BaseLayout'
import { useAppContext } from '~/lib/app-context'
import { authClient } from '~/lib/auth-client'

interface Key {
  id: string
  name: string
  start?: string
  permissions?: Record<string, string[]>
  metadata?: { collectionIds?: string[] }
  createdAt: string
  expiresAt?: string
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

function getScope(permissions?: Record<string, string[]>): string {
  const perms = permissions?.['collections'] ?? []
  if (perms.includes('admin')) return 'admin'
  if (perms.includes('write')) return 'write'
  return 'read'
}

export default function OwnerSettingsKeys() {
  const { owner } = useParams()
  const { currentUser } = useAppContext()
  const { collections } = useLoaderData() as { collections: any[] }

  const org = currentUser?.orgs?.find((o: any) => o.slug === owner)
  const isAdmin = org?.role === 'admin' || org?.role === 'owner'

  const [keys, setKeys] = useState<Key[]>([])
  const [error, setError] = useState('')
  const [newKeyResult, setNewKeyResult] = useState<{ key: string; name: string } | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const [keyLabel, setKeyLabel] = useState('')
  const [keyScope, setKeyScope] = useState('write')
  const [keyCollectionId, setKeyCollectionId] = useState('')
  const [keyExpiresIn, setKeyExpiresIn] = useState('')

  async function loadKeys() {
    const { data } = await authClient.apiKey.list()
    if (data) setKeys((data as any).apiKeys ?? [])
  }

  useEffect(() => {
    loadKeys()
  }, [])

  if (!currentUser) {
    window.location.href = '/login'
    return null
  }

  async function handleCreateKey(e: FormEvent) {
    e.preventDefault()
    setError('')
    setNewKeyResult(null)
    setSubmitting(true)
    try {
      const metadata: Record<string, any> = { scope: keyScope }
      if (keyCollectionId) metadata.collectionIds = [keyCollectionId]
      const { data, error: err } = await authClient.apiKey.create({
        name: keyLabel,
        metadata,
        expiresIn: keyExpiresIn ? parseInt(keyExpiresIn) * 24 * 60 * 60 : undefined,
        prefix: 'ul',
      } as any)
      if (err) {
        setError(err.message ?? 'Failed to create key.')
      } else if (data) {
        setNewKeyResult({ key: (data as any).key, name: keyLabel })
        setKeyLabel('')
        await loadKeys()
      }
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDeleteKey(keyId: string) {
    setError('')
    await authClient.apiKey.delete({ keyId } as any)
    setKeys((prev) => prev.filter((k) => k.id !== keyId))
  }

  return (
    <BaseLayout>
      <div className="mx-auto max-w-4xl px-4 py-10">
        <nav className="text-ink-muted mb-6 text-xs">
          <Link to={`/${owner}`} className="hover:text-ink">
            {owner}
          </Link>
          <span className="mx-1">/</span>
          <span className="text-ink font-medium">settings</span>
        </nav>

        <h1 className="mb-6 text-xl font-semibold tracking-tight">Organization Settings</h1>

        <nav className="border-rule mb-6 flex gap-4 border-b pb-2 text-sm">
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

        {error && (
          <p className="mb-4 border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}

        {newKeyResult && (
          <div className="mb-4 border border-green-300 bg-green-50 p-4">
            <p className="mb-1 text-sm font-semibold">Key created: {newKeyResult.name}</p>
            <p className="text-ink-muted mb-2 text-xs">
              Copy this key now — it won't be shown again.
            </p>
            <code className="bg-ink text-parchment block p-2 font-mono text-xs break-all">
              {newKeyResult.key}
            </code>
          </div>
        )}

        {isAdmin && (
          <form onSubmit={handleCreateKey} className="border-rule mb-6 space-y-3 border p-4">
            <h2 className="mb-1 text-sm font-semibold">Create a new key</h2>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <label htmlFor="keyLabel" className="text-ink-muted mb-1 block text-xs">
                  Label
                </label>
                <input
                  type="text"
                  id="keyLabel"
                  value={keyLabel}
                  onChange={(e) => setKeyLabel(e.target.value)}
                  required
                  placeholder="ci-deploy"
                  className="bg-parchment border-rule focus:border-ink w-full border px-2 py-1.5 font-mono text-sm focus:outline-none"
                />
              </div>
              <div>
                <label htmlFor="keyScope" className="text-ink-muted mb-1 block text-xs">
                  Scope
                </label>
                <select
                  id="keyScope"
                  value={keyScope}
                  onChange={(e) => setKeyScope(e.target.value)}
                  className="bg-parchment border-rule focus:border-ink w-full border px-2 py-1.5 text-sm focus:outline-none"
                >
                  <option value="read">read — list and download</option>
                  <option value="write">write — push versions</option>
                  <option value="admin">admin — full access</option>
                </select>
              </div>
              <div>
                <label htmlFor="keyCollection" className="text-ink-muted mb-1 block text-xs">
                  Collection (optional)
                </label>
                <select
                  id="keyCollection"
                  value={keyCollectionId}
                  onChange={(e) => setKeyCollectionId(e.target.value)}
                  className="bg-parchment border-rule focus:border-ink w-full border px-2 py-1.5 text-sm focus:outline-none"
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
                <label htmlFor="keyExpiry" className="text-ink-muted mb-1 block text-xs">
                  Expiration (optional)
                </label>
                <select
                  id="keyExpiry"
                  value={keyExpiresIn}
                  onChange={(e) => setKeyExpiresIn(e.target.value)}
                  className="bg-parchment border-rule focus:border-ink w-full border px-2 py-1.5 text-sm focus:outline-none"
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
              className="bg-ink text-parchment px-4 py-1.5 text-sm font-medium transition-opacity hover:opacity-90"
            >
              Create key
            </button>
          </form>
        )}

        <h2 className="text-ink-muted mb-3 text-sm font-semibold tracking-wide uppercase">
          Active Keys ({keys.length})
        </h2>

        <div className="text-ink-muted bg-parchment border-rule mb-4 border px-3 py-2 text-xs">
          <strong className="text-ink">Rate limits:</strong> Authenticated requests get 5,000
          req/min. Without a key, the API allows 60 req/min per IP.
          <Link to="/docs/api" className="text-link ml-1 underline">
            Learn more →
          </Link>
        </div>

        {keys.length === 0 ? (
          <p className="text-ink-muted text-sm">No API keys for this organization.</p>
        ) : (
          <div className="mb-8 space-y-2">
            {keys.map((k) => (
              <div
                key={k.id}
                className={`flex items-center justify-between border p-3 ${
                  isExpired(k.expiresAt ?? null)
                    ? 'border-red-200 bg-red-50/50'
                    : isExpiringSoon(k.expiresAt ?? null)
                      ? 'border-yellow-300 bg-yellow-50/50'
                      : 'border-rule'
                }`}
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{k.name}</span>
                    {k.start && (
                      <span className="text-ink-muted font-mono text-xs">{k.start}…</span>
                    )}
                  </div>
                  <div className="text-ink-muted mt-0.5 flex flex-wrap items-center gap-2 text-xs">
                    <span className="border-rule border px-1 py-0.5">
                      {getScope(k.permissions)}
                    </span>
                    {k.metadata?.collectionIds?.length && (
                      <span className="border-rule border px-1 py-0.5">
                        {k.metadata.collectionIds
                          .map((id) => collections.find((c) => c.id === id)?.slug ?? id.slice(0, 8))
                          .join(', ')}
                      </span>
                    )}
                    <span>Created {new Date(k.createdAt).toLocaleDateString()}</span>
                    {k.expiresAt && !isExpired(k.expiresAt) && (
                      <span
                        className={isExpiringSoon(k.expiresAt) ? 'font-medium text-yellow-700' : ''}
                      >
                        · Expires {new Date(k.expiresAt).toLocaleDateString()}
                      </span>
                    )}
                    {isExpired(k.expiresAt ?? null) && (
                      <span className="font-medium text-red-700">· Expired</span>
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
        <div className="border-rule border-t pt-8">
          <h2 className="text-ink-muted mb-3 text-sm font-semibold tracking-wide uppercase">
            API Playground
          </h2>
          <p className="text-ink-muted mb-4 text-xs">
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
