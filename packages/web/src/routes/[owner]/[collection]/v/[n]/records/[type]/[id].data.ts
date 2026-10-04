import type { LoaderFunctionArgs } from 'react-router'

import { apiFetch, fetchBase, ssrHeaders } from '~/lib/fetch-base'
import { apiUrlBuilder } from '~/lib/share-token'

export const handle = {
  title: (params: Record<string, string>) =>
    `${params.type} ${params.id} — ${params.owner}/${params.collection} · Underlay`,
}

/** One record at a version, with its history in the collection and the collection's nav data. */
export async function loader({ params, request }: LoaderFunctionArgs) {
  const api = apiUrlBuilder(request, fetchBase(request.url))
  const headers = ssrHeaders(request)
  const prefix = `/api/collections/${params.owner}/${params.collection}`
  const type = encodeURIComponent(params.type ?? '')
  const id = encodeURIComponent(params.id ?? '')
  const json = (r: Response) => (r.ok ? r.json() : null)
  const [record, history, collectionData] = await Promise.all([
    apiFetch(api(`${prefix}/versions/${params.n}/records/${type}/${id}`), { headers }).then(json),
    apiFetch(api(`${prefix}/records/${type}/${id}/history`), { headers }).then(json),
    apiFetch(api(prefix), { headers }).then(json),
  ])
  if (!record) throw new Response('Not Found', { status: 404 })
  return { record, history, collectionData }
}
