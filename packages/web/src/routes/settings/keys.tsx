import { type FormEvent, useEffect, useState } from 'react'

import { ApiPlayground } from '~/components/ApiPlayground'
import SettingsLayout, { userSettingsRail } from '~/components/SettingsLayout'
import { Alert, Badge, Button, SectionHeading } from '~/components/ui'
import { getScope, isExpired, isExpiringSoon } from '~/lib/api-keys'
import { useAppContext } from '~/lib/app-context'
import { authClient } from '~/lib/auth-client'

interface Key {
  id: string
  name: string
  start?: string
  permissions?: Record<string, string[]>
  metadata?: { scope?: string; collectionIds?: string[] }
  createdAt: string
  expiresAt?: string
}

interface Collection {
  id: string
  slug: string
}

export default function SettingsKeys() {
  const { currentUser } = useAppContext()

  const [keys, setKeys] = useState<Key[]>([])
  const [collections, setCollections] = useState<Collection[]>([])
  const [newKeyResult, setNewKeyResult] = useState<{ key: string; name: string } | null>(null)
  const [error, setError] = useState('')

  const [label, setLabel] = useState('')
  const [scope, setScope] = useState('write')
  const [expiresIn, setExpiresIn] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function loadKeys() {
    const { data } = await authClient.apiKey.list()
    if (data) setKeys((data as any).apiKeys ?? [])
  }

  useEffect(() => {
    if (!currentUser) return
    loadKeys()
    fetch(`/api/accounts/${currentUser.slug}/collections`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : []))
      .then(setCollections)
  }, [currentUser])

  async function handleCreateKey(e: FormEvent) {
    e.preventDefault()
    setError('')
    setNewKeyResult(null)
    setSubmitting(true)
    try {
      const { data, error: err } = await authClient.apiKey.create({
        name: label,
        metadata: { scope },
        expiresIn: expiresIn ? parseInt(expiresIn) * 24 * 60 * 60 : undefined,
      } as any)
      if (err) {
        setError(err.message ?? 'Failed to create key.')
      } else if (data) {
        setNewKeyResult({ key: (data as any).key, name: label })
        setLabel('')
        await loadKeys()
      }
    } finally {
      setSubmitting(false)
    }
  }

  async function handleRevokeKey(keyId: string) {
    await authClient.apiKey.delete({ keyId } as any)
    setKeys((prev) => prev.filter((k) => k.id !== keyId))
  }

  return (
    <SettingsLayout
      title="API keys"
      description="Keys for pushing and pulling data with the API or CLI."
      groups={userSettingsRail}
    >
      {newKeyResult && (
        <Alert variant="success" className="mb-4">
          <p className="mb-1 font-semibold">Key created: {newKeyResult.name}</p>
          <p className="text-ink-muted mb-2 text-xs">
            Copy this key now — it won't be shown again.
          </p>
          <code className="bg-ink text-parchment rounded-surface block p-2 font-mono text-xs break-all">
            {newKeyResult.key}
          </code>
        </Alert>
      )}

      {error && (
        <Alert variant="error" className="mb-4">
          {error}
        </Alert>
      )}

      <div className="border-rule rounded-surface mb-6 border p-4">
        <h2 className="mb-3 text-sm font-semibold">Create a new key</h2>
        <form onSubmit={handleCreateKey} className="space-y-3">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <label htmlFor="label" className="text-ink-muted mb-1 block text-xs">
                Label
              </label>
              <input
                type="text"
                id="label"
                required
                placeholder="my-sync-script"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                className="bg-parchment border-rule focus:border-ink rounded-control w-full border px-2 py-1.5 font-mono text-sm focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="scope" className="text-ink-muted mb-1 block text-xs">
                Scope
              </label>
              <select
                id="scope"
                value={scope}
                onChange={(e) => setScope(e.target.value)}
                className="bg-parchment border-rule focus:border-ink rounded-control w-full cursor-pointer border px-2 py-1.5 text-sm focus:outline-none"
              >
                <option value="read">read — list and download</option>
                <option value="write">write — push versions</option>
              </select>
            </div>
            <div>
              <label htmlFor="expiresIn" className="text-ink-muted mb-1 block text-xs">
                Expiration (optional)
              </label>
              <select
                id="expiresIn"
                value={expiresIn}
                onChange={(e) => setExpiresIn(e.target.value)}
                className="bg-parchment border-rule focus:border-ink rounded-control w-full cursor-pointer border px-2 py-1.5 text-sm focus:outline-none"
              >
                <option value="">Never expires</option>
                <option value="7">7 days</option>
                <option value="30">30 days</option>
                <option value="90">90 days</option>
                <option value="365">1 year</option>
              </select>
            </div>
          </div>
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Creating…' : 'Create key'}
          </Button>
        </form>
      </div>

      <SectionHeading>Active keys ({keys.length})</SectionHeading>

      {keys.length === 0 ? (
        <p className="text-ink-muted text-sm">No API keys yet.</p>
      ) : (
        <div className="mb-8 space-y-2">
          {keys.map((k) => (
            <div
              key={k.id}
              className={`rounded-surface flex items-center justify-between border p-3 ${
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
                  {k.start && <span className="text-ink-muted font-mono text-xs">{k.start}…</span>}
                </div>
                <div className="text-ink-muted mt-0.5 flex flex-wrap items-center gap-2 text-xs">
                  <Badge>{getScope(k.permissions)}</Badge>
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
              <Button variant="dangerLink" size="sm" onClick={() => handleRevokeKey(k.id)}>
                Revoke
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* API Playground */}
      <div className="border-rule border-t pt-8">
        <SectionHeading>API Playground</SectionHeading>
        <p className="text-ink-muted mb-4 text-xs">
          Test API calls using your session. Select an endpoint to get started.
        </p>
        <ApiPlayground
          slug={currentUser.slug}
          collections={collections.map((c) => ({ id: c.id, slug: c.slug }))}
        />
      </div>
    </SettingsLayout>
  )
}
