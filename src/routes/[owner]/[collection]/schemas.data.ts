import type { LoaderFunctionArgs } from 'react-router'

import { fetchBase } from '~/lib/fetch-base'

export const handle = {
  title: (params: Record<string, string>) =>
    `Schemas — ${params.owner}/${params.collection} · Underlay`,
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  const base = fetchBase(request.url)
  const headers = { Cookie: request.headers.get('Cookie') ?? '' }
  const prefix = `/api/collections/${params.owner}/${params.collection}`

  const [data, schemas] = await Promise.all([
    fetch(new URL(prefix, base), { headers }).then((r) => (r.ok ? r.json() : null)),
    fetch(new URL(`${prefix}/schemas`, base), { headers }).then((r) => (r.ok ? r.json() : null)),
  ])

  if (!data) throw new Response('Not Found', { status: 404 })
  return { data, schemas }
}
