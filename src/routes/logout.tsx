import { useEffect } from 'react'

import BaseLayout from '~/components/BaseLayout'
import { authClient } from '~/lib/auth-client'
import { useSSRData } from '~/lib/ssr-data'

export default function LogoutPage() {
  const kfAuthUrl = useSSRData<string>('kfAuthUrl')

  useEffect(() => {
    authClient.signOut().then(() => {
      const appHomeUrl = window.location.origin
      const signoutUrl = kfAuthUrl
        ? `${kfAuthUrl}/auth/signout?redirect_uri=${encodeURIComponent(appHomeUrl)}`
        : '/'
      window.location.href = signoutUrl
    })
  }, [])

  return (
    <BaseLayout>
      <div className="mx-auto max-w-sm px-4 py-16 text-center">
        <p className="text-ink-muted text-sm">Signing out…</p>
      </div>
    </BaseLayout>
  )
}
