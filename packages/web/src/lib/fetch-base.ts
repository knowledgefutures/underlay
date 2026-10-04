/**
 * How loaders reach the app's own API.
 *
 * During SSR the request must not leave the process: a Worker can't fetch its
 * own zone, and on Node a loopback round trip is wasted work. renderPage
 * (entry-server.tsx) receives an in-process `api` function from the server and
 * makes it available here for the duration of one render, through
 * `setSsrApiResolver`. Loaders call `apiFetch`, which uses it during SSR and the
 * browser's fetch otherwise. The resolver lives in entry-server so this module
 * (bundled into the client) never imports node:async_hooks.
 */

export type ApiFn = (req: Request) => Promise<Response>

/** The origin SSR loaders build API URLs against. Never fetched over the network. */
export const SSR_ORIGIN = 'http://underlay.internal'

let resolveSsrApi: () => ApiFn | undefined = () => undefined

/** Called once by entry-server with a lookup of the current render's `api`. */
export function setSsrApiResolver(resolver: () => ApiFn | undefined): void {
  resolveSsrApi = resolver
}

/** fetch for the app's own API: in-process during SSR, the network in the browser. */
export function apiFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  if (import.meta.env.SSR) {
    const api = resolveSsrApi()
    if (api) return api(new Request(new URL(input, SSR_ORIGIN), init))
  }
  return fetch(input, init)
}

// During SSR the origin is a fixed internal one that apiFetch hands to the
// in-process API. On the client, use the page origin so the browser handles
// cookies and TLS normally.
export function fetchBase(requestUrl: string): string {
  if (import.meta.env.SSR) return SSR_ORIGIN
  return new URL(requestUrl).origin
}

// Headers identifying the original client, carried over when the server calls its
// own API. Without the forwarding headers every anonymous SSR fetch would look
// like the same client to anything that keys on the caller's address.
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

export interface LoaderApi {
  /** GET `path` on behalf of the page's request. */
  get(path: string): Promise<Response>
  /** GET `path`'s JSON body, or `fallback` when the response isn't ok. */
  json<T = any>(path: string, fallback: T): Promise<T>
}

/**
 * A loader's handle on the API: requests carry the page's cookies and client
 * address. With `share`, they also carry the page's `?token=` share key (the
 * API accepts it on GETs), so a shared-link viewer keeps their access across a
 * collection's pages. Leave it off for routes outside a collection.
 */
export function loaderApi(request: Request, { share = false } = {}): LoaderApi {
  const base = fetchBase(request.url)
  const token = share ? new URL(request.url).searchParams.get('token') : null
  const headers = ssrHeaders(request)
  const get = (path: string) => {
    const url = new URL(path, base)
    if (token) url.searchParams.set('token', token)
    return apiFetch(url, { headers })
  }
  return {
    get,
    json: async (path, fallback) => {
      const res = await get(path)
      return res.ok ? res.json() : fallback
    },
  }
}

/** The signed-in context (`/api/context`), or a signed-out one when the lookup fails. */
export async function fetchContext(
  request: Request,
): Promise<{ currentUser: any } & Record<string, unknown>> {
  return loaderApi(request).json('/api/context', {
    currentUser: null,
    kfAccountUrl: '',
    kfAuthUrl: '',
  })
}
