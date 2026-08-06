import type { LoaderFunctionArgs } from 'react-router'

import { requireAuth } from '~/lib/auth-middleware'
import { fetchBase } from '~/lib/fetch-base'

export const middleware = [requireAuth]
export const handle = { title: 'Dashboard · Underlay' }

export async function loader({ request }: LoaderFunctionArgs) {
  const base = fetchBase(request.url)
  const headers = { Cookie: request.headers.get('Cookie') ?? '' }

  // One request for everything: the caller's collections (private included),
  // enriched with stats, plus per-org counts for the facet rail.
  const params = new URLSearchParams({ mine: 'true', limit: '100' })
  const org = new URL(request.url).searchParams.get('org')
  if (org) params.set('owner', org)

  const res = await fetch(new URL(`/api/collections?${params}`, base), { headers })
  if (!res.ok) return { collections: [], owners: [] }
  const data = await res.json()
  return {
    collections: data.collections ?? [],
    owners: data.facets?.owners ?? [],
  }
}
