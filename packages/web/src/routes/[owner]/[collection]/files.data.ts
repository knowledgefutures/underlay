import type { LoaderFunctionArgs } from 'react-router'

import { apiFetch, fetchBase, ssrHeaders } from '~/lib/fetch-base'
import { apiUrlBuilder } from '~/lib/share-token'

export const handle = {
  title: (params: Record<string, string>) =>
    `Files — ${params.owner}/${params.collection} · Underlay`,
}

/** The latest-context files page: resolve the latest ready version, then load it. */
export async function loader({ params, request }: LoaderFunctionArgs) {
  const api = apiUrlBuilder(request, fetchBase(request.url))
  const headers = ssrHeaders(request)
  const prefix = `/api/collections/${params.owner}/${params.collection}`

  // Both at once: `latest` resolves the head on the server (a 404 when there is none).
  const [collectionData, version] = await Promise.all([
    apiFetch(api(prefix), { headers }).then((r) => (r.ok ? r.json() : null)),
    apiFetch(api(`${prefix}/versions/latest`), { headers }).then((r) => (r.ok ? r.json() : null)),
  ])
  if (!collectionData) throw new Response('Not Found', { status: 404 })

  return { version, collectionData }
}
