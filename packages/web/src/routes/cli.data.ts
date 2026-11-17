import type { LoaderFunctionArgs } from 'react-router'

export const handle = { title: 'The Underlay CLI · Underlay' }

/** The site's own address, so the install line names the server the page is on. */
export function loader({ request }: LoaderFunctionArgs) {
  const origin = new URL(request.url).origin
  return { origin, host: new URL(origin).host.replace(/^www\./, '') }
}
