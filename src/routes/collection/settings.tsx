import { useState, useEffect, type FormEvent } from 'react'
import { useParams } from 'react-router'
import BaseLayout from '~/components/BaseLayout'
import { useSSRData } from '~/lib/ssr-data'
import { CollectionNav } from '.'

export default function CollectionSettingsPage() {
  const { owner, collection } = useParams()
  const currentUser = useSSRData<any>('currentUser')

  const [data, setData] = useState<any>(null)
  const [arkSettings, setArkSettings] = useState<any>({
    enabled: false,
    customUrl: null,
    arkUrl: null,
  })
  const [loading, setLoading] = useState(true)
  const [success, setSuccess] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState('')

  // Form state
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [isPublic, setIsPublic] = useState(false)

  // ARK form
  const [arkEnabled, setArkEnabled] = useState(false)
  const [arkCustomUrl, setArkCustomUrl] = useState('')

  // Delete form
  const [confirmSlug, setConfirmSlug] = useState('')

  useEffect(() => {
    if (!owner || !collection || !currentUser) return

    const isOrgMember = currentUser.orgs?.some((o: any) => o.slug === owner)
    if (currentUser.slug !== owner && !isOrgMember) {
      window.location.href = `/${owner}/${collection}`
      return
    }

    Promise.all([
      fetch(`/api/collections/${owner}/${collection}`, { credentials: 'include' }).then((r) =>
        r.ok ? r.json() : null,
      ),
      fetch(`/api/collections/${owner}/${collection}/ark`, { credentials: 'include' }).then(
        (r) => (r.ok ? r.json() : { enabled: false, customUrl: null, arkUrl: null }),
      ),
    ]).then(([col, ark]) => {
      if (!col) {
        window.location.href = '/404'
        return
      }
      setData(col)
      setName(col.name)
      setDescription(col.description ?? '')
      setIsPublic(col.public)

      setArkSettings(ark)
      setArkEnabled(ark.enabled)
      setArkCustomUrl(ark.customUrl ?? '')

      setLoading(false)
    })
  }, [owner, collection, currentUser])

  if (!currentUser) {
    window.location.href = '/login'
    return null
  }

  function clearMessages() {
    setSuccess('')
    setError('')
  }

  async function handleUpdate(e: FormEvent) {
    e.preventDefault()
    clearMessages()
    setSubmitting('update')
    try {
      const res = await fetch(`/api/collections/${owner}/${collection}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name, description, public: isPublic }),
      })
      if (res.ok) {
        setSuccess('Collection updated.')
        const refreshed = await fetch(`/api/collections/${owner}/${collection}`, {
          credentials: 'include',
        })
        if (refreshed.ok) {
          const updated = await refreshed.json()
          setData(updated)
        }
      } else {
        const body = await res.json().catch(() => ({}))
        setError(body.error ?? 'Update failed.')
      }
    } finally {
      setSubmitting('')
    }
  }

  async function handleUpdateArk(e: FormEvent) {
    e.preventDefault()
    clearMessages()
    setSubmitting('ark')
    try {
      const res = await fetch(`/api/collections/${owner}/${collection}/ark`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ enabled: arkEnabled, customUrl: arkCustomUrl.trim() || null }),
      })
      if (res.ok) {
        setSuccess('ARK settings updated.')
        const refreshed = await fetch(`/api/collections/${owner}/${collection}/ark`, {
          credentials: 'include',
        })
        if (refreshed.ok) setArkSettings(await refreshed.json())
      } else {
        const body = await res.json().catch(() => ({}))
        setError(body.error ?? 'Failed to update ARK settings.')
      }
    } finally {
      setSubmitting('')
    }
  }

  async function handleDelete(e: FormEvent) {
    e.preventDefault()
    clearMessages()
    if (confirmSlug !== collection) {
      setError('Collection name does not match. Deletion cancelled.')
      return
    }
    setSubmitting('delete')
    try {
      const res = await fetch(`/api/collections/${owner}/${collection}`, {
        method: 'DELETE',
        credentials: 'include',
      })
      if (res.ok) {
        window.location.href = '/dashboard'
      } else {
        const body = await res.json().catch(() => ({}))
        setError(body.error ?? 'Delete failed.')
      }
    } finally {
      setSubmitting('')
    }
  }

  if (loading || !data) {
    return (
      <BaseLayout>
        <div className="max-w-5xl mx-auto px-4 py-8 text-sm text-ink-muted">Loading…</div>
      </BaseLayout>
    )
  }

  const arkPath: string | null = arkSettings.arkUrl
    ? new URL(arkSettings.arkUrl).pathname
    : null

  return (
    <BaseLayout>
      <div className="max-w-5xl mx-auto px-4 py-8">
        <CollectionNav
          owner={owner!}
          collection={collection!}
          isPublic={data.public}
          isOwner={true}
          active="settings"
        />

        <div className="max-w-xl">
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

          {/* Update form */}
          <form onSubmit={handleUpdate} className="space-y-4 mb-10">
            <div>
              <label htmlFor="name" className="block text-sm font-medium mb-1">
                Name
              </label>
              <input
                type="text"
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                className="w-full bg-parchment border border-rule px-3 py-2 text-sm focus:outline-none focus:border-ink"
              />
            </div>

            <div>
              <label htmlFor="description" className="block text-sm font-medium mb-1">
                Description
              </label>
              <textarea
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                className="w-full bg-parchment border border-rule px-3 py-2 text-sm focus:outline-none focus:border-ink"
              />
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="public"
                checked={isPublic}
                onChange={(e) => setIsPublic(e.target.checked)}
                className="accent-ink"
              />
              <label htmlFor="public" className="text-sm">
                Public — visible to everyone
              </label>
            </div>

            <div className="pt-2">
              <button
                type="submit"
                disabled={submitting === 'update'}
                className="bg-ink text-parchment px-4 py-2 text-sm font-medium hover:opacity-90 transition-opacity"
              >
                Save changes
              </button>
            </div>
          </form>

          {/* Export */}
          <div className="border-t border-rule pt-6 mb-10">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted mb-3">
              Export
            </h2>
            <p className="text-sm text-ink-muted mb-3">
              Download a <code className="bg-parchment-dark px-1">.tar.gz</code> archive
              containing the manifest, schema, records, and files for the latest version.
            </p>
            <a
              href={`/api/collections/${owner}/${collection}/export`}
              className="inline-block bg-parchment border border-rule px-4 py-2 text-sm font-medium hover:bg-parchment-dark transition-colors"
            >
              Download archive
            </a>
          </div>

          {/* ARK Identifiers */}
          <div className="border-t border-rule pt-6 mb-10">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted mb-3">
              ARK Identifiers
            </h2>
            {arkPath && arkSettings.enabled && (
              <p className="text-sm text-ink-muted mb-3">
                Current ARK:{' '}
                <a
                  href={arkPath}
                  className="font-mono text-sm text-link hover:underline"
                >
                  {arkPath.slice(1)}
                </a>
              </p>
            )}
            <form onSubmit={handleUpdateArk} className="space-y-4">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="arkEnabled"
                  checked={arkEnabled}
                  onChange={(e) => setArkEnabled(e.target.checked)}
                  className="accent-ink"
                />
                <label htmlFor="arkEnabled" className="text-sm">
                  Enable ARK identifier
                </label>
              </div>
              <div>
                <label htmlFor="arkCustomUrl" className="block text-sm font-medium mb-1">
                  Custom redirect URL{' '}
                  <span className="text-ink-muted font-normal">
                    (optional — leave blank to redirect to collection page)
                  </span>
                </label>
                <input
                  type="url"
                  id="arkCustomUrl"
                  value={arkCustomUrl}
                  onChange={(e) => setArkCustomUrl(e.target.value)}
                  placeholder="https://example.org/my-collection"
                  className="w-full bg-parchment border border-rule px-3 py-2 text-sm focus:outline-none focus:border-ink"
                />
              </div>
              <div className="pt-2">
                <button
                  type="submit"
                  disabled={submitting === 'ark'}
                  className="bg-ink text-parchment px-4 py-2 text-sm font-medium hover:opacity-90 transition-opacity"
                >
                  Save ARK settings
                </button>
              </div>
            </form>
          </div>

          {/* Danger zone */}
          <div className="border border-red-200 p-4">
            <h2 className="text-sm font-semibold text-red-700 mb-2">Danger Zone</h2>
            <p className="text-sm text-ink-muted mb-3">
              Permanently delete this collection and all its versions, records, and files. This
              cannot be undone.
            </p>
            <details className="group">
              <summary className="text-sm text-red-700 cursor-pointer hover:underline">
                Delete this collection…
              </summary>
              <form onSubmit={handleDelete} className="mt-3 space-y-3">
                <div>
                  <label
                    htmlFor="confirmSlug"
                    className="block text-sm text-ink-muted mb-1"
                  >
                    Type <strong>{data.slug}</strong> to confirm:
                  </label>
                  <input
                    type="text"
                    id="confirmSlug"
                    value={confirmSlug}
                    onChange={(e) => setConfirmSlug(e.target.value)}
                    required
                    autoComplete="off"
                    className="w-full bg-parchment border border-red-200 px-3 py-2 text-sm focus:outline-none focus:border-red-400"
                  />
                </div>
                <button
                  type="submit"
                  disabled={submitting === 'delete'}
                  className="bg-red-700 text-white px-4 py-2 text-sm font-medium hover:bg-red-800 transition-colors"
                >
                  Delete collection
                </button>
              </form>
            </details>
          </div>
        </div>
      </div>
    </BaseLayout>
  )
}
