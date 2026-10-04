import type { LoaderFunctionArgs, RouteObject } from 'react-router'

import { RouteErrorBoundary } from '~/components/NotFound'
import Root from '~/components/Root'
import { fetchContext } from '~/lib/fetch-base'
import { buildDataRoutes } from '~/route-gen'

const components = import.meta.glob<{ default: React.ComponentType }>('./routes/**/[!_]*.tsx')
const dataModules = import.meta.glob<{
  loader?: RouteObject['loader']
  handle?: unknown
  middleware?: RouteObject['middleware']
  shouldRevalidate?: RouteObject['shouldRevalidate']
}>('./routes/**/*.data.ts', { eager: true })

function rootLoader({ request }: LoaderFunctionArgs) {
  return fetchContext(request)
}

const NotFound = () => import('~/routes/404').then((m) => ({ Component: m.default }))

// Unmatched paths render the 404 page with a 404 status (the static handler
// reports 200 for a matched splat route unless its loader says otherwise).
function notFoundLoader(): never {
  throw new Response('Not Found', { status: 404 })
}

export const routes: RouteObject[] = [
  {
    id: 'root',
    Component: Root,
    ErrorBoundary: RouteErrorBoundary,
    loader: rootLoader,
    children: [
      ...buildDataRoutes(components, dataModules),
      { path: '*', loader: notFoundLoader, lazy: NotFound },
    ],
  },
]
