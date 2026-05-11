import { useState, useEffect, type FormEvent } from 'react'
import { useParams, Link } from 'react-router'
import BaseLayout from '~/components/BaseLayout'
import { useSSRData } from '~/lib/ssr-data'

export default function OwnerSettings() {
  const { owner } = useParams()
  const currentUser = useSSRData<any>('currentUser')

  const [orgData, setOrgData] = useState<any>(null)
  const [isOwner, setIsOwner] = useState(false)
  const [isAdmin, setIsAdmin] = useState(false)
  const [loading, setLoading] = useState(true)
  const [success, setSuccess] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState('')

  // Profile form
  const [displayName, setDisplayName] = useState('')
  const [bio, setBio] = useState('')
  const [website, setWebsite] = useState('')
  const [location, setLocation] = useState('')

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
          window.location.href = '/404'
          return
        }
        setOrgData(data)
        setDisplayName(data.displayName ?? '')
        setBio(data.bio ?? '')
        setWebsite(data.website ?? '')
        setLocation(data.location ?? '')
        setArkNaan(data.arkNaan ?? '')
        setLoading(false)
      })
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
    try {
      const res = await fetch(`/api/accounts/${owner}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ displayName, bio, website, location }),
      })
      if (res.ok) {
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
          <p className="text-sm text-green-800 bg-green-50 border border-green-200 px-3 py-2 mb-4">
            {success}
          </p>
        )}
        {error && (
          <p className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 mb-4">
            {error}
          </p>
        )}

        {isOwner ? (
          <form onSubmit={handleUpdateProfile} className="space-y-4 mb-10">
            <div className="flex items-center gap-4 mb-4">
              {orgData.avatarUrl ? (
                <img
                  src={orgData.avatarUrl}
                  alt="Avatar"
                  className="w-16 h-16 rounded-full object-cover border border-rule"
                />
              ) : (
                <div className="w-16 h-16 rounded-full bg-parchment-dark border border-rule flex items-center justify-center text-ink-muted text-lg font-semibold">
                  {orgData.displayName?.charAt(0)?.toUpperCase() ?? '?'}
                </div>
              )}
              <div>
                <p className="text-sm font-medium">{orgData.displayName}</p>
                <p className="text-xs text-ink-muted font-mono">@{owner}</p>
              </div>
            </div>

            <div>
              <label htmlFor="displayName" className="block text-sm font-medium mb-1">
                Display Name
              </label>
              <input
                type="text"
                id="displayName"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                required
                className="w-full bg-parchment border border-rule px-3 py-2 text-sm focus:outline-none focus:border-ink"
              />
            </div>
            <div>
              <label htmlFor="bio" className="block text-sm font-medium mb-1">
                Description
              </label>
              <textarea
                id="bio"
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                rows={3}
                placeholder="What does this organization do?"
                className="w-full bg-parchment border border-rule px-3 py-2 text-sm focus:outline-none focus:border-ink resize-none"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="website" className="block text-sm font-medium mb-1">
                  Website
                </label>
                <input
                  type="url"
                  id="website"
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                  placeholder="https://..."
                  className="w-full bg-parchment border border-rule px-3 py-2 text-sm focus:outline-none focus:border-ink"
                />
              </div>
              <div>
                <label htmlFor="location" className="block text-sm font-medium mb-1">
                  Location
                </label>
                <input
                  type="text"
                  id="location"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="City, Country"
                  className="w-full bg-parchment border border-rule px-3 py-2 text-sm focus:outline-none focus:border-ink"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Slug</label>
              <p className="text-sm text-ink-muted font-mono">{owner}</p>
              <p className="text-xs text-ink-muted mt-1">Slugs cannot be changed.</p>
            </div>
            <button
              type="submit"
              disabled={submitting === 'profile'}
              className="bg-ink text-parchment px-4 py-2 text-sm font-medium hover:opacity-90 transition-opacity"
            >
              Save
            </button>
          </form>
        ) : (
          <div className="text-sm text-ink-muted">
            <p>Only organization owners can update the profile.</p>
          </div>
        )}

        {/* ARK Identifiers */}
        {isAdmin && (
          <div id="ark" className="border-t border-rule pt-6 mb-10">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted mb-4">
              ARK Identifiers
            </h2>

            {orgData.arkShoulder && (
              <div className="mb-4">
                <p className="text-xs text-ink-muted mb-1">Assigned shoulder</p>
                <code className="text-xs font-mono bg-parchment-dark border border-rule px-2 py-1">
                  {orgData.arkShoulder}
                </code>
              </div>
            )}

            <form onSubmit={handleUpdateArk} className="space-y-3">
              <div>
                <label htmlFor="arkNaan" className="block text-xs font-medium mb-1">
                  Name Assigning Authority Number (NAAN)
                </label>
                <input
                  type="text"
                  id="arkNaan"
                  value={arkNaan}
                  onChange={(e) => setArkNaan(e.target.value)}
                  placeholder="Leave blank to use default (12345)"
                  pattern="[0-9]{1,16}"
                  className="w-full bg-parchment border border-rule px-3 py-2 text-sm font-mono focus:outline-none focus:border-ink"
                />
                <p className="text-xs text-ink-muted mt-1">
                  If set, overrides the default NAAN for all ARKs created by this organization.
                </p>
              </div>
              <button
                type="submit"
                disabled={submitting === 'ark'}
                className="bg-ink text-parchment px-4 py-2 text-sm font-medium hover:opacity-90 transition-opacity"
              >
                Save
              </button>
            </form>
          </div>
        )}

        {/* Danger zone */}
        {isOwner && (
          <div className="border border-red-200 p-4 mt-10">
            <h2 className="text-sm font-semibold text-red-700 mb-2">Danger Zone</h2>
            <p className="text-sm text-ink-muted mb-3">
              Permanently delete this organization, all its collections, versions, records, and
              files. This cannot be undone.
            </p>
            <details className="group">
              <summary className="text-sm text-red-700 cursor-pointer hover:underline">
                Delete this organization…
              </summary>
              <form onSubmit={handleDeleteOrg} className="mt-3 space-y-3">
                <div>
                  <label htmlFor="confirmSlug" className="block text-sm text-ink-muted mb-1">
                    Type <strong>{owner}</strong> to confirm:
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
