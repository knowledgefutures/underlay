import type { LoaderFunctionArgs } from 'react-router'

import { requireAuth } from '~/lib/auth-middleware'
import { loaderApi } from '~/lib/fetch-base'

export const middleware = [requireAuth]
export const handle = { title: 'Corpus · Admin · Underlay' }

export function loader({ request }: LoaderFunctionArgs) {
  return loaderApi(request).json('/api/admin/stats/corpus', null)
}
