// During SSR, fetches to the app's own API must go through localhost to avoid
// TLS/DNS issues behind reverse proxies (Caddy tls internal, Docker networking).
// On the client, use the page origin so the browser handles cookies and TLS normally.
export function fetchBase(requestUrl: string): string {
  if (import.meta.env.SSR) {
    return `http://127.0.0.1:${process.env.PORT || 3000}`
  }
  return new URL(requestUrl).origin
}
