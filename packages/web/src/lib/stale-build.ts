/**
 * Recovery from a deploy that lands while a tab is open. Route code is split
 * into hashed chunks, and a deploy replaces the whole asset set, so the old
 * page's next lazy import 404s. A full reload picks up the new build; the
 * address bar already shows the page that was clicked, so reloading lands there.
 *
 * At most one automatic reload per RELOAD_WINDOW_MS, kept in sessionStorage:
 * if the fresh page fails the same way (a broken build, not a stale one), the
 * error page offers a manual reload instead of looping.
 */

const RELOAD_KEY = 'underlay:stale-build-reload'
const RELOAD_WINDOW_MS = 10_000

// Chrome, Firefox and Safari word a failed dynamic import differently.
const STALE_MESSAGE =
  /dynamically imported module|importing a module script failed|unable to preload css/i

const preloadErrors = new WeakSet<object>()
let reloading = false

export function isStaleBuildError(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && preloadErrors.has(error)) return true
  return error instanceof Error && STALE_MESSAGE.test(error.message)
}

/** Whether an automatic reload is under way or allowed now. */
export function canReloadForStaleBuild(): boolean {
  if (reloading) return true
  if (typeof window === 'undefined' || !navigator.onLine) return false
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY))
    return !(last && Date.now() - last < RELOAD_WINDOW_MS)
  } catch {
    // No storage means no loop guard, so don't reload automatically.
    return false
  }
}

export function reloadForStaleBuild(): void {
  if (reloading || !canReloadForStaleBuild()) return
  try {
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
  } catch {
    return
  }
  reloading = true
  window.location.reload()
}

/**
 * Vite dispatches `vite:preloadError` when a lazy chunk (or its CSS) fails to
 * load. Reload straight away; the error still propagates, and the error
 * boundary recognises it and holds a quiet placeholder until the reload.
 */
export function listenForStaleBuild(): void {
  window.addEventListener('vite:preloadError', (event) => {
    const error = (event as Event & { payload?: unknown }).payload
    if (typeof error === 'object' && error !== null) preloadErrors.add(error)
    reloadForStaleBuild()
  })
}
