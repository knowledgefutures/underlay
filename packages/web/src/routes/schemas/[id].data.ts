import type { LoaderFunctionArgs } from 'react-router'

import { routeMissing } from '~/lib/features'
import { apiFetch, fetchBase, ssrHeaders } from '~/lib/fetch-base'
import { apiUrlBuilder } from '~/lib/share-token'

export const handle = {
  title: () => `Schema · Underlay`,
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  // Forward the share token so a shared-link viewer following a schema hash
  // out of a private collection keeps their access.
  const api = apiUrlBuilder(request, fetchBase(request.url))
  const headers = ssrHeaders(request)
  const res = await apiFetch(api(`/api/schemas/${params.id}`), { headers })
  // v2 has no schema routes yet: say so rather than claim the schema doesn't exist.
  if (await routeMissing(res)) return { unavailable: true }
  if (!res.ok) throw new Response('Not Found', { status: 404 })
  return res.json()
}
