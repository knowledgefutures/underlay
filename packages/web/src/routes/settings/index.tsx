import { type FormEvent, useState } from 'react'

import SettingsLayout, { accountCrumb, userSettingsRail } from '~/components/SettingsLayout'
import { Alert, Button, buttonClasses, SectionHeading } from '~/components/ui'
import { useAppContext } from '~/lib/app-context'

export default function Settings() {
  const { currentUser, kfAccountUrl } = useAppContext()

  const [error, setError] = useState('')

  // Delete account: confirmed by email
  const [confirmEmail, setConfirmEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleDeleteAccount(e: FormEvent) {
    e.preventDefault()
    setError('')
    setSubmitting(true)
    try {
      const res = await fetch('/api/accounts/me', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ confirmEmail: confirmEmail.trim() }),
      })
      if (res.ok) {
        window.location.href = '/'
      } else {
        const body = await res.json().catch(() => ({}))
        setError(body.error ?? 'Failed to delete account.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <SettingsLayout
      crumb={accountCrumb}
      title="Profile"
      description="Your account on Underlay."
      groups={userSettingsRail}
    >
      {error && (
        <Alert variant="error" className="mb-4">
          {error}
        </Alert>
      )}

      {/* Avatar and name come from KF Auth, so they are changed there */}
      <div className="mb-8 flex items-start gap-4">
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
        <div className="min-w-0">
          <p className="text-sm font-medium">{currentUser.displayName}</p>
          <p className="text-ink-muted mt-2 text-xs">
            Name and picture managed by your{' '}
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
      </div>

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
          className={buttonClasses('primary', 'md', 'visited:text-parchment')}
        >
          Manage account →
        </a>
      </div>

      {/* Danger zone */}
      <div className="rounded-surface border border-red-200 p-4">
        <h2 className="mb-2 text-sm font-semibold text-red-700">Danger zone</h2>
        <p className="text-ink-muted mb-3 text-sm">Permanently delete your account.</p>
        <details className="group">
          <summary className="cursor-pointer text-sm text-red-700 hover:underline">
            Delete my account…
          </summary>
          <form onSubmit={handleDeleteAccount} className="mt-3 space-y-3">
            <div>
              <label htmlFor="confirmEmail" className="text-ink-muted mb-1 block text-sm">
                Type <strong>{currentUser?.email ?? ''}</strong> to confirm:
              </label>
              <input
                type="text"
                id="confirmEmail"
                value={confirmEmail}
                onChange={(e) => setConfirmEmail(e.target.value)}
                required
                autoComplete="off"
                className="bg-parchment rounded-control w-full border border-red-200 px-3 py-2 text-sm focus:border-red-400 focus:outline-none"
              />
            </div>
            <Button type="submit" variant="danger" disabled={submitting}>
              {submitting ? 'Deleting…' : 'Delete my account'}
            </Button>
          </form>
        </details>
      </div>
    </SettingsLayout>
  )
}
