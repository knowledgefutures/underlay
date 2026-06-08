import { Suspense, useEffect } from 'react'
import { Outlet, useMatches } from 'react-router'

import { AppErrorBoundary } from '~/components/NotFound'

function DocumentTitle() {
  const matches = useMatches()

  useEffect(() => {
    for (let i = matches.length - 1; i >= 0; i--) {
      const { handle, params, data } = matches[i] as {
        handle?: { title?: string | ((p: Record<string, string>, d: unknown) => string) }
        params: Record<string, string>
        data: unknown
      }
      if (handle?.title) {
        document.title =
          typeof handle.title === 'function' ? handle.title(params, data) : handle.title
        break
      }
    }
  }, [matches])

  return null
}

export default function Root() {
  return (
    <AppErrorBoundary>
      <DocumentTitle />
      <Suspense>
        <Outlet />
      </Suspense>
    </AppErrorBoundary>
  )
}
