import { redirect, type LoaderFunctionArgs } from 'react-router'

import { loaderApi } from '~/lib/fetch-base'

export const handle = {
  title: (params: Record<string, string>) =>
    `Files ${params.n} — ${params.owner}/${params.collection} · Underlay`,
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  // Canonicalize the legacy double-v form (/v/v1.0.0 → /v/1.0.0).
  if (/^v\d/.test(params.n ?? '')) {
    const url = new URL(request.url)
    const bare = (params.n ?? '').replace(/^v/, '')
    throw redirect(`/${params.owner}/${params.collection}/v/${bare}/files${url.search}`)
  }

  const api = loaderApi(request, { share: true })
  const prefix = `/api/collections/${params.owner}/${params.collection}`

  const [version, collectionData] = await Promise.all([
    api.json(`${prefix}/versions/${params.n}`, null),
    api.json(prefix, null),
  ])

  if (!version) throw new Response('Not Found', { status: 404 })
  return { version, collectionData }
}
