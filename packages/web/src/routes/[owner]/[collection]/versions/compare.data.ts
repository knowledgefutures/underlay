import type { LoaderFunctionArgs } from 'react-router'

import { apiFetch, fetchBase, ssrHeaders } from '~/lib/fetch-base'
import { apiUrlBuilder } from '~/lib/share-token'

export const handle = {
  title: (params: Record<string, string>) =>
    `Compare — ${params.owner}/${params.collection} · Underlay`,
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  const api = apiUrlBuilder(request, fetchBase(request.url))
  const headers = ssrHeaders(request)
  const prefix = `/api/collections/${params.owner}/${params.collection}`

  const [data, versions] = await Promise.all([
    apiFetch(api(prefix), { headers }).then((r) => (r.ok ? r.json() : null)),
    apiFetch(api(`${prefix}/versions?limit=100`), { headers }).then((r) => (r.ok ? r.json() : [])),
  ])

  if (!data) throw new Response('Not Found', { status: 404 })
  return { data, versions }
}
