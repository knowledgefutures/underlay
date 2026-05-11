import { Link } from 'react-router'
import { useState } from 'react'
import BaseLayout from '~/components/BaseLayout'

export default function SignupPage() {
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setSubmitting(true)
    setError('')

    const form = new FormData(e.currentTarget)
    const email = form.get('email') as string
    const password = form.get('password') as string
    const username = form.get('username') as string
    const displayName = form.get('displayName') as string

    try {
      const res = await fetch('/api/accounts/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, username, displayName }),
        credentials: 'same-origin',
      })

      if (res.ok) {
        window.location.href = '/dashboard'
        return
      }

      const body = await res.json().catch(() => ({}))
      setError(body.error ?? body.message ?? 'Signup failed. Please try again.')
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <BaseLayout>
      <div className="max-w-sm mx-auto px-4 py-16">
        <h1 className="text-xl font-semibold tracking-tight mb-6">Create an account</h1>

        {error && <p className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 mb-4">{error}</p>}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="displayName" className="block text-sm font-medium mb-1">Name</label>
            <input
              type="text"
              id="displayName"
              name="displayName"
              required
              className="w-full bg-parchment border border-rule px-3 py-2 text-sm focus:outline-none focus:border-ink"
            />
          </div>
          <div>
            <label htmlFor="username" className="block text-sm font-medium mb-1">Username</label>
            <input
              type="text"
              id="username"
              name="username"
              required
              pattern="[a-z0-9\-]+"
              className="w-full bg-parchment border border-rule px-3 py-2 text-sm font-mono focus:outline-none focus:border-ink"
            />
            <p className="text-xs text-ink-muted mt-1">Lowercase letters, numbers, and hyphens only.</p>
          </div>
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
          <div>
            <label htmlFor="password" className="block text-sm font-medium mb-1">Password</label>
            <input
              type="password"
              id="password"
              name="password"
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
            {submitting ? 'Creating account…' : 'Create account'}
          </button>
        </form>

        <p className="text-sm text-ink-muted mt-4">
          Already have an account? <Link to="/login" className="text-link underline">Log in</Link>
        </p>
      </div>
    </BaseLayout>
  )
}
