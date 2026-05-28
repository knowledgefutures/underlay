import { useEffect } from 'react'
import { useSearchParams } from 'react-router'

import BaseLayout from '~/components/BaseLayout'

export default function LoginPage() {
  const [params] = useSearchParams()
  const error = params.get('error')

  useEffect(() => {
    // If no error, redirect to KF Auth immediately
    if (!error) {
      window.location.href = '/login'
    }
  }, [error])

  if (!error) {
    return (
      <BaseLayout>
        <div className="mx-auto max-w-sm px-4 py-16 text-center">
          <p className="text-ink-muted text-sm">Redirecting to sign in...</p>
        </div>
      </BaseLayout>
    )
  }

  const messages: Record<string, string> = {
    auth_failed: 'Authentication was cancelled or failed.',
    missing_params: 'Invalid response from the auth server.',
    invalid_state: 'Session expired. Please try again.',
    token_exchange: 'Could not complete sign in. Please try again.',
    userinfo: 'Could not retrieve your profile. Please try again.',
  }

  return (
    <BaseLayout>
      <div className="mx-auto max-w-sm px-4 py-16">
        <h1 className="mb-6 text-xl font-semibold tracking-tight">Sign in</h1>

        <div className="mb-4 border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          {messages[error] ?? 'Something went wrong. Please try again.'}
        </div>

        <a
          href="/login"
          className="bg-ink text-parchment hover:bg-ink-light block w-full py-2 text-center text-sm font-medium transition-colors"
        >
          Try again
        </a>
      </div>
    </BaseLayout>
  )
}
