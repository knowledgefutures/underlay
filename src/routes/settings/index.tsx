import { type FormEvent, useState } from 'react'
import { Link } from 'react-router'

import BaseLayout from '~/components/BaseLayout'
import { useAppContext } from '~/lib/app-context'

export default function Settings() {
  const { currentUser, kfAccountUrl } = useAppContext()

  const [success, setSuccess] = useState('')
  const [error, setError] = useState('')

  // Profile form (Underlay-specific fields only — name/email/avatar managed by KF Auth)
  const [slugValue, setSlugValue] = useState(currentUser?.slug ?? '')
  const [bio, setBio] = useState(currentUser?.bio ?? '')
  const [website, setWebsite] = useState(currentUser?.website ?? '')
  const [location, setLocation] = useState(currentUser?.location ?? '')

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
    <BaseLayout>
      <div className="mx-auto max-w-4xl px-4 py-10">
        <h1 className="mb-6 text-xl font-semibold tracking-tight">Settings</h1>

        <nav className="border-rule mb-6 flex gap-4 border-b pb-2 text-sm">
          <Link to="/settings" className="text-ink font-medium">
            Account
          </Link>
          <Link to="/settings/keys" className="text-ink-muted hover:text-ink">
            API Keys
          </Link>
          <Link to="/settings/sessions" className="text-ink-muted hover:text-ink">
            Sessions
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

        {/* Profile */}
        <form onSubmit={handleUpdateProfile} className="mb-10 space-y-4">
          <h2 className="text-ink-muted text-sm font-semibold tracking-wide uppercase">Profile</h2>

          <div className="mb-4 flex items-center gap-4">
            {currentUser.avatarUrl ? (
              <img
                src={currentUser.avatarUrl}
                alt="Avatar"
                className="border-rule h-16 w-16 rounded-full border object-cover"
              />
            ) : (
              <div className="bg-parchment-dark border-rule text-ink-muted flex h-16 w-16 items-center justify-center rounded-full border text-lg font-semibold">
                {currentUser.displayName?.charAt(0)?.toUpperCase() ?? '?'}
              </div>
            )}
            <div>
              <p className="text-sm font-medium">{currentUser.displayName}</p>
              <p className="text-ink-muted font-mono text-xs">@{currentUser.slug}</p>
              <a
                href={kfAccountUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-link mt-1 inline-block text-xs hover:underline"
              >
                Edit name or avatar at KF Account →
              </a>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">Display Name</label>
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
            <textarea
              id="bio"
              rows={3}
              placeholder="A short bio..."
              value={bio}
              onChange={(e) => setBio(e.target.value)}
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
              Username
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
            {slugValue !== currentUser?.slug && (
              <p className="mt-1 text-xs text-amber-700">
                Changing your username will update all your URLs.
              </p>
            )}
          </div>
          <button
            type="submit"
            disabled={submitting === 'profile'}
            className="bg-ink text-parchment px-4 py-2 text-sm font-medium transition-opacity hover:opacity-90"
          >
            Save profile
          </button>
        </form>

        {/* KF Auth Account — name, email, avatar, password, security */}
        <div className="border-rule mb-10 border-t pt-6">
          <h2 className="text-ink-muted mb-4 text-sm font-semibold tracking-wide uppercase">
            Account &amp; Security
          </h2>
          <p className="text-ink-muted mb-3 text-sm">
            Your name, email, avatar, password, and security settings are managed through your KF
            Account.
          </p>
          <a
            href={kfAccountUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="bg-ink text-parchment inline-block px-4 py-2 text-sm font-medium transition-opacity hover:opacity-90"
          >
            Manage account →
          </a>
        </div>

        {/* Notifications */}
        <div className="border-rule mb-10 border-t pt-6">
          <h2 className="text-ink-muted mb-4 text-sm font-semibold tracking-wide uppercase">
            Notifications
          </h2>
          <p className="text-ink-muted mb-3 text-xs">
            Email notifications (requires SMTP configuration).
          </p>
          <form onSubmit={handleUpdateNotifications} className="space-y-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={collectionActivity}
                onChange={(e) => setCollectionActivity(e.target.checked)}
                className="accent-ink"
              />
              Collection activity (new versions pushed)
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={orgInvitations}
                onChange={(e) => setOrgInvitations(e.target.checked)}
                className="accent-ink"
              />
              Organization invitations
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={securityAlerts}
                onChange={(e) => setSecurityAlerts(e.target.checked)}
                className="accent-ink"
              />
              Security alerts (new logins, password changes)
            </label>
            <button
              type="submit"
              disabled={submitting === 'notifications'}
              className="bg-ink text-parchment px-4 py-2 text-sm font-medium transition-opacity hover:opacity-90"
            >
              Save preferences
            </button>
          </form>
        </div>

        {/* Danger zone */}
        <div className="border border-red-200 p-4">
          <h2 className="mb-2 text-sm font-semibold text-red-700">Danger Zone</h2>
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
                  className="bg-parchment w-full border border-red-200 px-3 py-2 text-sm focus:border-red-400 focus:outline-none"
                />
              </div>
              <button
                type="submit"
                disabled={submitting === 'delete'}
                className="bg-red-700 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-800"
              >
                Delete my account
              </button>
            </form>
          </details>
        </div>
      </div>
    </BaseLayout>
  )
}
