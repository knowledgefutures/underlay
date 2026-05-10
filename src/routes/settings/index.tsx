import { Link } from 'react-router'
import { useState, type FormEvent } from 'react'
import BaseLayout from '~/components/BaseLayout'
import { useSSRData } from '~/lib/ssr-data'

export default function Settings() {
  const me = useSSRData<any>('currentUser')

  const [success, setSuccess] = useState('')
  const [error, setError] = useState('')

  // Profile form
  const [displayName, setDisplayName] = useState(me?.displayName ?? '')
  const [bio, setBio] = useState(me?.bio ?? '')
  const [website, setWebsite] = useState(me?.website ?? '')
  const [location, setLocation] = useState(me?.location ?? '')

  // Email form
  const [newEmail, setNewEmail] = useState('')
  const [emailPassword, setEmailPassword] = useState('')

  // Password form
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  // Notifications
  const notifPrefs = (me?.notificationPrefs as Record<string, boolean>) ?? {}
  const [collectionActivity, setCollectionActivity] = useState(notifPrefs.collectionActivity ?? true)
  const [orgInvitations, setOrgInvitations] = useState(notifPrefs.orgInvitations ?? true)
  const [securityAlerts, setSecurityAlerts] = useState(notifPrefs.securityAlerts ?? true)

  // Delete account
  const [confirmSlug, setConfirmSlug] = useState('')
  const [deletePassword, setDeletePassword] = useState('')

  const [submitting, setSubmitting] = useState('')

  function clearMessages() {
    setSuccess('')
    setError('')
  }

  async function handleUpdateProfile(e: FormEvent) {
    e.preventDefault()
    clearMessages()
    setSubmitting('profile')
    try {
      const res = await fetch('/api/accounts/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ displayName, bio, website, location }),
      })
      if (res.ok) {
        setSuccess('Profile updated.')
      } else {
        const body = await res.json().catch(() => ({}))
        setError(body.error ?? 'Update failed.')
      }
    } finally {
      setSubmitting('')
    }
  }

  async function handleChangeEmail(e: FormEvent) {
    e.preventDefault()
    clearMessages()
    setSubmitting('email')
    try {
      const res = await fetch('/api/accounts/me/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ newEmail, password: emailPassword }),
      })
      if (res.ok) {
        setSuccess('Email updated.')
      } else {
        const body = await res.json().catch(() => ({}))
        setError(body.error ?? 'Failed to update email.')
      }
    } finally {
      setSubmitting('')
    }
  }

  async function handleChangePassword(e: FormEvent) {
    e.preventDefault()
    clearMessages()
    if (newPassword !== confirmPassword) {
      setError('New passwords do not match.')
      return
    }
    setSubmitting('password')
    try {
      const res = await fetch('/api/accounts/me/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ currentPassword, newPassword }),
      })
      if (res.ok) {
        setSuccess('Password changed.')
        setCurrentPassword('')
        setNewPassword('')
        setConfirmPassword('')
      } else {
        const body = await res.json().catch(() => ({}))
        setError(body.error ?? 'Failed to change password.')
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
        body: JSON.stringify({ notificationPrefs: { collectionActivity, orgInvitations, securityAlerts } }),
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
        body: JSON.stringify({ confirmSlug, password: deletePassword }),
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

  async function handleLogout() {
    await fetch('/api/accounts/logout', {
      method: 'POST',
      credentials: 'include',
    })
    window.location.href = '/'
  }

  if (!me) return null

  return (
    <BaseLayout>
      <div className="max-w-4xl mx-auto px-4 py-10">
        <h1 className="text-xl font-semibold tracking-tight mb-6">Settings</h1>

        <nav className="flex gap-4 text-sm border-b border-rule mb-6 pb-2">
          <Link to="/settings" className="text-ink font-medium">Account</Link>
          <Link to="/settings/keys" className="text-ink-muted hover:text-ink">API Keys</Link>
          <Link to="/settings/sessions" className="text-ink-muted hover:text-ink">Sessions</Link>
        </nav>

        {success && <p className="text-sm text-green-800 bg-green-50 border border-green-200 px-3 py-2 mb-4">{success}</p>}
        {error && <p className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 mb-4">{error}</p>}

        {/* Profile */}
        <form onSubmit={handleUpdateProfile} className="space-y-4 mb-10">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">Profile</h2>

          <div className="flex items-center gap-4 mb-4">
            {me.avatarUrl ? (
              <img src={me.avatarUrl} alt="Avatar" className="w-16 h-16 rounded-full object-cover border border-rule" />
            ) : (
              <div className="w-16 h-16 rounded-full bg-parchment-dark border border-rule flex items-center justify-center text-ink-muted text-lg font-semibold">
                {me.displayName?.charAt(0)?.toUpperCase() ?? '?'}
              </div>
            )}
            <div>
              <p className="text-sm font-medium">{me.displayName}</p>
              <p className="text-xs text-ink-muted font-mono">@{me.slug}</p>
              <Link to="/settings/avatar" className="text-xs text-link hover:underline mt-1 inline-block">Change avatar</Link>
            </div>
          </div>

          <div>
            <label htmlFor="displayName" className="block text-sm font-medium mb-1">Display Name</label>
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
            <label htmlFor="bio" className="block text-sm font-medium mb-1">Bio</label>
            <textarea
              id="bio"
              rows={3}
              placeholder="A short bio..."
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              className="w-full bg-parchment border border-rule px-3 py-2 text-sm focus:outline-none focus:border-ink resize-none"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="website" className="block text-sm font-medium mb-1">Website</label>
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
              <label htmlFor="location" className="block text-sm font-medium mb-1">Location</label>
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
            <label className="block text-sm font-medium mb-1">Username</label>
            <p className="text-sm text-ink-muted font-mono">{me.slug}</p>
            <p className="text-xs text-ink-muted mt-1">Usernames cannot be changed.</p>
          </div>
          <button
            type="submit"
            disabled={submitting === 'profile'}
            className="bg-ink text-parchment px-4 py-2 text-sm font-medium hover:opacity-90 transition-opacity"
          >
            Save profile
          </button>
        </form>

        {/* Change Email */}
        <div className="border-t border-rule pt-6 mb-10">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted mb-4">Email</h2>
          <p className="text-sm text-ink-muted mb-3">Current: <span className="font-mono">{me.email}</span></p>
          <details className="group">
            <summary className="text-sm text-link cursor-pointer hover:underline">Change email address</summary>
            <form onSubmit={handleChangeEmail} className="mt-3 space-y-3">
              <div>
                <label htmlFor="newEmail" className="block text-xs font-medium mb-1">New email</label>
                <input
                  type="email"
                  id="newEmail"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  required
                  className="w-full bg-parchment border border-rule px-3 py-2 text-sm font-mono focus:outline-none focus:border-ink"
                />
              </div>
              <div>
                <label htmlFor="emailPassword" className="block text-xs font-medium mb-1">Current password</label>
                <input
                  type="password"
                  id="emailPassword"
                  value={emailPassword}
                  onChange={(e) => setEmailPassword(e.target.value)}
                  required
                  className="w-full bg-parchment border border-rule px-3 py-2 text-sm focus:outline-none focus:border-ink"
                />
              </div>
              <button
                type="submit"
                disabled={submitting === 'email'}
                className="bg-ink text-parchment px-4 py-2 text-sm font-medium hover:opacity-90 transition-opacity"
              >
                Update email
              </button>
            </form>
          </details>
        </div>

        {/* Change Password */}
        <div className="border-t border-rule pt-6 mb-10">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted mb-4">Password</h2>
          <details className="group">
            <summary className="text-sm text-link cursor-pointer hover:underline">Change password</summary>
            <form onSubmit={handleChangePassword} className="mt-3 space-y-3">
              <div>
                <label htmlFor="currentPassword" className="block text-xs font-medium mb-1">Current password</label>
                <input
                  type="password"
                  id="currentPassword"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  required
                  className="w-full bg-parchment border border-rule px-3 py-2 text-sm focus:outline-none focus:border-ink"
                />
              </div>
              <div>
                <label htmlFor="newPassword" className="block text-xs font-medium mb-1">New password</label>
                <input
                  type="password"
                  id="newPassword"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  minLength={8}
                  className="w-full bg-parchment border border-rule px-3 py-2 text-sm focus:outline-none focus:border-ink"
                />
              </div>
              <div>
                <label htmlFor="confirmPassword" className="block text-xs font-medium mb-1">Confirm new password</label>
                <input
                  type="password"
                  id="confirmPassword"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  minLength={8}
                  className="w-full bg-parchment border border-rule px-3 py-2 text-sm focus:outline-none focus:border-ink"
                />
              </div>
              <button
                type="submit"
                disabled={submitting === 'password'}
                className="bg-ink text-parchment px-4 py-2 text-sm font-medium hover:opacity-90 transition-opacity"
              >
                Change password
              </button>
            </form>
          </details>
        </div>

        {/* Notifications */}
        <div className="border-t border-rule pt-6 mb-10">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted mb-4">Notifications</h2>
          <p className="text-xs text-ink-muted mb-3">Email notifications (requires SMTP configuration).</p>
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
              className="bg-ink text-parchment px-4 py-2 text-sm font-medium hover:opacity-90 transition-opacity"
            >
              Save preferences
            </button>
          </form>
        </div>

        {/* Danger zone */}
        <div className="border border-red-200 p-4">
          <h2 className="text-sm font-semibold text-red-700 mb-2">Danger Zone</h2>
          <p className="text-sm text-ink-muted mb-3">
            Permanently delete your account. You must first transfer or delete all your collections.
          </p>
          <details className="group">
            <summary className="text-sm text-red-700 cursor-pointer hover:underline">Delete my account…</summary>
            <form onSubmit={handleDeleteAccount} className="mt-3 space-y-3">
              <div>
                <label htmlFor="confirmSlug" className="block text-sm text-ink-muted mb-1">
                  Type <strong>{me.slug}</strong> to confirm:
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
              <div>
                <label htmlFor="deletePassword" className="block text-sm text-ink-muted mb-1">Password:</label>
                <input
                  type="password"
                  id="deletePassword"
                  value={deletePassword}
                  onChange={(e) => setDeletePassword(e.target.value)}
                  required
                  className="w-full bg-parchment border border-red-200 px-3 py-2 text-sm focus:outline-none focus:border-red-400"
                />
              </div>
              <button
                type="submit"
                disabled={submitting === 'delete'}
                className="bg-red-700 text-white px-4 py-2 text-sm font-medium hover:bg-red-800 transition-colors"
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
