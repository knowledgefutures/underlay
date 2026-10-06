import type { LoaderFunctionArgs } from 'react-router'

import { loaderApi } from '~/lib/fetch-base'

export const handle = {
  title: () => `Schema · Underlay`,
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  // Forward the share token so a shared-link viewer following a schema hash
  // out of a private collection keeps their access.
  const api = loaderApi(request, { share: true })
  const data = await api.json(`/api/schemas/${params.id}`, null)
  if (!data) throw new Response('Not Found', { status: 404 })
  return data
}
