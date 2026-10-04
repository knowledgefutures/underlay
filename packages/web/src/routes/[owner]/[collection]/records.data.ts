import type { LoaderFunctionArgs } from 'react-router'

import { loaderApi } from '~/lib/fetch-base'
import { loadRecordsPage } from '~/lib/records-page'

export const handle = {
  title: (params: Record<string, string>) =>
    `Records — ${params.owner}/${params.collection} · Underlay`,
}

/** The latest-context records page: resolve the latest ready version, then load it. */
export async function loader({ params, request }: LoaderFunctionArgs) {
  const api = loaderApi(request, { share: true })
  const prefix = `/api/collections/${params.owner}/${params.collection}`

  // Both at once: `latest` resolves the head on the server (a 404 when there is none).
  const [collectionData, version] = await Promise.all([
    api.json(prefix, null),
    api.json(`${prefix}/versions/latest`, null),
  ])
  if (!collectionData) throw new Response('Not Found', { status: 404 })

  const records = version ? await loadRecordsPage(api, prefix, version, request.url) : null
  return { version, collectionData, records }
}
