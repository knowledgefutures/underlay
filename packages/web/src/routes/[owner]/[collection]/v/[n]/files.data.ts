import { redirect, type LoaderFunctionArgs } from 'react-router'

/** Legacy route: the Files tab is now Assets. */
export async function loader({ params, request }: LoaderFunctionArgs) {
  const url = new URL(request.url)
  const bare = (params.n ?? '').replace(/^v/, '')
  throw redirect(`/${params.owner}/${params.collection}/v/${bare}/assets${url.search}`, 301)
}
