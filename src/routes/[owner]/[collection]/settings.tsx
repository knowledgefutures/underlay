import { type FormEvent, useState } from 'react'
import { Link, useLoaderData, useParams } from 'react-router'

import BaseLayout from '~/components/BaseLayout'
import WebhooksSettings from '~/components/WebhooksSettings'
import { useAppContext } from '~/lib/app-context'

import { CollectionNav } from '.'

export default function CollectionSettingsPage() {
  const { owner, collection } = useParams()
  const { currentUser } = useAppContext()
  const loaderData = useLoaderData() as { data: any; arkSettings: any; webhooks: any[] }

  const [data, setData] = useState<any>(loaderData.data)
  const [arkSettings, setArkSettings] = useState<any>(loaderData.arkSettings)
  const [success, setSuccess] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState('')

  // Form state
  const [name, setName] = useState(data.name)
  const [slugValue, setSlugValue] = useState(data.slug)
  const [isPublic, setIsPublic] = useState(data.public)

  // Metadata form
  const meta = data.latestVersion?.metadata as Record<string, unknown> | null | undefined
  const [description, setDescription] = useState((meta?.description as string) ?? '')
  const [readme, setReadme] = useState((meta?.readme as string) ?? '')
  const [license, setLicense] = useState((meta?.license as string) ?? '')
  const [tags, setTags] = useState<string[]>(
    Array.isArray(meta?.tags) ? (meta.tags as string[]) : [],
  )
  const [tagInput, setTagInput] = useState('')

  // ARK form
  const [arkEnabled, setArkEnabled] = useState(arkSettings.enabled)
  const [arkCustomUrl, setArkCustomUrl] = useState(arkSettings.customUrl ?? '')

  // Delete form
  const [confirmSlug, setConfirmSlug] = useState('')

  // Transfer form
  const [transferTarget, setTransferTarget] = useState('')

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
    const slugChanged = slugValue.trim() !== '' && slugValue.trim() !== collection
    try {
      const payload: Record<string, any> = { name, public: isPublic }
      if (slugChanged) payload.slug = slugValue.trim()

      const res = await fetch(`/api/collections/${owner}/${collection}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      })
      if (res.ok) {
        if (slugChanged) {
          const body = await res.json().catch(() => ({}))
          window.location.href = `/${owner}/${body.slug ?? slugValue.trim()}/settings`
          return
        }
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

  async function handleUpdateMetadata(e: FormEvent) {
    e.preventDefault()
    clearMessages()
    setSubmitting('metadata')
    try {
      const payload: Record<string, unknown> = {}
      if (description.trim()) payload.description = description.trim()
      else payload.description = null
      if (readme.trim()) payload.readme = readme.trim()
      else payload.readme = null
      if (license.trim()) payload.license = license.trim()
      else payload.license = null
      payload.tags = tags.length > 0 ? tags : null

      const res = await fetch(`/api/collections/${owner}/${collection}/metadata`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      })
      if (res.ok) {
        const body = await res.json()
        if (body.unchanged) {
          setSuccess('No changes to save.')
        } else {
          setSuccess(`Metadata updated (${body.semver}).`)
        }
        const refreshed = await fetch(`/api/collections/${owner}/${collection}`, {
          credentials: 'include',
        })
        if (refreshed.ok) setData(await refreshed.json())
      } else {
        const body = await res.json().catch(() => ({}))
        setError(body.error ?? 'Metadata update failed.')
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

  const arkPath: string | null = arkSettings.arkUrl ? new URL(arkSettings.arkUrl).pathname : null

  return (
    <BaseLayout>
      <div className="mx-auto max-w-5xl px-4 py-8">
        <CollectionNav
          owner={owner!}
          collection={collection!}
          isPublic={data.public}
          isOwner={true}
          active="settings"
        />

        <div className="max-w-xl">
          {success && (
            <p className="mb-4 border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
              {success}
            </p>
          )}
          {error && (
            <p className="mb-4 border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          )}

          {/* Update form */}
          <form onSubmit={handleUpdate} className="mb-10 space-y-4">
            <div>
              <label htmlFor="name" className="mb-1 block text-sm font-medium">
                Name
              </label>
              <input
                type="text"
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                className="bg-parchment border-rule focus:border-ink w-full border px-3 py-2 text-sm focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="collSlug" className="mb-1 block text-sm font-medium">
                Slug
              </label>
              <input
                type="text"
                id="collSlug"
                value={slugValue}
                onChange={(e) =>
                  setSlugValue(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))
                }
                pattern="[a-z0-9][-a-z0-9]*[a-z0-9]"
                className="bg-parchment border-rule focus:border-ink w-full border px-3 py-2 font-mono text-sm focus:outline-none"
              />
              {slugValue !== collection && (
                <p className="mt-1 text-xs text-amber-700">
                  Changing the slug will update this collection's URL.
                </p>
              )}
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
                className="bg-ink text-parchment px-4 py-2 text-sm font-medium transition-opacity hover:opacity-90"
              >
                Save changes
              </button>
            </div>
          </form>

          {/* Metadata */}
          <div className="border-rule mb-10 border-t pt-6">
            <h2 className="text-ink-muted mb-3 text-sm font-semibold tracking-wide uppercase">
              Metadata
            </h2>
            <p className="text-ink-muted mb-3 text-sm">
              Description, readme, and license are versioned — saving creates a patch version.
            </p>
            <form onSubmit={handleUpdateMetadata} className="space-y-4">
              <div>
                <label htmlFor="description" className="mb-1 block text-sm font-medium">
                  Description
                </label>
                <input
                  type="text"
                  id="description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="A short description of this collection"
                  className="bg-parchment border-rule focus:border-ink w-full border px-3 py-2 text-sm focus:outline-none"
                />
              </div>
              <div>
                <label htmlFor="readme" className="mb-1 block text-sm font-medium">
                  Readme <span className="text-ink-muted font-normal">(Markdown)</span>
                </label>
                <textarea
                  id="readme"
                  value={readme}
                  onChange={(e) => setReadme(e.target.value)}
                  rows={8}
                  placeholder="# My Collection&#10;&#10;Detailed description in Markdown..."
                  className="bg-parchment border-rule focus:border-ink w-full border px-3 py-2 font-mono text-sm focus:outline-none"
                />
              </div>
              <div>
                <label htmlFor="license" className="mb-1 block text-sm font-medium">
                  License
                </label>
                <input
                  type="text"
                  id="license"
                  value={license}
                  onChange={(e) => setLicense(e.target.value)}
                  placeholder="e.g. CC-BY-4.0, MIT, Public Domain"
                  className="bg-parchment border-rule focus:border-ink w-full border px-3 py-2 text-sm focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium">Tags</label>
                {tags.length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    {tags.map((tag) => (
                      <span
                        key={tag}
                        className="bg-parchment-dark text-ink-muted flex items-center gap-1 rounded px-2 py-0.5 text-xs"
                      >
                        {tag}
                        <button
                          type="button"
                          onClick={() => setTags(tags.filter((t) => t !== tag))}
                          className="text-ink-muted hover:text-ink cursor-pointer text-sm leading-none"
                        >
                          &times;
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        const val = tagInput.trim().toLowerCase()
                        if (val && !tags.includes(val)) {
                          setTags([...tags, val])
                        }
                        setTagInput('')
                      }
                    }}
                    placeholder="Add a tag and press Enter"
                    className="bg-parchment border-rule focus:border-ink min-w-0 flex-1 border px-3 py-2 text-sm focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const val = tagInput.trim().toLowerCase()
                      if (val && !tags.includes(val)) {
                        setTags([...tags, val])
                      }
                      setTagInput('')
                    }}
                    className="border-rule bg-parchment hover:bg-parchment-dark border px-3 py-2 text-sm transition-colors"
                  >
                    Add
                  </button>
                </div>
              </div>
              <div className="pt-2">
                <button
                  type="submit"
                  disabled={submitting === 'metadata'}
                  className="bg-ink text-parchment px-4 py-2 text-sm font-medium transition-opacity hover:opacity-90"
                >
                  Save metadata
                </button>
              </div>
            </form>
          </div>

          {/* Export */}
          <div className="border-rule mb-10 border-t pt-6">
            <h2 className="text-ink-muted mb-3 text-sm font-semibold tracking-wide uppercase">
              Export
            </h2>
            <p className="text-ink-muted mb-3 text-sm">
              Download a <code className="bg-parchment-dark px-1">.tar.gz</code> archive containing
              the manifest, schema, records, and files for the latest version.
            </p>
            <Link
              to={`/api/collections/${owner}/${collection}/export`}
              className="bg-parchment border-rule hover:bg-parchment-dark inline-block border px-4 py-2 text-sm font-medium transition-colors"
            >
              Download archive
            </Link>
          </div>

          {/* ARK Identifiers */}
          <div className="border-rule mb-10 border-t pt-6">
            <h2 className="text-ink-muted mb-3 text-sm font-semibold tracking-wide uppercase">
              ARK Identifiers
            </h2>
            {arkPath && arkSettings.enabled && (
              <p className="text-ink-muted mb-3 text-sm">
                Current ARK:{' '}
                <Link to={arkPath} className="text-link font-mono text-sm hover:underline">
                  {arkPath.slice(1)}
                </Link>
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
                <label htmlFor="arkCustomUrl" className="mb-1 block text-sm font-medium">
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
                  className="bg-parchment border-rule focus:border-ink w-full border px-3 py-2 text-sm focus:outline-none"
                />
              </div>
              <div className="pt-2">
                <button
                  type="submit"
                  disabled={submitting === 'ark'}
                  className="bg-ink text-parchment px-4 py-2 text-sm font-medium transition-opacity hover:opacity-90"
                >
                  Save ARK settings
                </button>
              </div>
            </form>
          </div>

          {/* Webhooks */}
          <WebhooksSettings
            owner={owner!}
            collection={collection!}
            initialWebhooks={loaderData.webhooks ?? []}
          />

          {/* Transfer */}
          <div className="border-rule mb-10 border-t pt-6">
            <h2 className="text-ink-muted mb-3 text-sm font-semibold tracking-wide uppercase">
              Transfer Collection
            </h2>
            <p className="text-ink-muted mb-3 text-sm">
              Move this collection to another account you have access to.
            </p>
            <form
              onSubmit={async (e: FormEvent) => {
                e.preventDefault()
                clearMessages()
                if (!transferTarget) return
                setSubmitting('transfer')
                try {
                  const res = await fetch(`/api/collections/${owner}/${collection}/transfer`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ targetOrgSlug: transferTarget }),
                  })
                  if (res.ok) {
                    window.location.href = `/${transferTarget}/${data?.slug ?? collection}/settings`
                  } else {
                    const body = await res.json().catch(() => ({}))
                    setError(body.error ?? 'Transfer failed.')
                  }
                } finally {
                  setSubmitting('')
                }
              }}
              className="space-y-3"
            >
              <div>
                <label htmlFor="transferTarget" className="mb-1 block text-xs font-medium">
                  Target organization
                </label>
                <select
                  id="transferTarget"
                  value={transferTarget}
                  onChange={(e) => setTransferTarget(e.target.value)}
                  className="bg-parchment border-rule focus:border-ink w-full border px-3 py-2 text-sm focus:outline-none"
                >
                  <option value="">— Select —</option>
                  {currentUser?.orgs
                    ?.filter(
                      (o: any) => o.slug !== owner && (o.role === 'owner' || o.role === 'admin'),
                    )
                    .map((o: any) => (
                      <option key={o.slug} value={o.slug}>
                        {o.displayName ?? o.slug}
                      </option>
                    ))}
                </select>
              </div>
              <button
                type="submit"
                disabled={!transferTarget || submitting === 'transfer'}
                className="bg-ink text-parchment px-4 py-2 text-sm font-medium transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                Transfer
              </button>
            </form>
          </div>

          {/* Danger zone */}
          <div className="border border-red-200 p-4">
            <h2 className="mb-2 text-sm font-semibold text-red-700">Danger Zone</h2>
            <p className="text-ink-muted mb-3 text-sm">
              Permanently delete this collection and all its versions, records, and files. This
              cannot be undone.
            </p>
            <details className="group">
              <summary className="cursor-pointer text-sm text-red-700 hover:underline">
                Delete this collection…
              </summary>
              <form onSubmit={handleDelete} className="mt-3 space-y-3">
                <div>
                  <label htmlFor="confirmSlug" className="text-ink-muted mb-1 block text-sm">
                    Type <strong>{data.slug}</strong> to confirm:
                  </label>
                  <input
                    type="text"
                    id="confirmSlug"
                    value={confirmSlug}
                    onChange={(e) => setConfirmSlug(e.target.value)}
                    required
                    autoComplete="off"
                    className="bg-parchment w-full border border-red-200 px-3 py-2 text-sm focus:border-red-400 focus:outline-none"
                  />
                </div>
                <button
                  type="submit"
                  disabled={submitting === 'delete'}
                  className="bg-red-700 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-800"
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
