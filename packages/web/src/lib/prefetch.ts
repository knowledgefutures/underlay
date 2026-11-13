/**
 * Prefetch on intent. React Router's `prefetch="intent"` is for framework mode; this app
 * uses its data routers, so it is done here: when a pointer rests on a link to one of the
 * app's pages (or a finger touches it, or it takes focus), that page's loaders run early,
 * marked as a prefetch. Their API responses are held briefly and handed, once each, to the
 * navigation that follows, so the page appears without waiting on the network.
 *
 * Only what a prefetch fetched is held; a page's own loads never go through here. Each
 * held response is used at most once and only within `HOLD_MS`, so a page shown after a
 * save, or long after the hover, is fetched fresh. Links off the site, to the API, or to
 * pages that change state (log out, invitations, sign-in forms) are left alone.
 */
import { type LoaderFunctionArgs, matchRoutes, type RouteObject } from 'react-router'

/** Marks a loader's request as a prefetch (loaderApi reads it). */
export const PREFETCH_HEADER = 'x-underlay-prefetch'

/** How long a prefetched response waits for its navigation. */
const HOLD_MS = 10_000
/** How long a pointer must rest on a link before it counts as intent. */
const HOVER_MS = 80
/** A link prefetched this recently is not prefetched again. */
const AGAIN_MS = 5_000

const SKIP = /^\/(api|auth|logout|login|signup|invitations|forgot-password|reset-password)(\/|$)/

const held = new Map<string, { at: number; res: Response }>()
const recent = new Map<string, number>()

/** A prefetched response for this URL, taken (it is not handed out twice); null if none. */
export function takePrefetched(url: string): Promise<Response> | null {
  const e = held.get(url)
  if (!e) return null
  held.delete(url)
  return Date.now() - e.at < HOLD_MS ? Promise.resolve(e.res) : null
}

/** A prefetch's GET: fetched now, with an unread copy held for the navigation. */
export async function prefetchGet(url: string, init: RequestInit): Promise<Response> {
  const res = await fetch(url, init)
  if (res.ok) held.set(url, { at: Date.now(), res: res.clone() })
  for (const [k, v] of held) if (Date.now() - v.at >= HOLD_MS) held.delete(k)
  return res
}

function prefetch(routes: RouteObject[], href: string) {
  const url = new URL(href, location.href)
  if (url.origin !== location.origin || SKIP.test(url.pathname)) return
  if (url.pathname === location.pathname && url.search === location.search) return
  const key = url.pathname + url.search
  const last = recent.get(key)
  if (last && Date.now() - last < AGAIN_MS) return
  recent.set(key, Date.now())
  if (recent.size > 200) recent.clear()
  for (const m of matchRoutes(routes, url.pathname) ?? []) {
    const loader = m.route.loader
    if (typeof loader !== 'function') continue
    const request = new Request(url.href, { headers: { [PREFETCH_HEADER]: '1' } })
    // A loader that redirects, needs what a navigation's middleware provides, or fails is
    // simply not prefetched: the navigation runs it as usual.
    Promise.resolve()
      .then(() => loader({ request, params: m.params } as unknown as LoaderFunctionArgs))
      .catch(() => {})
  }
}

/** Start prefetching the pages links lead to, on intent. Call once, in the browser. */
export function listenForIntent(routes: RouteObject[]) {
  const conn = (navigator as { connection?: { saveData?: boolean } }).connection
  if (conn?.saveData) return
  const linkOf = (t: EventTarget | null) =>
    t instanceof Element ? (t.closest('a[href]') as HTMLAnchorElement | null) : null
  const usable = (a: HTMLAnchorElement | null): a is HTMLAnchorElement =>
    !!a && !a.hasAttribute('download') && (!a.target || a.target === '_self')
  let timer: ReturnType<typeof setTimeout> | undefined
  document.addEventListener(
    'mouseover',
    (e) => {
      const a = linkOf(e.target)
      if (!usable(a)) return
      clearTimeout(timer)
      timer = setTimeout(() => prefetch(routes, a.href), HOVER_MS)
    },
    { passive: true },
  )
  document.addEventListener('mouseout', () => clearTimeout(timer), { passive: true })
  for (const type of ['touchstart', 'focusin'] as const) {
    document.addEventListener(
      type,
      (e) => {
        const a = linkOf(e.target)
        if (usable(a)) prefetch(routes, a.href)
      },
      { passive: true },
    )
  }
}
