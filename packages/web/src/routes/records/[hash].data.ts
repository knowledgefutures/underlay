import type { LoaderFunctionArgs } from 'react-router'

import { loaderApi } from '~/lib/fetch-base'

export const handle = {
  title: () => `Record · Underlay`,
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  const api = loaderApi(request, { share: true })
  const data = await api.json(`/api/records/${params.hash}/provenance`, null)
  if (!data) throw new Response('Not Found', { status: 404 })
  return data
}
