import type { LoaderFunctionArgs } from 'react-router'

import { requireAuth } from '~/lib/auth-middleware'
import { loaderApi } from '~/lib/fetch-base'

export const middleware = [requireAuth]
export const handle = { title: 'Dashboard · Underlay' }

export async function loader({ request }: LoaderFunctionArgs) {
  // One request for everything: the caller's collections (private included),
  // enriched with stats, plus per-org counts for the facet rail.
  const params = new URLSearchParams({ mine: 'true', limit: '100' })
  const org = new URL(request.url).searchParams.get('org')
  if (org) params.set('owner', org)

  const data = await loaderApi(request).json<any>(`/api/collections?${params}`, {})
  return {
    collections: data.collections ?? [],
    owners: data.facets?.owners ?? [],
  }
}
