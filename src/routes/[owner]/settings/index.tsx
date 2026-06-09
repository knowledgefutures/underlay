import { type FormEvent, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'

import BaseLayout from '~/components/BaseLayout'
import { NotFoundError } from '~/components/NotFound'
import { useAppContext } from '~/lib/app-context'

export default function OwnerSettings() {
  const { owner } = useParams()
  const { currentUser } = useAppContext()

  const [orgData, setOrgData] = useState<any>(null)
  const [isOwner, setIsOwner] = useState(false)
  const [isAdmin, setIsAdmin] = useState(false)
  const [loading, setLoading] = useState(true)
  const [success, setSuccess] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState('')

  // Profile form
  const [displayName, setDisplayName] = useState('')
  const [slugValue, setSlugValue] = useState('')
  const [bio, setBio] = useState('')
  const [website, setWebsite] = useState('')
  const [location, setLocation] = useState('')

  // KF org link
  const [kfOrgId, setKfOrgId] = useState('')
  const [kfOrgs, setKfOrgs] = useState<{ id: string; name: string }[]>([])
  const [kfOrgsLoading, setKfOrgsLoading] = useState(false)

  // ARK form
  const [arkNaan, setArkNaan] = useState('')

  // Delete form
  const [confirmSlug, setConfirmSlug] = useState('')

  useEffect(() => {
    if (!owner || !currentUser) return

    const org = currentUser.orgs?.find((o: any) => o.slug === owner)
    if (!org) {
      window.location.href = `/${owner}`
      return
    }

    const ownerRole = org.role === 'owner'
    const adminRole = org.role === 'admin' || ownerRole
    setIsOwner(ownerRole)
    setIsAdmin(adminRole)

    fetch(`/api/accounts/${owner}`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) {
          setLoading(false)
          return
        }
        setOrgData(data)
        setDisplayName(data.displayName ?? '')
        setSlugValue(data.slug ?? owner)
        setBio(data.bio ?? '')
        setWebsite(data.website ?? '')
        setLocation(data.location ?? '')
        setKfOrgId(data.kfOrgId ?? '')
        setArkNaan(data.arkNaan ?? '')
        setLoading(false)
      })

    // Fetch available KF orgs for the transfer UI
    setKfOrgsLoading(true)
    fetch('/api/accounts/available-kf-orgs', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : []))
      .then((orgs) => {
        setKfOrgs(Array.isArray(orgs) ? orgs : [])
        setKfOrgsLoading(false)
      })
      .catch(() => setKfOrgsLoading(false))
  }, [owner, currentUser])

  if (!currentUser) {
    window.location.href = '/login'
    return null
  }

  function clearMessages() {
    setSuccess('')
    setError('')
  }

  async function handleUpdateProfile(e: FormEvent) {
    e.preventDefault()
    clearMessages()
    setSubmitting('profile')
    const slugChanged = slugValue.trim() !== '' && slugValue.trim() !== owner
    try {
      const payload: Record<string, any> = { displayName, bio, website, location }
      if (slugChanged) payload.slug = slugValue.trim()

      const res = await fetch(`/api/accounts/${owner}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      })
      if (res.ok) {
        if (slugChanged) {
          const body = await res.json().catch(() => ({}))
          window.location.href = `/${body.slug ?? slugValue.trim()}/settings`
          return
        }
        setSuccess('Organization updated.')
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
      const res = await fetch(`/api/accounts/${owner}/ark`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ naan: arkNaan.trim() || null }),
      })
      if (res.ok) {
        setSuccess('ARK settings updated.')
      } else {
        const body = await res.json().catch(() => ({}))
        setError(body.error ?? 'Failed to update ARK settings.')
      }
    } finally {
      setSubmitting('')
    }
  }

  async function handleDeleteOrg(e: FormEvent) {
    e.preventDefault()
    clearMessages()
    if (confirmSlug !== owner) {
      setError('Organization name does not match. Deletion cancelled.')
      return
    }
    setSubmitting('delete')
    try {
      const res = await fetch(`/api/accounts/${owner}`, {
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

  if (loading) {
    return (
      <BaseLayout>
        <div className="text-ink-muted mx-auto max-w-4xl px-4 py-10 text-sm">Loading…</div>
      </BaseLayout>
    )
  }
  if (!orgData) throw new NotFoundError()

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
          <Link to={`/${owner}/settings`} className="text-ink font-medium">
            Profile
          </Link>
          <Link to={`/${owner}/settings/members`} className="text-ink-muted hover:text-ink">
            Members
          </Link>
          <Link to={`/${owner}/settings/keys`} className="text-ink-muted hover:text-ink">
            API Keys
          </Link>
          <Link to={`/${owner}/settings#ark`} className="text-ink-muted hover:text-ink">
            ARK
          </Link>
        </nav>

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

        {isOwner ? (
          <form onSubmit={handleUpdateProfile} className="mb-10 space-y-4">
            <div className="mb-4 flex items-center gap-4">
              {orgData.avatarUrl ? (
                <img
                  src={orgData.avatarUrl}
                  alt="Avatar"
                  className="border-rule h-16 w-16 rounded-full border object-cover"
                />
              ) : (
                <div className="bg-parchment-dark border-rule text-ink-muted flex h-16 w-16 items-center justify-center rounded-full border text-lg font-semibold">
                  {orgData.displayName?.charAt(0)?.toUpperCase() ?? '?'}
                </div>
              )}
              <div>
                <p className="text-sm font-medium">{orgData.displayName}</p>
                <p className="text-ink-muted font-mono text-xs">@{owner}</p>
              </div>
            </div>

            <div>
              <label htmlFor="displayName" className="mb-1 block text-sm font-medium">
                Display Name
              </label>
              <input
                type="text"
                id="displayName"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                required
                className="bg-parchment border-rule focus:border-ink w-full border px-3 py-2 text-sm focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="bio" className="mb-1 block text-sm font-medium">
                Description
              </label>
              <textarea
                id="bio"
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                rows={3}
                placeholder="What does this organization do?"
                className="bg-parchment border-rule focus:border-ink w-full resize-none border px-3 py-2 text-sm focus:outline-none"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="website" className="mb-1 block text-sm font-medium">
                  Website
                </label>
                <input
                  type="url"
                  id="website"
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                  placeholder="https://..."
                  className="bg-parchment border-rule focus:border-ink w-full border px-3 py-2 text-sm focus:outline-none"
                />
              </div>
              <div>
                <label htmlFor="location" className="mb-1 block text-sm font-medium">
                  Location
                </label>
                <input
                  type="text"
                  id="location"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="City, Country"
                  className="bg-parchment border-rule focus:border-ink w-full border px-3 py-2 text-sm focus:outline-none"
                />
              </div>
            </div>
            <div>
              <label htmlFor="slug" className="mb-1 block text-sm font-medium">
                Slug
              </label>
              <input
                type="text"
                id="slug"
                value={slugValue}
                onChange={(e) =>
                  setSlugValue(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))
                }
                pattern="[a-z0-9][-a-z0-9]*[a-z0-9]"
                className="bg-parchment border-rule focus:border-ink w-full border px-3 py-2 font-mono text-sm focus:outline-none"
              />
              {slugValue !== owner && (
                <p className="mt-1 text-xs text-amber-700">
                  Changing the slug will update all URLs for this account.
                </p>
              )}
            </div>
            <button
              type="submit"
              disabled={submitting === 'profile'}
              className="bg-ink text-parchment px-4 py-2 text-sm font-medium transition-opacity hover:opacity-90"
            >
              Save
            </button>
          </form>
        ) : (
          <div className="text-ink-muted text-sm">
            <p>Only organization owners can update the profile.</p>
          </div>
        )}

        {/* ARK Identifiers */}
        {isAdmin && (
          <div id="ark" className="border-rule mb-10 border-t pt-6">
            <h2 className="text-ink-muted mb-4 text-sm font-semibold tracking-wide uppercase">
              ARK Identifiers
            </h2>

            {orgData.arkShoulder && (
              <div className="mb-4">
                <p className="text-ink-muted mb-1 text-xs">Assigned shoulder</p>
                <code className="bg-parchment-dark border-rule border px-2 py-1 font-mono text-xs">
                  {orgData.arkShoulder}
                </code>
              </div>
            )}

            <form onSubmit={handleUpdateArk} className="space-y-3">
              <div>
                <label htmlFor="arkNaan" className="mb-1 block text-xs font-medium">
                  Name Assigning Authority Number (NAAN)
                </label>
                <input
                  type="text"
                  id="arkNaan"
                  value={arkNaan}
                  onChange={(e) => setArkNaan(e.target.value)}
                  placeholder="Leave blank to use default (12345)"
                  pattern="[0-9]{1,16}"
                  className="bg-parchment border-rule focus:border-ink w-full border px-3 py-2 font-mono text-sm focus:outline-none"
                />
                <p className="text-ink-muted mt-1 text-xs">
                  If set, overrides the default NAAN for all ARKs created by this organization.
                </p>
              </div>
              <button
                type="submit"
                disabled={submitting === 'ark'}
                className="bg-ink text-parchment px-4 py-2 text-sm font-medium transition-opacity hover:opacity-90"
              >
                Save
              </button>
            </form>
          </div>
        )}

        {/* Transfer Organization */}
        {isOwner && (
          <div className="border-rule mb-10 border-t pt-6">
            <h2 className="text-ink-muted mb-4 text-sm font-semibold tracking-wide uppercase">
              Transfer Organization
            </h2>
            <p className="text-ink-muted mb-3 text-sm">
              Transfer this Underlay organization to a different KF Account you belong to. This
              changes which KF Account is responsible for billing and ownership, but does not affect
              permissions or membership on the Underlay side.
            </p>
            {kfOrgsLoading ? (
              <p className="text-ink-muted text-sm">Loading KF Accounts…</p>
            ) : (
              <form
                onSubmit={async (e: FormEvent) => {
                  e.preventDefault()
                  clearMessages()
                  setSubmitting('kforg')
                  try {
                    const res = await fetch(`/api/accounts/${owner}`, {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      credentials: 'include',
                      body: JSON.stringify({ kfOrgId }),
                    })
                    if (res.ok) {
                      setSuccess('Ownership transferred.')
                    } else {
                      const body = await res.json().catch(() => ({}))
                      setError(body.error ?? 'Failed to transfer ownership.')
                    }
                  } finally {
                    setSubmitting('')
                  }
                }}
                className="space-y-3"
              >
                <div>
                  <label htmlFor="kfOrgId" className="mb-1 block text-xs font-medium">
                    KF Account
                  </label>
                  <select
                    id="kfOrgId"
                    value={kfOrgId}
                    onChange={(e) => setKfOrgId(e.target.value)}
                    className="bg-parchment border-rule focus:border-ink w-full border px-3 py-2 text-sm focus:outline-none"
                  >
                    <option value="">— None —</option>
                    {kfOrgs.map((org) => (
                      <option key={org.id} value={org.id}>
                        {org.name}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  type="submit"
                  disabled={submitting === 'kforg'}
                  className="bg-ink text-parchment px-4 py-2 text-sm font-medium transition-opacity hover:opacity-90"
                >
                  Save
                </button>
              </form>
            )}
          </div>
        )}

        {/* Danger zone */}
        {isOwner && (
          <div className="mt-10 border border-red-200 p-4">
            <h2 className="mb-2 text-sm font-semibold text-red-700">Danger Zone</h2>
            <p className="text-ink-muted mb-3 text-sm">
              Permanently delete this organization, all its collections, versions, records, and
              files. This cannot be undone.
            </p>
            <details className="group">
              <summary className="cursor-pointer text-sm text-red-700 hover:underline">
                Delete this organization…
              </summary>
              <form onSubmit={handleDeleteOrg} className="mt-3 space-y-3">
                <div>
                  <label htmlFor="confirmSlug" className="text-ink-muted mb-1 block text-sm">
                    Type <strong>{owner}</strong> to confirm:
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
                  Delete organization
                </button>
              </form>
            </details>
          </div>
        )}
      </div>
    </BaseLayout>
  )
}
