import { useState } from 'react'
import BaseLayout from '~/components/BaseLayout'

export default function ResetPasswordPage() {
  const params = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '')
  const token = params.get('token') ?? ''
  const email = params.get('email') ?? ''

  const [success, setSuccess] = useState(false)
  const [error, setError] = useState(!token || !email ? 'Invalid or missing reset token.' : '')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setSubmitting(true)
    setError('')

    const form = new FormData(e.currentTarget)
    const password = form.get('password') as string
    const confirm = form.get('confirm') as string

    if (password !== confirm) {
      setError('Passwords do not match.')
      setSubmitting(false)
      return
    }

    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      setSubmitting(false)
      return
    }

    try {
      const res = await fetch('/api/accounts/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, token, newPassword: password }),
      })

      if (res.ok) {
        setSuccess(true)
      } else {
        const data = await res.json().catch(() => null)
        setError(data?.error ?? 'Reset link is invalid or expired.')
      }
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <BaseLayout>
      <div className="max-w-sm mx-auto px-4 py-16">
        <h1 className="text-xl font-semibold tracking-tight mb-6">Set new password</h1>

        {success ? (
          <div className="border border-rule bg-parchment-dark px-4 py-3 text-sm">
            <p className="font-medium mb-1">Password updated</p>
            <p className="text-ink-muted text-xs">Your password has been reset. You can now log in.</p>
            <a href="/login" className="inline-block mt-3 text-sm text-link hover:underline">Go to login →</a>
          </div>
        ) : (
          <>
            {error && (
              <div className="border border-red-300 bg-red-50 text-red-800 px-3 py-2 text-sm mb-4">
                {error}
              </div>
            )}

            {(token && email) ? (
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label htmlFor="password" className="block text-sm font-medium mb-1">New password</label>
                  <input
                    type="password"
                    id="password"
                    name="password"
                    required
                    minLength={8}
                    className="w-full bg-parchment border border-rule px-3 py-2 text-sm font-mono focus:outline-none focus:border-ink"
                  />
                </div>
                <div>
                  <label htmlFor="confirm" className="block text-sm font-medium mb-1">Confirm password</label>
                  <input
                    type="password"
                    id="confirm"
                    name="confirm"
                    required
                    minLength={8}
                    className="w-full bg-parchment border border-rule px-3 py-2 text-sm font-mono focus:outline-none focus:border-ink"
                  />
                </div>
                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full bg-ink text-parchment py-2 text-sm font-medium hover:bg-ink-light transition-colors disabled:opacity-50"
                >
                  {submitting ? 'Resetting…' : 'Reset password'}
                </button>
              </form>
            ) : (
              <p className="text-sm text-ink-muted">
                <a href="/forgot-password" className="text-link hover:underline">Request a new reset link →</a>
              </p>
            )}
          </>
        )}
      </div>
    </BaseLayout>
  )
}
