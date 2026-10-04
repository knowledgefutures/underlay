import type { LoaderFunctionArgs } from 'react-router'

import { loaderApi } from '~/lib/fetch-base'

export const handle = {
  title: (params: Record<string, string>) =>
    `${params.type} ${params.id} — ${params.owner}/${params.collection} · Underlay`,
}

/** One record at a version, with its history in the collection and the collection's nav data. */
export async function loader({ params, request }: LoaderFunctionArgs) {
  const api = loaderApi(request, { share: true })
  const prefix = `/api/collections/${params.owner}/${params.collection}`
  const type = encodeURIComponent(params.type ?? '')
  const id = encodeURIComponent(params.id ?? '')
  const [record, history, collectionData] = await Promise.all([
    api.json(`${prefix}/versions/${params.n}/records/${type}/${id}`, null),
    api.json(`${prefix}/records/${type}/${id}/history`, null),
    api.json(prefix, null),
  ])
  if (!record) throw new Response('Not Found', { status: 404 })
  return { record, history, collectionData }
}
