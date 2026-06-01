import { hydrateRoot } from 'react-dom/client'
import { createBrowserRouter, matchRoutes, RouterProvider } from 'react-router'

import { routes } from '~/App'

import '~/global.css'

// Resolve matched lazy routes before hydrating to prevent server/client mismatch.
// On the server, createStaticHandler.query() resolves lazy routes before rendering.
// The client must do the same before hydrateRoot, otherwise RouterProvider renders
// null while lazy modules load, causing React to see a mismatch and double-render.
const matched = matchRoutes(routes, window.location)
if (matched) {
  await Promise.all(
    matched.map(async (m) => {
      if (m.route.lazy && typeof m.route.lazy === 'function') {
        const resolved = await (m.route.lazy as () => Promise<Record<string, unknown>>)()
        Object.assign(m.route, resolved)
        delete m.route.lazy
      }
    }),
  )
}

const hydrationData = (window as any).__staticRouterHydrationData

const router = createBrowserRouter(routes, { hydrationData })

router.subscribe((state) => {
  const matches = state.matches
  for (let i = matches.length - 1; i >= 0; i--) {
    const handle = matches[i]?.route?.handle as {
      title?: string | ((params: Record<string, string>, loaderData: unknown) => string)
    } | null
    if (handle?.title) {
      const title =
        typeof handle.title === 'function'
          ? handle.title(matches[i]!.params as Record<string, string>, (state as any).loaderData)
          : handle.title
      if (title) {
        document.title = title
        break
      }
    }
  }
})

hydrateRoot(document.getElementById('root')!, <RouterProvider router={router} />)
