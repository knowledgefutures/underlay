import type { LoaderFunctionArgs } from 'react-router'

import { requireAuth } from '~/lib/auth-middleware'
import { loaderApi } from '~/lib/fetch-base'

export const middleware = [requireAuth]
export const handle = {
  title: (params: Record<string, string>) => `${params.slug} · Admin · Underlay`,
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  const days = new URL(request.url).searchParams.get('days') ?? '30'
  const slug = encodeURIComponent(params.slug ?? '')
  const api = loaderApi(request)
  const [stats, ark] = await Promise.all([
    api.json(`/api/admin/stats/orgs/${slug}?days=${encodeURIComponent(days)}`, null),
    api.json(`/api/admin/accounts/${slug}/ark`, null),
  ])
  return stats ? { ...(stats as object), ark } : null
}
