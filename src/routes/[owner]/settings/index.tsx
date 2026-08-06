import { type FormEvent, useState } from 'react'
import { Link, useLoaderData, useParams } from 'react-router'

import SettingsLayout, { orgSettingsRail } from '~/components/SettingsLayout'
import { Alert, Button, Input, SectionHeading, Select, Textarea } from '~/components/ui'
import { useAppContext } from '~/lib/app-context'

export default function OwnerSettings() {
  const { owner } = useParams()
  const { currentUser } = useAppContext()
  const { orgData: initialOrgData, kfOrgs } = useLoaderData() as {
    orgData: any
    kfOrgs: { id: string; name: string }[]
  }

  const org = currentUser?.orgs?.find((o: any) => o.slug === owner)
  const isOwner = org?.role === 'owner'
  const isAdmin = org?.role === 'admin' || isOwner

  const [success, setSuccess] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState('')

  // Profile form
  const [displayName, setDisplayName] = useState(initialOrgData.displayName ?? '')
  const [slugValue, setSlugValue] = useState(initialOrgData.slug ?? owner)
  const [bio, setBio] = useState(initialOrgData.bio ?? '')
  const [website, setWebsite] = useState(initialOrgData.website ?? '')
  const [location, setLocation] = useState(initialOrgData.location ?? '')

  // KF org link
  const [kfOrgId, setKfOrgId] = useState(initialOrgData.kfOrgId ?? '')

  // ARK form
  const [arkNaan, setArkNaan] = useState(initialOrgData.arkNaan ?? '')

  // Delete form
  const [confirmSlug, setConfirmSlug] = useState('')

  if (currentUser && !org) {
    window.location.href = `/${owner}`
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
      title="Profile"
      description="Public identity for this organization."
      groups={orgSettingsRail(owner!)}
    >
      {success && (
        <Alert variant="success" className="mb-4">
          {success}
        </Alert>
      )}
      {error && (
        <Alert variant="error" className="mb-4">
          {error}
        </Alert>
      )}

      {isOwner ? (
        <form onSubmit={handleUpdateProfile} className="mb-10 space-y-4">
          <div className="mb-4 flex items-center gap-4">
            {initialOrgData.avatarUrl ? (
              <img
                src={initialOrgData.avatarUrl}
                alt="Avatar"
                className="border-rule h-16 w-16 rounded-full border object-cover"
              />
            ) : (
              <div className="bg-parchment-dark border-rule text-ink-muted flex h-16 w-16 items-center justify-center rounded-full border text-lg font-semibold">
                {initialOrgData.displayName?.charAt(0)?.toUpperCase() ?? '?'}
              </div>
            )}
            <div>
              <p className="text-sm font-medium">{initialOrgData.displayName}</p>
              <p className="text-ink-muted font-mono text-xs">@{owner}</p>
            </div>
          </div>

          <div>
            <label htmlFor="displayName" className="mb-1 block text-sm font-medium">
              Display name
            </label>
            <Input
              type="text"
              id="displayName"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              required
            />
          </div>
          <div>
            <label htmlFor="bio" className="mb-1 block text-sm font-medium">
              Description
            </label>
            <Textarea
              id="bio"
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              rows={3}
              placeholder="What does this organization do?"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="website" className="mb-1 block text-sm font-medium">
                Website
              </label>
              <Input
                type="url"
                id="website"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                placeholder="https://..."
              />
            </div>
            <div>
              <label htmlFor="location" className="mb-1 block text-sm font-medium">
                Location
              </label>
              <Input
                type="text"
                id="location"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="City, Country"
              />
            </div>
          </div>
          <div>
            <label htmlFor="slug" className="mb-1 block text-sm font-medium">
              Slug
            </label>
            <Input
              type="text"
              id="slug"
              value={slugValue}
              onChange={(e) =>
                setSlugValue(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))
              }
              pattern="[a-z0-9][-a-z0-9]*[a-z0-9]"
              className="font-mono"
            />
            {slugValue !== owner && (
              <p className="mt-1 text-xs text-amber-700">
                Changing the slug will update all URLs for this account.
              </p>
            )}
          </div>
          <Button type="submit" disabled={submitting === 'profile'}>
            {submitting === 'profile' ? 'Saving…' : 'Save changes'}
          </Button>
        </form>
      ) : (
        <div className="text-ink-muted text-sm">
          <p>Only organization owners can update the profile.</p>
        </div>
      )}

      {/* ARK Identifiers */}
      {isAdmin && (
        <div id="ark" className="border-rule mb-10 border-t pt-6">
          <SectionHeading>ARK Identifiers</SectionHeading>

          {initialOrgData.arkShoulder && (
            <div className="mb-4">
              <p className="text-ink-muted mb-1 text-xs">Assigned shoulder</p>
              <code className="bg-parchment-dark border-rule rounded-surface border px-2 py-1 font-mono text-xs">
                {initialOrgData.arkShoulder}
              </code>
            </div>
          )}

          <form onSubmit={handleUpdateArk} className="space-y-3">
            <div>
              <label htmlFor="arkNaan" className="mb-1 block text-xs font-medium">
                Name Assigning Authority Number (NAAN)
              </label>
              <Input
                type="text"
                id="arkNaan"
                value={arkNaan}
                onChange={(e) => setArkNaan(e.target.value)}
                placeholder="Leave blank to use default (12345)"
                pattern="[0-9]{1,16}"
                className="font-mono"
              />
              <p className="text-ink-muted mt-1 text-xs">
                If set, overrides the default NAAN for all ARKs created by this organization.
              </p>
            </div>
            <Button type="submit" disabled={submitting === 'ark'}>
              {submitting === 'ark' ? 'Saving…' : 'Save changes'}
            </Button>
          </form>
        </div>
      )}

      {/* Transfer Organization */}
      {isOwner && (
        <div className="border-rule mb-10 border-t pt-6">
          <SectionHeading>Transfer Organization</SectionHeading>
          <p className="text-ink-muted mb-3 text-sm">
            Transfer this Underlay organization to a different KF Account you belong to. This
            changes which KF Account is responsible for billing and ownership, but does not affect
            permissions or membership on the Underlay side.
          </p>
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
              <Select id="kfOrgId" value={kfOrgId} onChange={(e) => setKfOrgId(e.target.value)}>
                <option value="">— None —</option>
                {kfOrgs.map((kfOrg) => (
                  <option key={kfOrg.id} value={kfOrg.id}>
                    {kfOrg.name}
                  </option>
                ))}
              </Select>
            </div>
            <Button type="submit" disabled={submitting === 'kforg'}>
              {submitting === 'kforg' ? 'Saving…' : 'Save changes'}
            </Button>
          </form>
        </div>
      )}

      {/* Danger zone */}
      {isOwner && (
        <div className="rounded-surface border border-red-200 p-4">
          <h2 className="mb-2 text-sm font-semibold text-red-700">Danger zone</h2>
          <p className="text-ink-muted mb-3 text-sm">
            Permanently delete this organization, all its collections, versions, records, and files.
            This cannot be undone.
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
                  className="bg-parchment rounded-control w-full border border-red-200 px-3 py-2 text-sm focus:border-red-400 focus:outline-none"
                />
              </div>
              <Button type="submit" variant="danger" disabled={submitting === 'delete'}>
                {submitting === 'delete' ? 'Deleting…' : 'Delete organization'}
              </Button>
            </form>
          </details>
        </div>
      )}
    </SettingsLayout>
  )
}
