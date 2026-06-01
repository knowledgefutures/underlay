import { hydrateRoot } from 'react-dom/client'
import { createBrowserRouter, matchRoutes, RouterProvider } from 'react-router'

import { routes } from '~/App'
import { extractRouteMeta } from '~/lib/route-meta'

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
  const { title } = extractRouteMeta(
    state.matches as Array<{ params: Record<string, string>; route: { handle?: unknown } }>,
    (state as any).loaderData,
  )
  if (title) document.title = title
})

hydrateRoot(document.getElementById('root')!, <RouterProvider router={router} />)
