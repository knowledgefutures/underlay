// During SSR, fetches to the app's own API must go through localhost to avoid
// TLS/DNS issues behind reverse proxies (Caddy tls internal, Docker networking).
// On the client, use the page origin so the browser handles cookies and TLS normally.
export function fetchBase(requestUrl: string): string {
  if (import.meta.env.SSR) {
    return `http://127.0.0.1:${process.env.PORT || 3000}`
  }
  return new URL(requestUrl).origin
}

// Headers identifying the original client, carried over when the server calls its
// own API. Without the forwarding headers every anonymous SSR fetch arrives from
// loopback and the rate limiter puts all visitors in one shared bucket.
const CLIENT_HEADERS = ['cf-connecting-ip', 'x-forwarded-for'] as const

/** The original client's address headers, for a server-side fetch on its behalf. */
export function clientHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const name of CLIENT_HEADERS) {
    const value = request.headers.get(name)
    if (value) headers[name] = value
  }
  return headers
}

/** Headers for an SSR-side fetch to the app's own API on behalf of `request`. */
export function ssrHeaders(request: Request): Record<string, string> {
  return { Cookie: request.headers.get('Cookie') ?? '', ...clientHeaders(request) }
}
