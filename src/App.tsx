import type { LoaderFunctionArgs, RouteObject } from 'react-router'

import Root from '~/components/Root'
import { buildDataRoutes } from '~/route-gen'

const components = import.meta.glob<{ default: React.ComponentType }>('./routes/**/[!_]*.tsx')
const dataModules = import.meta.glob<{
  loader?: RouteObject['loader']
  handle?: unknown
  middleware?: RouteObject['middleware']
}>('./routes/**/*.data.ts', { eager: true })

async function rootLoader({ request }: LoaderFunctionArgs) {
  const res = await fetch(new URL('/api/context', request.url), {
    headers: { Cookie: request.headers.get('Cookie') ?? '' },
  })
  if (!res.ok) {
    return {
      currentUser: null,
      mirrorConfig: { enabled: false, upstream: '', nodeName: '', syncSchedule: '', apiKey: '' },
      kfAccountUrl: '',
      kfAuthUrl: '',
    }
  }
  return res.json()
}

const NotFound = () => import('~/routes/404').then((m) => ({ Component: m.default }))

export const routes: RouteObject[] = [
  {
    id: 'root',
    Component: Root,
    loader: rootLoader,
    children: [...buildDataRoutes(components, dataModules), { path: '*', lazy: NotFound }],
  },
]
