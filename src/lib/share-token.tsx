import { Link, useSearchParams } from 'react-router'

/**
 * Read-only share links carry a collection-scoped API key in the page URL
 * (?token=ul_...). These helpers keep that token attached as the viewer
 * navigates between collection pages, and forward it to API requests.
 */

/** The share token from the current page URL, or null. */
export function useShareToken(): string | null {
  const [searchParams] = useSearchParams()
  return searchParams.get('token')
}

/** Append a share token to an internal path, preserving existing query params. */
export function withToken(to: string, token: string | null): string {
  if (!token) return to
  const sep = to.includes('?') ? '&' : '?'
  return `${to}${sep}token=${encodeURIComponent(token)}`
}

/**
 * Drop-in replacement for react-router's Link that carries the current share
 * token across page clicks. Use for links between pages of the same collection
 * so a shared-link viewer keeps their access as they navigate.
 */
export function TokenLink({ to, ...props }: React.ComponentProps<typeof Link>) {
  const token = useShareToken()
  return <Link to={typeof to === 'string' ? withToken(to, token) : to} {...props} />
}

/** Extract the share token from a loader's request URL, or null. */
export function shareTokenFromRequest(requestUrl: string): string | null {
  return new URL(requestUrl).searchParams.get('token')
}

/**
 * Loader helper: builds API URLs that forward the page's share token as a
 * ?token= query param (the API's auth middleware accepts it on GETs).
 */
export function apiUrlBuilder(request: Request, base: string): (path: string) => URL {
  const token = shareTokenFromRequest(request.url)
  return (path: string) => {
    const url = new URL(path, base)
    if (token) url.searchParams.set('token', token)
    return url
  }
}
