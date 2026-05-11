import { useEffect } from 'react'
import BaseLayout from '~/components/BaseLayout'

export default function LogoutPage() {
  useEffect(() => {
    // Loader handles session cleanup and redirects to /login
    // This is a fallback in case the redirect doesn't happen server-side
    window.location.href = '/login'
  }, [])

  return (
    <BaseLayout>
      <div className="max-w-sm mx-auto px-4 py-16 text-center">
        <p className="text-sm text-ink-muted">Logging out…</p>
      </div>
    </BaseLayout>
  )
}
