import type { LoaderFunctionArgs } from 'react-router'

import { fetchBase } from '~/lib/fetch-base'
import { apiUrlBuilder } from '~/lib/share-token'

export const handle = {
  title: (params: Record<string, string>) =>
    `Schemas — ${params.owner}/${params.collection} · Underlay`,
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  const api = apiUrlBuilder(request, fetchBase(request.url))
  const headers = { Cookie: request.headers.get('Cookie') ?? '' }
  const prefix = `/api/collections/${params.owner}/${params.collection}`

  // Schemas are pinned per version; forward the page's ?version= selection.
  const version = new URL(request.url).searchParams.get('version')
  const schemasPath = version
    ? `${prefix}/schemas?version=${encodeURIComponent(version)}`
    : `${prefix}/schemas`

  const [data, schemas, versions] = await Promise.all([
    fetch(api(prefix), { headers }).then((r) => (r.ok ? r.json() : null)),
    fetch(api(schemasPath), { headers }).then((r) => (r.ok ? r.json() : null)),
    fetch(api(`${prefix}/versions?limit=100`), { headers }).then((r) => (r.ok ? r.json() : [])),
  ])

  if (!data) throw new Response('Not Found', { status: 404 })
  return { data, schemas, versions }
}
