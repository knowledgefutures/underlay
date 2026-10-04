import type { LoaderFunctionArgs } from 'react-router'

import { requireAuth } from '~/lib/auth-middleware'
import { loaderApi } from '~/lib/fetch-base'

export const middleware = [requireAuth]

export const handle = {
  title: (params: Record<string, string>) =>
    `Settings — ${params.owner}/${params.collection} · Underlay`,
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  const api = loaderApi(request)
  const prefix = `/api/collections/${params.owner}/${params.collection}`

  const [data, arkSettings, webhooksResult, placements, locations] = await Promise.all([
    api.json(prefix, null),
    api.json(`${prefix}/ark`, { enabled: false, customUrl: null, arkUrl: null }),
    api.json(`${prefix}/webhooks`, { webhooks: [] }),
    api.json(`${prefix}/placements`, { headSeq: 0, placements: [] }),
    // Owners and admins only; anyone else gets 403 and no add-mirror form.
    api.json(`/api/orgs/${params.owner}/locations`, { locations: [] }),
  ])

  if (!data) throw new Response('Not Found', { status: 404 })
  return {
    data,
    arkSettings,
    webhooks: webhooksResult.webhooks ?? [],
    placements,
    locations: locations.locations ?? [],
  }
}
