import type { RouteObject } from 'react-router'

import Root from '~/components/Root'
import type { AppContext } from '~/lib/app-context'
import { buildDataRoutes } from '~/route-gen'

const modules = import.meta.glob<{ default: React.ComponentType; handle?: unknown }>(
  './routes/**/[!_]*.tsx',
)

const EMPTY_CONTEXT: AppContext = {
  currentUser: null,
  mirrorConfig: { enabled: false, upstream: '', nodeName: '', syncSchedule: '', apiKey: '' },
  kfAccountUrl: '',
  kfAuthUrl: '',
}

async function rootLoader({
  request,
  context,
}: {
  request: Request
  context?: { loadAppContext: (req: Request) => Promise<AppContext> }
}): Promise<AppContext> {
  // SSR: server passes loadAppContext via requestContext — direct DB access, no HTTP
  if (context?.loadAppContext) {
    return context.loadAppContext(request)
  }
  // Client navigation: fetch from server
  const res = await fetch(new URL('/api/context', request.url), {
    headers: { Cookie: request.headers.get('Cookie') ?? '' },
  })
  if (!res.ok) return EMPTY_CONTEXT
  return res.json()
}

const NotFound = () => import('~/routes/404').then((m) => ({ Component: m.default }))

export const routes: RouteObject[] = [
  {
    id: 'root',
    Component: Root,
    loader: rootLoader,
    children: [...buildDataRoutes(modules), { path: '*', lazy: NotFound }],
  },
]
