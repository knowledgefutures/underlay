import { useEffect, } from 'react'
import BaseLayout from '~/components/BaseLayout'

export default function SignupPage() {
  useEffect(() => {
    // Account creation now happens via KF Auth
    window.location.href = '/auth/login'
  }, [],)

  return (
    <BaseLayout>
      <div className='max-w-sm mx-auto px-4 py-16 text-center'>
        <p className='text-sm text-ink-muted'>Redirecting to sign up...</p>
      </div>
    </BaseLayout>
  )
}
