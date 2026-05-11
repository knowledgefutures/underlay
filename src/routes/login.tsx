import { useState, } from 'react'
import { Link, } from 'react-router'
import BaseLayout from '~/components/BaseLayout'

export default function LoginPage() {
  const [loginError, setLoginError,] = useState('',)
  const [submitting, setSubmitting,] = useState(false,)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>,) {
    e.preventDefault()
    setSubmitting(true,)
    setLoginError('',)

    const form = new FormData(e.currentTarget,)
    const email = form.get('email',) as string
    const password = form.get('password',) as string

    try {
      const res = await fetch('/api/accounts/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', },
        body: JSON.stringify({ email, password, },),
        credentials: 'same-origin',
      },)

      if (res.ok) {
        window.location.href = '/dashboard'
        return
      }

      const err = await res.json().catch(() => null)
      setLoginError(err?.error ?? 'Invalid email or password.',)
    } catch {
      setLoginError('Network error. Please try again.',)
    } finally {
      setSubmitting(false,)
    }
  }

  return (
    <BaseLayout>
      <div className='max-w-sm mx-auto px-4 py-16'>
        <h1 className='text-xl font-semibold tracking-tight mb-6'>Log in</h1>

        {loginError && (
          <div className='border border-red-300 bg-red-50 text-red-800 px-3 py-2 text-sm mb-4'>
            {loginError}
          </div>
        )}

        <form onSubmit={handleSubmit} className='space-y-4'>
          <div>
            <label htmlFor='email' className='block text-sm font-medium mb-1'>Email</label>
            <input
              type='email'
              id='email'
              name='email'
              required
              className='w-full bg-parchment border border-rule px-3 py-2 text-sm font-mono focus:outline-none focus:border-ink'
            />
          </div>
          <div>
            <label htmlFor='password' className='block text-sm font-medium mb-1'>Password</label>
            <input
              type='password'
              id='password'
              name='password'
              required
              className='w-full bg-parchment border border-rule px-3 py-2 text-sm font-mono focus:outline-none focus:border-ink'
            />
          </div>
          <button
            type='submit'
            disabled={submitting}
            className='w-full bg-ink text-parchment py-2 text-sm font-medium hover:bg-ink-light transition-colors disabled:opacity-50'
          >
            {submitting ? 'Logging in…' : 'Log in'}
          </button>
        </form>

        <div className='flex items-center justify-between mt-4'>
          <p className='text-sm text-ink-muted'>
            Don't have an account? <Link to='/signup' className='text-link underline'>Sign up</Link>
          </p>
          <Link to='/forgot-password' className='text-sm text-link hover:underline'>Forgot password?</Link>
        </div>
      </div>
    </BaseLayout>
  )
}
