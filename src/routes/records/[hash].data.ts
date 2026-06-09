import type { LoaderFunctionArgs } from 'react-router'

export const handle = {
  title: () => `Record · Underlay`,
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  const base = new URL(request.url).origin
  const headers = { Cookie: request.headers.get('Cookie') ?? '' }
  const res = await fetch(new URL(`/api/records/${params.hash}/provenance`, base), { headers })
  if (!res.ok) throw new Response('Not Found', { status: 404 })
  return res.json()
}
