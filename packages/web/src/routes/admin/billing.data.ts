import type { LoaderFunctionArgs } from 'react-router'

import { requireAuth } from '~/lib/auth-middleware'
import { loaderApi } from '~/lib/fetch-base'

export const middleware = [requireAuth]
export const handle = { title: 'Billing · Admin · Underlay' }

export function loader({ request }: LoaderFunctionArgs) {
  const month = new URL(request.url).searchParams.get('month')
  const query = month ? `?month=${encodeURIComponent(month)}` : ''
  return loaderApi(request).json(`/api/admin/stats/billing${query}`, null)
}
