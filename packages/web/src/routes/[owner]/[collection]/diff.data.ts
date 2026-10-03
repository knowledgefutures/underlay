import { redirect, type LoaderFunctionArgs } from 'react-router'

/** Legacy route: diff moved to /versions/compare. */
export async function loader({ params, request }: LoaderFunctionArgs) {
  const url = new URL(request.url)
  throw redirect(`/${params.owner}/${params.collection}/versions/compare${url.search}`)
}
