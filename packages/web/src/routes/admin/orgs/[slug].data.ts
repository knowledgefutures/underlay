import type { LoaderFunctionArgs } from 'react-router'

import { requireAuth } from '~/lib/auth-middleware'
import { loaderApi } from '~/lib/fetch-base'

export const middleware = [requireAuth]
export const handle = {
  title: (params: Record<string, string>) => `${params.slug} · Admin · Underlay`,
}

export function loader({ params, request }: LoaderFunctionArgs) {
  const days = new URL(request.url).searchParams.get('days') ?? '30'
  return loaderApi(request).json(
    `/api/admin/stats/orgs/${encodeURIComponent(params.slug ?? '')}?days=${encodeURIComponent(days)}`,
    null,
  )
}
