import type { LoaderFunctionArgs } from 'react-router'

import { fetchBase } from '~/lib/fetch-base'
import { apiUrlBuilder } from '~/lib/share-token'

export const handle = {
  title: (params: Record<string, string>) =>
    `Records — ${params.owner}/${params.collection} · Underlay`,
}

/** The latest-context records page: resolve the latest ready version, then load it. */
export async function loader({ params, request }: LoaderFunctionArgs) {
  const api = apiUrlBuilder(request, fetchBase(request.url))
  const headers = { Cookie: request.headers.get('Cookie') ?? '' }
  const prefix = `/api/collections/${params.owner}/${params.collection}`

  const collectionData = await fetch(api(prefix), { headers }).then((r) => (r.ok ? r.json() : null))
  if (!collectionData) throw new Response('Not Found', { status: 404 })

  const latest = collectionData.latestVersion?.semver
  const version = latest
    ? await fetch(api(`${prefix}/versions/${latest}`), { headers }).then((r) =>
        r.ok ? r.json() : null,
      )
    : null

  return { version, collectionData }
}
