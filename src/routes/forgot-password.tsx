import { useEffect } from 'react'

import BaseLayout from '~/components/BaseLayout'

export const handle = { title: 'Forgot password — Underlay' }

export default function ForgotPasswordPage() {
  useEffect(() => {
    // Password management now happens via KF Auth
    window.location.href = '/login'
  }, [])

  return (
    <BaseLayout>
      <div className="mx-auto max-w-sm px-4 py-16 text-center">
        <p className="text-ink-muted text-sm">Redirecting to sign in...</p>
      </div>
    </BaseLayout>
  )
}
