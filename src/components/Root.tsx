import { Suspense, useEffect } from 'react'
import { Outlet, ScrollRestoration, useMatches } from 'react-router'

import { AppErrorBoundary } from '~/components/NotFound'

function DocumentTitle() {
  const matches = useMatches()

  useEffect(() => {
    let found = false
    for (let i = matches.length - 1; i >= 0; i--) {
      const { handle, params, data } = matches[i] as {
        handle?: { title?: string | ((p: Record<string, string>, d: unknown) => string) }
        params: Record<string, string>
        data: unknown
      }
      if (handle?.title) {
        document.title =
          typeof handle.title === 'function' ? handle.title(params, data) : handle.title
        found = true
        break
      }
    }
    if (!found) document.title = 'Underlay'
  }, [matches])

  return null
}

export default function Root() {
  return (
    <AppErrorBoundary>
      <DocumentTitle />
      {/* Without this, RouterProvider leaves the scroll position alone, so
          following a link while scrolled down lands you mid-page. Keyed per
          history entry (the default): new navigations go to the top, back and
          forward restore where you were. */}
      <ScrollRestoration />
      <Suspense>
        <Outlet />
      </Suspense>
    </AppErrorBoundary>
  )
}
