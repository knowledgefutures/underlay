import type { LoaderFunctionArgs } from 'react-router'

import { loaderApi } from '~/lib/fetch-base'

export const handle = { title: 'Explore · Underlay' }

/**
 * The first list for the URL's filters, so it's in the SSR HTML. Later searches
 * and filter changes fetch from the browser (CollectionExplorer) without a
 * navigation, so this only runs on the initial load.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url)
  const params = new URLSearchParams()
  for (const key of ['q', 'owner', 'tag']) {
    const value = url.searchParams.get(key)
    if (value) params.set(key, value)
  }
  params.set('sort', url.searchParams.get('sort') ?? 'featured')
  return loaderApi(request).json(`/api/collections?${params}`, null)
}

// CollectionExplorer keeps the URL in step with its filters (replace navigations):
// those must not re-run the loader and refetch what the component already has.
export function shouldRevalidate({
  currentUrl,
  nextUrl,
  defaultShouldRevalidate,
}: {
  currentUrl: URL
  nextUrl: URL
  defaultShouldRevalidate: boolean
}) {
  return currentUrl.pathname === nextUrl.pathname ? false : defaultShouldRevalidate
}
