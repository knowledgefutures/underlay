import type { LoaderFunctionArgs } from 'react-router'

import { routeMissing } from '~/lib/features'
import { apiFetch, fetchBase, ssrHeaders } from '~/lib/fetch-base'
import { apiUrlBuilder } from '~/lib/share-token'

export const handle = {
  title: () => `Record · Underlay`,
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  const api = apiUrlBuilder(request, fetchBase(request.url))
  const headers = ssrHeaders(request)
  const res = await apiFetch(api(`/api/records/${params.hash}/provenance`), { headers })
  // v2 has no provenance index yet: say so rather than claim the record doesn't exist.
  if (await routeMissing(res)) return { unavailable: true }
  if (!res.ok) throw new Response('Not Found', { status: 404 })
  return res.json()
}
