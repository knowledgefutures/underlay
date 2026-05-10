import { useState } from 'react'
import BaseLayout from '~/components/BaseLayout'

export default function ForgotPasswordPage() {
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setSubmitting(true)
    setError('')

    const form = new FormData(e.currentTarget)
    const email = form.get('email') as string

    try {
      await fetch('/api/accounts/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      // Always show success to avoid email enumeration
      setSent(true)
    } catch {
      setSent(true)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <BaseLayout>
      <div className="max-w-sm mx-auto px-4 py-16">
        <h1 className="text-xl font-semibold tracking-tight mb-2">Reset your password</h1>
        <p className="text-sm text-ink-muted mb-6">Enter your email and we'll send you a reset link.</p>

        {sent ? (
          <div className="border border-rule bg-parchment-dark px-4 py-3 text-sm">
            <p className="font-medium mb-1">Check your email</p>
            <p className="text-ink-muted text-xs">If an account exists with that email, you'll receive a password reset link shortly.</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="border border-red-300 bg-red-50 text-red-800 px-3 py-2 text-sm">
                {error}
              </div>
            )}
            <div>
              <label htmlFor="email" className="block text-sm font-medium mb-1">Email</label>
              <input
                type="email"
                id="email"
                name="email"
                required
                className="w-full bg-parchment border border-rule px-3 py-2 text-sm font-mono focus:outline-none focus:border-ink"
              />
            </div>
            <button
              type="submit"
              disabled={submitting}
              className="w-full bg-ink text-parchment py-2 text-sm font-medium hover:bg-ink-light transition-colors disabled:opacity-50"
            >
              {submitting ? 'Sending…' : 'Send reset link'}
            </button>
          </form>
        )}

        <p className="text-sm text-ink-muted mt-4">
          <a href="/login" className="text-link hover:underline">← Back to login</a>
        </p>
      </div>
    </BaseLayout>
  )
}
