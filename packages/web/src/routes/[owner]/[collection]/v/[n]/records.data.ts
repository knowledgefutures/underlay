import { redirect, type LoaderFunctionArgs } from 'react-router'

import { loaderApi } from '~/lib/fetch-base'
import { loadVersionRecords } from '~/lib/records-page'

export const handle = {
  title: (params: Record<string, string>) =>
    `Records ${params.n} — ${params.owner}/${params.collection} · Underlay`,
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  // Canonicalize the legacy double-v form (/v/v1.0.0 → /v/1.0.0).
  if (/^v\d/.test(params.n ?? '')) {
    const url = new URL(request.url)
    const bare = (params.n ?? '').replace(/^v/, '')
    throw redirect(`/${params.owner}/${params.collection}/v/${bare}/records${url.search}`)
  }

  const api = loaderApi(request, { share: true })
  const prefix = `/api/collections/${params.owner}/${params.collection}`

  const [loaded, collectionData] = await Promise.all([
    loadVersionRecords(api, prefix, params.n!, request.url),
    api.json(prefix, null),
  ])

  if (!loaded) throw new Response('Not Found', { status: 404 })
  return { version: loaded.version, collectionData, records: loaded.records }
}
