import type { LoaderFunctionArgs } from 'react-router'

import { fetchBase } from '~/lib/fetch-base'
import { apiUrlBuilder } from '~/lib/share-token'

export const handle = {
  title: (params: Record<string, string>) =>
    `Version ${params.n} — ${params.owner}/${params.collection} · Underlay`,
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  const api = apiUrlBuilder(request, fetchBase(request.url))
  const headers = { Cookie: request.headers.get('Cookie') ?? '' }
  const prefix = `/api/collections/${params.owner}/${params.collection}`

  const [version, collectionData] = await Promise.all([
    fetch(api(`${prefix}/versions/${params.n}`), { headers }).then((r) => (r.ok ? r.json() : null)),
    fetch(api(prefix), { headers }).then((r) => (r.ok ? r.json() : null)),
  ])

  if (!version) throw new Response('Not Found', { status: 404 })
  return { version, collectionData }
}
