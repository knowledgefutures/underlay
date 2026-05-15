import { useEffect, } from 'react'
import { useSearchParams, } from 'react-router'
import BaseLayout from '~/components/BaseLayout'

export default function LoginPage() {
  const [params,] = useSearchParams()
  const error = params.get('error',)

  useEffect(() => {
    // If no error, redirect to KF Auth immediately
    if (!error) {
      window.location.href = '/auth/login'
    }
  }, [error,],)

  if (!error) {
    return (
      <BaseLayout>
        <div className='max-w-sm mx-auto px-4 py-16 text-center'>
          <p className='text-sm text-ink-muted'>Redirecting to sign in...</p>
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
      <div className='max-w-sm mx-auto px-4 py-16'>
        <h1 className='text-xl font-semibold tracking-tight mb-6'>Sign in</h1>

        <div className='border border-red-300 bg-red-50 text-red-800 px-3 py-2 text-sm mb-4'>
          {messages[error] ?? 'Something went wrong. Please try again.'}
        </div>

        <a
          href='/auth/login'
          className='block w-full bg-ink text-parchment py-2 text-sm font-medium text-center hover:bg-ink-light transition-colors'
        >
          Try again
        </a>
      </div>
    </BaseLayout>
  )
}
