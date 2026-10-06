import { redirect, type LoaderFunctionArgs } from 'react-router'

import { loaderApi } from '~/lib/fetch-base'
import { loadSchemas } from '~/lib/schemas'

export const handle = {
  title: (params: Record<string, string>) =>
    `Schemas ${params.n} — ${params.owner}/${params.collection} · Underlay`,
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  // Canonicalize the legacy double-v form (/v/v1.0.0 → /v/1.0.0).
  if (/^v\d/.test(params.n ?? '')) {
    const url = new URL(request.url)
    const bare = (params.n ?? '').replace(/^v/, '')
    throw redirect(`/${params.owner}/${params.collection}/v/${bare}/schemas${url.search}`)
  }

  const api = loaderApi(request, { share: true })
  const prefix = `/api/collections/${params.owner}/${params.collection}`

  const [data, schemas] = await Promise.all([
    api.json(prefix, null),
    loadSchemas(api, prefix, params.n ?? ''),
  ])

  if (!data) throw new Response('Not Found', { status: 404 })
  return { data, schemas }
}
