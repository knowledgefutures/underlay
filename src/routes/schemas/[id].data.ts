import type { LoaderFunctionArgs } from 'react-router'

import { fetchBase } from '~/lib/fetch-base'
import { apiUrlBuilder } from '~/lib/share-token'

export const handle = {
  title: () => `Schema · Underlay`,
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  // Forward the share token so a shared-link viewer following a schema hash
  // out of a private collection keeps their access.
  const api = apiUrlBuilder(request, fetchBase(request.url))
  const headers = { Cookie: request.headers.get('Cookie') ?? '' }
  const res = await fetch(api(`/api/schemas/${params.id}`), { headers })
  if (!res.ok) throw new Response('Not Found', { status: 404 })
  return res.json()
}
