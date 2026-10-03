import type { LoaderFunctionArgs } from 'react-router'

import { requireAuth } from '~/lib/auth-middleware'
import { features } from '~/lib/features'
import { apiFetch, fetchBase, ssrHeaders } from '~/lib/fetch-base'

export const middleware = [requireAuth]

export const handle = {
  title: (params: Record<string, string>) =>
    `Settings — ${params.owner}/${params.collection} · Underlay`,
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  const base = fetchBase(request.url)
  const headers = ssrHeaders(request)
  const prefix = `/api/collections/${params.owner}/${params.collection}`

  const [data, arkSettings, webhooksResult] = await Promise.all([
    apiFetch(new URL(prefix, base), { headers }).then((r) => (r.ok ? r.json() : null)),
    features.ark
      ? apiFetch(new URL(`${prefix}/ark`, base), { headers }).then((r) =>
          r.ok ? r.json() : { enabled: false, customUrl: null, arkUrl: null },
        )
      : { enabled: false, customUrl: null, arkUrl: null },
    apiFetch(new URL(`${prefix}/webhooks`, base), { headers }).then((r) =>
      r.ok ? r.json() : { webhooks: [] },
    ),
  ])

  if (!data) throw new Response('Not Found', { status: 404 })
  return { data, arkSettings, webhooks: webhooksResult.webhooks ?? [] }
}
