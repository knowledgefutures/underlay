import { type FormEvent, useState } from 'react'
import { Link } from 'react-router'

import BaseLayout from '~/components/BaseLayout'
import { useAppContext } from '~/lib/app-context'

export default function InvitationsAccept() {
  const { currentUser } = useAppContext()

  const params = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '')
  const token = params.get('token') ?? ''

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
          <div className="border-rule bg-parchment-dark border px-4 py-3 text-sm">
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
          <div className="border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
            <p>{error}</p>
            {!currentUser && token && (
              <p className="mt-2 text-xs">
                You may need to{' '}
                <a
                  href={`/login?return_to=${encodeURIComponent(`/invitations/accept?token=${token}`)}`}
                  className="underline"
                >
                  log in
                </a>{' '}
                or
                <Link
                  to={`/signup?redirect=${encodeURIComponent(`/invitations/accept?token=${token}`)}`}
                  className="ml-1 underline"
                >
                  sign up
                </Link>{' '}
                first.
              </p>
            )}
          </div>
        ) : (
          <>
            {!currentUser ? (
              <div className="space-y-3">
                <p className="text-ink-muted text-sm">
                  You've been invited to join an organization. Please log in or sign up to accept.
                </p>
                <div className="flex gap-3">
                  <a
                    href={`/login?return_to=${encodeURIComponent(`/invitations/accept?token=${token}`)}`}
                    className="bg-ink text-parchment hover:bg-ink-light flex-1 py-2 text-center text-sm font-medium transition-colors"
                  >
                    Log in
                  </a>
                  <Link
                    to={`/signup?redirect=${encodeURIComponent(`/invitations/accept?token=${token}`)}`}
                    className="border-ink hover:bg-parchment-dark flex-1 border py-2 text-center text-sm font-medium transition-colors"
                  >
                    Sign up
                  </Link>
                </div>
              </div>
            ) : (
              <form onSubmit={handleAccept} className="space-y-4">
                <p className="text-ink-muted text-sm">
                  Click below to accept the invitation and join the organization.
                </p>
                <button
                  type="submit"
                  disabled={submitting}
                  className="bg-ink text-parchment hover:bg-ink-light w-full py-2 text-sm font-medium transition-colors"
                >
                  {submitting ? 'Accepting…' : 'Accept invitation'}
                </button>
              </form>
            )}
          </>
        )}
      </div>
    </BaseLayout>
  )
}
