import { Link } from 'react-router'
import { useState, type FormEvent } from 'react'
import BaseLayout from '~/components/BaseLayout'
import { useSSRData } from '~/lib/ssr-data'

export default function InvitationsAccept() {
  const me = useSSRData<any>('currentUser')

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
      <div className="max-w-sm mx-auto px-4 py-16">
        <h1 className="text-xl font-semibold tracking-tight mb-6">Organization Invitation</h1>

        {success ? (
          <div className="border border-rule bg-parchment-dark px-4 py-3 text-sm">
            <p className="font-medium mb-1">You've joined the organization!</p>
            <p className="text-ink-muted text-xs mb-3">You now have access to the organization's collections.</p>
            {orgSlug ? (
              <Link to={`/${orgSlug}`} className="text-sm text-link hover:underline">Go to organization →</Link>
            ) : (
              <Link to="/dashboard" className="text-sm text-link hover:underline">Go to dashboard →</Link>
            )}
          </div>
        ) : error ? (
          <div className="border border-red-300 bg-red-50 text-red-800 px-3 py-2 text-sm">
            <p>{error}</p>
            {!me && token && (
              <p className="mt-2 text-xs">
                You may need to <Link to={`/login?redirect=${encodeURIComponent(`/invitations/accept?token=${token}`)}`} className="underline">log in</Link> or
                <Link to={`/signup?redirect=${encodeURIComponent(`/invitations/accept?token=${token}`)}`} className="underline ml-1">sign up</Link> first.
              </p>
            )}
          </div>
        ) : (
          <>
            {!me ? (
              <div className="space-y-3">
                <p className="text-sm text-ink-muted">You've been invited to join an organization. Please log in or sign up to accept.</p>
                <div className="flex gap-3">
                  <Link
                    to={`/login?redirect=${encodeURIComponent(`/invitations/accept?token=${token}`)}`}
                    className="flex-1 text-center bg-ink text-parchment py-2 text-sm font-medium hover:bg-ink-light transition-colors"
                  >
                    Log in
                  </Link>
                  <Link
                    to={`/signup?redirect=${encodeURIComponent(`/invitations/accept?token=${token}`)}`}
                    className="flex-1 text-center border border-ink py-2 text-sm font-medium hover:bg-parchment-dark transition-colors"
                  >
                    Sign up
                  </Link>
                </div>
              </div>
            ) : (
              <form onSubmit={handleAccept} className="space-y-4">
                <p className="text-sm text-ink-muted">Click below to accept the invitation and join the organization.</p>
                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full bg-ink text-parchment py-2 text-sm font-medium hover:bg-ink-light transition-colors"
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
