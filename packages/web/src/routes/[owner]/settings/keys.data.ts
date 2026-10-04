import type { LoaderFunctionArgs } from 'react-router'

import { requireAuth } from '~/lib/auth-middleware'
import { loaderApi } from '~/lib/fetch-base'

export const middleware = [requireAuth]

export const handle = {
  title: (params: Record<string, string>) => `API Keys — ${params.owner} · Underlay`,
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  return {
    collections: await loaderApi(request).json(`/api/accounts/${params.owner}/collections`, []),
  }
}
