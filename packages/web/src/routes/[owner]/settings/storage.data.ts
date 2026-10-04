import type { LoaderFunctionArgs } from 'react-router'

import { requireAuth } from '~/lib/auth-middleware'
import { apiFetch, fetchBase, ssrHeaders } from '~/lib/fetch-base'

export const middleware = [requireAuth]

export const handle = {
  title: (params: Record<string, string>) => `Storage — ${params.owner} · Underlay`,
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  const base = fetchBase(request.url)
  const headers = ssrHeaders(request)
  const prefix = `/api/orgs/${params.owner}`

  // Both are for owners and admins; anyone else gets 403 and the page says so.
  const [locations, placements] = await Promise.all([
    apiFetch(new URL(`${prefix}/locations`, base), { headers }),
    apiFetch(new URL(`${prefix}/placements`, base), { headers }),
  ])
  if (locations.status === 404) throw new Response('Not Found', { status: 404 })
  if (!locations.ok || !placements.ok) return { allowed: false, locations: [], placements: [] }
  return {
    allowed: true,
    locations: (await locations.json()).locations ?? [],
    placements: (await placements.json()).placements ?? [],
  }
}
