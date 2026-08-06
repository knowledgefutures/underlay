import { type FormEvent, useState } from 'react'

import SettingsLayout, { userSettingsRail } from '~/components/SettingsLayout'
import { Alert, Button, Checkbox, Input, SectionHeading, Textarea } from '~/components/ui'
import { useAppContext } from '~/lib/app-context'

export default function Settings() {
  const { currentUser, kfAccountUrl } = useAppContext()

  const [success, setSuccess] = useState('')
  const [error, setError] = useState('')

  // Profile form (Underlay-specific fields only — name/email managed by KF Auth)
  const [slugValue, setSlugValue] = useState(currentUser?.slug ?? '')
  const [bio, setBio] = useState(currentUser?.bio ?? '')
  const [website, setWebsite] = useState(currentUser?.website ?? '')
  const [location, setLocation] = useState(currentUser?.location ?? '')

  // Avatar
  const [avatarUrl, setAvatarUrl] = useState(currentUser?.avatarUrl ?? '')

  // Notifications
  const notifPrefs = (currentUser?.notificationPrefs as Record<string, boolean>) ?? {}
  const [collectionActivity, setCollectionActivity] = useState(
    notifPrefs.collectionActivity ?? true,
  )
  const [orgInvitations, setOrgInvitations] = useState(notifPrefs.orgInvitations ?? true)
  const [securityAlerts, setSecurityAlerts] = useState(notifPrefs.securityAlerts ?? true)

  // Delete account
  const [confirmSlug, setConfirmSlug] = useState('')

  const [submitting, setSubmitting] = useState('')

  function clearMessages() {
    setSuccess('')
    setError('')
  }

  async function handleUpdateProfile(e: FormEvent) {
    e.preventDefault()
    clearMessages()
    setSubmitting('profile')
    const slugChanged = slugValue.trim() !== '' && slugValue.trim() !== currentUser?.slug
    try {
      const payload: Record<string, any> = { bio, website, location }
      if (slugChanged) payload.slug = slugValue.trim()

      const res = await fetch('/api/accounts/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      })
      if (res.ok) {
        if (slugChanged) {
          window.location.href = '/settings'
          return
        }
        setSuccess('Profile updated.')
      } else {
        const body = await res.json().catch(() => ({}))
        setError(body.error ?? 'Update failed.')
      }
    } finally {
      setSubmitting('')
    }
  }

  async function handleUploadAvatar(e: FormEvent) {
    e.preventDefault()
    clearMessages()

    const form = e.target as HTMLFormElement
    const fileInput = form.elements.namedItem('avatar') as HTMLInputElement
    const file = fileInput?.files?.[0]
    if (!file) {
      setError('Please select an image file.')
      return
    }

    setSubmitting('avatar')
    try {
      const formData = new FormData()
      formData.append('avatar', file)
      const res = await fetch('/api/accounts/me/avatar', {
        method: 'POST',
        credentials: 'include',
        body: formData,
      })
      if (res.ok) {
        const data = await res.json()
        setSuccess('Avatar updated.')
        setAvatarUrl(data.avatarUrl)
        form.reset()
      } else {
        const body = await res.json().catch(() => ({}))
        setError(body.error ?? 'Upload failed.')
      }
    } finally {
      setSubmitting('')
    }
  }

  async function handleUpdateNotifications(e: FormEvent) {
    e.preventDefault()
    clearMessages()
    setSubmitting('notifications')
    try {
      const res = await fetch('/api/accounts/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          notificationPrefs: { collectionActivity, orgInvitations, securityAlerts },
        }),
      })
      if (res.ok) {
        setSuccess('Notification preferences saved.')
      } else {
        setError('Failed to save preferences.')
      }
    } finally {
      setSubmitting('')
    }
  }

  async function handleDeleteAccount(e: FormEvent) {
    e.preventDefault()
    clearMessages()
    setSubmitting('delete')
    try {
      const res = await fetch('/api/accounts/me', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ confirmSlug }),
      })
      if (res.ok) {
        window.location.href = '/'
      } else {
        const body = await res.json().catch(() => ({}))
        setError(body.error ?? 'Failed to delete account.')
      }
    } finally {
      setSubmitting('')
    }
  }

  return (
    <SettingsLayout
      title="Profile"
      description="Your public identity on Underlay."
      groups={userSettingsRail}
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

      {/* Avatar */}
      <div className="mb-8 flex items-start gap-4">
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt="Avatar"
            className="border-rule h-16 w-16 rounded-full border object-cover"
          />
        ) : (
          <div className="bg-parchment-dark border-rule text-ink-muted flex h-16 w-16 items-center justify-center rounded-full border text-lg font-semibold">
            {currentUser.displayName?.charAt(0)?.toUpperCase() ?? '?'}
          </div>
        )}
        <div className="min-w-0">
          <p className="text-sm font-medium">{currentUser.displayName}</p>
          <p className="text-ink-muted font-mono text-xs">@{currentUser.slug}</p>
          <form onSubmit={handleUploadAvatar} className="mt-2 flex flex-wrap items-center gap-2">
            <input
              type="file"
              name="avatar"
              accept="image/jpeg,image/png,image/gif,image/webp"
              className="file:border-rule file:bg-parchment hover:file:bg-parchment-dark file:rounded-control text-xs file:mr-2 file:cursor-pointer file:border file:px-2.5 file:py-1 file:text-xs file:font-medium"
            />
            <Button type="submit" size="sm" variant="secondary" disabled={submitting === 'avatar'}>
              {submitting === 'avatar' ? 'Uploading…' : 'Upload avatar'}
            </Button>
          </form>
        </div>
      </div>

      {/* Profile */}
      <form onSubmit={handleUpdateProfile} className="mb-10 space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium">Display name</label>
          <p className="text-ink-muted text-sm">{currentUser.displayName}</p>
          <p className="text-ink-muted mt-1 text-xs">
            Managed by your{' '}
            <a
              href={kfAccountUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-link hover:underline"
            >
              KF Account
            </a>
            .
          </p>
        </div>
        <div>
          <label htmlFor="bio" className="mb-1 block text-sm font-medium">
            Bio
          </label>
          <Textarea
            id="bio"
            rows={3}
            placeholder="A short bio..."
            value={bio}
            onChange={(e) => setBio(e.target.value)}
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
            Username
          </label>
          <Input
            type="text"
            id="slug"
            value={slugValue}
            onChange={(e) => setSlugValue(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
            pattern="[a-z0-9][-a-z0-9]*[a-z0-9]"
            className="font-mono"
          />
          {slugValue !== currentUser?.slug && (
            <p className="mt-1 text-xs text-amber-700">
              Changing your username will update all your URLs.
            </p>
          )}
        </div>
        <Button type="submit" disabled={submitting === 'profile'}>
          {submitting === 'profile' ? 'Saving…' : 'Save changes'}
        </Button>
      </form>

      {/* KF Auth Account — name, email, password, security */}
      <div className="border-rule mb-10 border-t pt-6">
        <SectionHeading>Account &amp; Security</SectionHeading>
        <p className="text-ink-muted mb-3 text-sm">
          Your name, email, password, and security settings are managed through your KF Account.
        </p>
        <a
          href={kfAccountUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="bg-ink text-parchment hover:bg-ink-light rounded-control inline-block px-4 py-2 text-sm font-medium transition-colors"
        >
          Manage account →
        </a>
      </div>

      {/* Notifications */}
      <div className="border-rule mb-10 border-t pt-6">
        <SectionHeading>Notifications</SectionHeading>
        <p className="text-ink-muted mb-3 text-xs">
          Email notifications (requires SMTP configuration).
        </p>
        <form onSubmit={handleUpdateNotifications} className="space-y-3">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={collectionActivity}
              onChange={(e) => setCollectionActivity(e.target.checked)}
            />
            Collection activity (new versions pushed)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={orgInvitations}
              onChange={(e) => setOrgInvitations(e.target.checked)}
            />
            Organization invitations
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={securityAlerts}
              onChange={(e) => setSecurityAlerts(e.target.checked)}
            />
            Security alerts (new logins, password changes)
          </label>
          <Button type="submit" disabled={submitting === 'notifications'}>
            {submitting === 'notifications' ? 'Saving…' : 'Save changes'}
          </Button>
        </form>
      </div>

      {/* Danger zone */}
      <div className="rounded-surface border border-red-200 p-4">
        <h2 className="mb-2 text-sm font-semibold text-red-700">Danger zone</h2>
        <p className="text-ink-muted mb-3 text-sm">
          Permanently delete your account. You must first transfer or delete all your collections.
        </p>
        <details className="group">
          <summary className="cursor-pointer text-sm text-red-700 hover:underline">
            Delete my account…
          </summary>
          <form onSubmit={handleDeleteAccount} className="mt-3 space-y-3">
            <div>
              <label htmlFor="confirmSlug" className="text-ink-muted mb-1 block text-sm">
                Type <strong>{currentUser.slug}</strong> to confirm:
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
              {submitting === 'delete' ? 'Deleting…' : 'Delete my account'}
            </Button>
          </form>
        </details>
      </div>
    </SettingsLayout>
  )
}
