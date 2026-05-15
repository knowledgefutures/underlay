import { useEffect, } from 'react'
import BaseLayout from '~/components/BaseLayout'
import { useSSRData, } from '~/lib/ssr-data'

export default function LogoutPage() {
  const kfAuthUrl = useSSRData<string>('kfAuthUrl',)

  useEffect(() => {
    // Clear the local Underlay session, then redirect to KF Auth signout
    // so the IdP session is also cleared (prevents auto-re-login)
    fetch('/auth/logout', { method: 'POST', credentials: 'include', },)
      .finally(() => {
        const appHomeUrl = window.location.origin
        const signoutUrl = kfAuthUrl
          ? `${kfAuthUrl}/auth/signout?redirect_uri=${encodeURIComponent(appHomeUrl,)}`
          : '/'
        window.location.href = signoutUrl
      },)
  }, [],)

  return (
    <BaseLayout>
      <div className='max-w-sm mx-auto px-4 py-16 text-center'>
        <p className='text-sm text-ink-muted'>Signing out…</p>
      </div>
    </BaseLayout>
  )
}
