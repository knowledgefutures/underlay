import { useEffect } from 'react'

import BaseLayout from '~/components/BaseLayout'
import { useAppContext } from '~/lib/app-context'
import { authClient } from '~/lib/auth-client'

export const handle = { title: 'Log out — Underlay' }

export default function LogoutPage() {
  const { kfAuthUrl } = useAppContext()

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
