import type { LoaderFunctionArgs } from 'react-router'

import { requireAuth } from '~/lib/auth-middleware'
import { loaderApi } from '~/lib/fetch-base'

export const middleware = [requireAuth]

export const handle = {
  title: (params: Record<string, string>) => `Settings — ${params.owner} · Underlay`,
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  const api = loaderApi(request)

  const [orgData, kfOrgs] = await Promise.all([
    api.json(`/api/accounts/${params.owner}`, null),
    api.json('/api/accounts/available-kf-orgs', []),
  ])

  if (!orgData) throw new Response('Not Found', { status: 404 })
  return { orgData, kfOrgs: Array.isArray(kfOrgs) ? kfOrgs : [] }
}
