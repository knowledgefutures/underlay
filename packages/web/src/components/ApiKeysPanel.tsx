import { type FormEvent, useEffect, useState } from 'react'
import { Link } from 'react-router'

import { ApiPlayground } from '~/components/ApiPlayground'
import { Alert, Badge, Button, Field, Input, SectionHeading, Select } from '~/components/ui'
import { getScope, isExpired, isExpiringSoon } from '~/lib/api-keys'
import { authClient } from '~/lib/auth-client'
import { formatDate } from '~/lib/format'

interface Key {
  id: string
  name: string
  start?: string
  permissions?: Record<string, string[]>
  metadata?: { collectionIds?: string[] }
  createdAt: string
  expiresAt?: string
}

interface Collection {
  id: string
  slug: string
}

const SCOPE_HINTS: Record<string, string> = {
  read: 'Lists and downloads collections, private records included.',
  write: 'Also pushes new versions.',
  admin: 'Also changes settings, visibility, mirrors and webhooks, and deletes collections.',
}

/**
 * The signed-in user's API keys, a form for a new one (optionally scoped to one
 * of `collections`), and the API playground: the user and org key settings pages.
 * Keys belong to the user. On an org's page (`org`), the list shows the keys
 * scoped to that org's collections, then the user's keys for every collection.
 */
export default function ApiKeysPanel({
  owner,
  collections,
  canManage = true,
  org = false,
}: {
  /** The account the playground calls and whose collections a key can be scoped to. */
  owner: string
  collections: Collection[]
  /** Create and revoke (org owners and admins on an org's page). */
  canManage?: boolean
  /** An org's settings page rather than the user's own. */
  org?: boolean
}) {
  const [keys, setKeys] = useState<Key[]>([])
  const [error, setError] = useState('')
  const [newKeyResult, setNewKeyResult] = useState<{ key: string; name: string } | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [copied, setCopied] = useState(false)

  const [keyLabel, setKeyLabel] = useState('')
  const [keyScope, setKeyScope] = useState('write')
  const [keyCollectionId, setKeyCollectionId] = useState('')
  const [keyExpiresIn, setKeyExpiresIn] = useState('')

  async function loadKeys() {
    const { data } = await authClient.apiKey.list()
    if (!data) return
    const list: Key[] = (data as any).apiKeys ?? (Array.isArray(data) ? data : [])
    setKeys([...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
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

  const ids = new Set(collections.map((c) => c.id))
  const orgKeys = keys.filter((k) => k.metadata?.collectionIds?.some((id) => ids.has(id)))
  const allKeys = keys.filter((k) => !k.metadata?.collectionIds?.length)

  const keyList = (keys: Key[], empty: string) =>
    keys.length === 0 ? (
      <p className="text-ink-muted mb-8 text-sm">{empty}</p>
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
                <span>Created {formatDate(k.createdAt)}</span>
                {k.expiresAt && !isExpired(k.expiresAt) && (
                  <span
                    className={isExpiringSoon(k.expiresAt) ? 'font-medium text-yellow-700' : ''}
                  >
                    · Expires {formatDate(k.expiresAt)}
                  </span>
                )}
                {isExpired(k.expiresAt ?? null) && (
                  <span className="font-medium text-red-700">· Expired</span>
                )}
              </div>
            </div>
            {canManage && (
              <Button variant="dangerLink" size="sm" onClick={() => handleRevokeKey(k.id)}>
                Revoke
              </Button>
            )}
          </div>
        ))}
      </div>
    )

  return (
    <>
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
          <div className="flex items-start gap-2">
            <code className="bg-ink text-parchment rounded-surface block min-w-0 flex-1 p-2 font-mono text-xs break-all">
              {newKeyResult.key}
            </code>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                navigator.clipboard.writeText(newKeyResult.key)
                setCopied(true)
                setTimeout(() => setCopied(false), 2000)
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </Alert>
      )}

      {canManage && (
        <form
          onSubmit={handleCreateKey}
          className="border-rule rounded-surface mb-6 space-y-3 border p-4"
        >
          <h2 className="mb-1 text-sm font-semibold">Create a new key</h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="Label" htmlFor="keyLabel">
              <Input
                id="keyLabel"
                value={keyLabel}
                onChange={(e) => setKeyLabel(e.target.value)}
                required
                placeholder="ci-deploy"
              />
            </Field>
            <Field label="Scope" htmlFor="keyScope" hint={SCOPE_HINTS[keyScope]}>
              <Select id="keyScope" value={keyScope} onChange={(e) => setKeyScope(e.target.value)}>
                <option value="read">read</option>
                <option value="write">write</option>
                <option value="admin">admin</option>
              </Select>
            </Field>
            <Field label="Collection" htmlFor="keyCollection" hint="Optional.">
              <Select
                id="keyCollection"
                value={keyCollectionId}
                onChange={(e) => setKeyCollectionId(e.target.value)}
              >
                <option value="">
                  {org ? 'All collections, in every organization' : 'All collections'}
                </option>
                {collections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.slug}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Expiration" htmlFor="keyExpiry">
              <Select
                id="keyExpiry"
                value={keyExpiresIn}
                onChange={(e) => setKeyExpiresIn(e.target.value)}
              >
                <option value="">Never expires</option>
                <option value="7">7 days</option>
                <option value="30">30 days</option>
                <option value="90">90 days</option>
                <option value="365">1 year</option>
              </Select>
            </Field>
          </div>
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Creating…' : 'Create key'}
          </Button>
        </form>
      )}

      <Alert variant="info" className="mb-4 text-xs">
        <strong className="text-ink">Rate limits:</strong> Authenticated requests get 5,000 req/min.
        Without a key, the API allows 60 req/min per IP.
        <Link to="/docs/api" className="text-link ml-1 underline">
          Learn more →
        </Link>
      </Alert>

      {org ? (
        <>
          <SectionHeading>Keys for this organization ({orgKeys.length})</SectionHeading>
          {keyList(orgKeys, "No keys scoped to this organization's collections.")}
          <SectionHeading>Your keys for all your organizations ({allKeys.length})</SectionHeading>
          <p className="text-ink-muted mb-3 text-xs">
            These work on every collection you can reach, here and in your other organizations.
            Manage them in{' '}
            <Link to="/settings/keys" className="text-link underline">
              account settings
            </Link>
            .
          </p>
          {keyList(allKeys, 'No keys for all collections.')}
        </>
      ) : (
        <>
          <SectionHeading>Active keys ({keys.length})</SectionHeading>
          {keyList(keys, 'No API keys yet.')}
        </>
      )}

      {/* API Playground */}
      <div className="border-rule border-t pt-8">
        <SectionHeading>API Playground</SectionHeading>
        <p className="text-ink-muted mb-4 text-xs">
          Test API calls using your session. Select an endpoint to get started.
        </p>
        <ApiPlayground
          slug={owner}
          collections={collections.map((c: any) => ({ id: c.id, slug: c.slug }))}
        />
      </div>
    </>
  )
}
