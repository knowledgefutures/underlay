import { useEffect } from 'react'

import BaseLayout from '~/components/BaseLayout'

export default function ResetPasswordPage() {
  useEffect(() => {
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
