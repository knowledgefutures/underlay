import { useEffect, } from 'react'
import BaseLayout from '~/components/BaseLayout'

export default function ResetPasswordPage() {
  useEffect(() => {
    window.location.href = '/auth/login'
  }, [],)

  return (
    <BaseLayout>
      <div className='max-w-sm mx-auto px-4 py-16 text-center'>
        <p className='text-sm text-ink-muted'>Redirecting to sign in...</p>
      </div>
    </BaseLayout>
  )
}
