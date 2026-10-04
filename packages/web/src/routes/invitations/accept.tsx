import { type FormEvent, useState } from 'react'
import { Link } from 'react-router'

import BaseLayout from '~/components/BaseLayout'
import { Alert, Button, buttonClasses } from '~/components/ui'
import { useAppContext } from '~/lib/app-context'

export default function InvitationsAccept() {
  const { currentUser } = useAppContext()

  const params = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '')
  const token = params.get('token') ?? ''
  // KF Auth handles both sign-in and new accounts; /login returns here afterwards.
  const signIn = `/login?return_to=${encodeURIComponent(`/invitations/accept?token=${token}`)}`

  const [success, setSuccess] = useState(false)
  const [orgSlug, setOrgSlug] = useState('')
  const [error, setError] = useState(!token ? 'Invalid or missing invitation token.' : '')
  const [submitting, setSubmitting] = useState(false)

  async function handleAccept(e: FormEvent) {
    e.preventDefault()
    setError('')
    setSubmitting(true)
    try {
      const res = await fetch('/api/accounts/invitations/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ token }),
      })
      if (res.ok) {
        const data = await res.json()
        setOrgSlug(data.orgSlug ?? '')
        setSuccess(true)
      } else {
        const data = await res.json().catch(() => null)
        setError(data?.error ?? 'Invitation is invalid or expired.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <BaseLayout>
      <div className="mx-auto max-w-sm px-4 py-16">
        <h1 className="mb-6 text-xl font-semibold tracking-tight">Organization Invitation</h1>

        {success ? (
          <div className="border-rule bg-parchment-dark rounded-surface border px-4 py-3 text-sm">
            <p className="mb-1 font-medium">You've joined the organization!</p>
            <p className="text-ink-muted mb-3 text-xs">
              You now have access to the organization's collections.
            </p>
            {orgSlug ? (
              <Link to={`/${orgSlug}`} className="text-link text-sm hover:underline">
                Go to organization →
              </Link>
            ) : (
              <Link to="/dashboard" className="text-link text-sm hover:underline">
                Go to dashboard →
              </Link>
            )}
          </div>
        ) : error ? (
          <Alert variant="error">
            <p>{error}</p>
            {!currentUser && token && (
              <p className="mt-2 text-xs">
                You may need to{' '}
                <a href={signIn} className="underline">
                  sign in
                </a>{' '}
                first.
              </p>
            )}
          </Alert>
        ) : (
          <>
            {!currentUser ? (
              <div className="space-y-3">
                <p className="text-ink-muted text-sm">
                  You've been invited to join an organization. Sign in to accept; a new account can
                  be made on the way.
                </p>
                <a href={signIn} className={buttonClasses('primary', 'md', 'w-full')}>
                  Sign in
                </a>
              </div>
            ) : (
              <form onSubmit={handleAccept} className="space-y-4">
                <p className="text-ink-muted text-sm">
                  Click below to accept the invitation and join the organization.
                </p>
                <Button type="submit" disabled={submitting} className="w-full">
                  {submitting ? 'Accepting…' : 'Accept invitation'}
                </Button>
              </form>
            )}
          </>
        )}
      </div>
    </BaseLayout>
  )
}
