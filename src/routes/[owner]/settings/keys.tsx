import { type FormEvent, useEffect, useState } from 'react'
import { Link, useLoaderData, useParams } from 'react-router'

import { ApiPlayground } from '~/components/ApiPlayground'
import SettingsLayout, { orgSettingsRail } from '~/components/SettingsLayout'
import { Alert, Badge, Button, SectionHeading } from '~/components/ui'
import { getScope, isExpired, isExpiringSoon } from '~/lib/api-keys'
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

  async function handleRevokeKey(keyId: string) {
    setError('')
    await authClient.apiKey.delete({ keyId } as any)
    setKeys((prev) => prev.filter((k) => k.id !== keyId))
  }

  return (
    <SettingsLayout
      crumb={
        <nav>
          <Link to={`/${owner}`} className="text-link hover:underline">
            {owner}
          </Link>{' '}
          <span className="text-ink-muted">/</span> <span className="text-ink-muted">settings</span>
        </nav>
      }
      title="API keys"
      description="Keys for pushing and pulling this organization's collections."
      groups={orgSettingsRail(owner!)}
    >
      {error && (
        <Alert variant="error" className="mb-4">
          {error}
        </Alert>
      )}

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

      {isAdmin && (
        <form
          onSubmit={handleCreateKey}
          className="border-rule rounded-surface mb-6 space-y-3 border p-4"
        >
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
                className="bg-parchment border-rule focus:border-ink rounded-control w-full border px-2 py-1.5 font-mono text-sm focus:outline-none"
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
                className="bg-parchment border-rule focus:border-ink rounded-control w-full cursor-pointer border px-2 py-1.5 text-sm focus:outline-none"
              >
                <option value="read">read — list and download</option>
                <option value="write">write — push versions</option>
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
                className="bg-parchment border-rule focus:border-ink rounded-control w-full cursor-pointer border px-2 py-1.5 text-sm focus:outline-none"
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
      )}

      <SectionHeading>Active keys ({keys.length})</SectionHeading>

      <Alert variant="info" className="mb-4 text-xs">
        <strong className="text-ink">Rate limits:</strong> Authenticated requests get 5,000 req/min.
        Without a key, the API allows 60 req/min per IP.
        <Link to="/docs/api" className="text-link ml-1 underline">
          Learn more →
        </Link>
      </Alert>

      {keys.length === 0 ? (
        <p className="text-ink-muted text-sm">No API keys for this organization.</p>
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
                  {k.metadata?.collectionIds?.length && (
                    <Badge>
                      {k.metadata.collectionIds
                        .map((id) => collections.find((c) => c.id === id)?.slug ?? id.slice(0, 8))
                        .join(', ')}
                    </Badge>
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
                <Button variant="dangerLink" size="sm" onClick={() => handleRevokeKey(k.id)}>
                  Revoke
                </Button>
              )}
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
          slug={owner!}
          collections={collections.map((c: any) => ({ id: c.id, slug: c.slug }))}
        />
      </div>
    </SettingsLayout>
  )
}
