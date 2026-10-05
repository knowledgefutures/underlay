import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'

import { Badge } from '~/components/ui'
import { bareSemver } from '~/lib/format'
import { TokenLink, useShareToken, withToken } from '~/lib/share-token'
import { useDismissable } from '~/lib/use-dismissable'

/**
 * Dropdown for switching between versions of a collection while staying on
 * the same kind of page. Fetches the version list lazily on first open.
 */
function VersionPicker({
  owner,
  collection,
  current,
  isLatest = false,
  to,
}: {
  owner: string
  collection: string
  current: string
  isLatest?: boolean
  /** Build the target URL for a version, preserving the current view. */
  to: (semver: string, targetIsLatest: boolean) => string
}) {
  const [open, setOpen] = useState(false)
  // Keyed by collection: the route stays mounted when navigating between two
  // collections, and must not show the previous one's versions.
  const listKey = `${owner}/${collection}`
  const [loaded, setLoaded] = useState<{ key: string; versions: any[] } | null>(null)
  const versions = loaded?.key === listKey ? loaded.versions : null
  const ref = useRef<HTMLDivElement>(null)
  const shareToken = useShareToken()

  useDismissable(
    open,
    useCallback(() => setOpen(false), []),
    ref,
  )

  useEffect(() => {
    if (!open || versions !== null) return
    fetch(withToken(`/api/collections/${owner}/${collection}/versions?limit=20`, shareToken), {
      credentials: 'include',
    })
      .then((r) => (r.ok ? r.json() : []))
      .then((body) =>
        setLoaded({ key: listKey, versions: Array.isArray(body) ? body : (body?.versions ?? []) }),
      )
      // A failed fetch shows an empty list (with "All versions") rather than
      // sticking on "Loading…".
      .catch(() => setLoaded({ key: listKey, versions: [] }))
  }, [open, versions, owner, collection, listKey, shareToken])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="border-rule bg-parchment-dark hover:bg-rule/30 rounded-control cursor-pointer border px-2 py-0.5 font-mono text-xs transition-colors"
        title="Switch version"
      >
        {current}
        {isLatest && <span className="text-ink-muted font-sans"> · latest</span>}{' '}
        <span className="text-ink-muted">▾</span>
      </button>
      {open && (
        <div className="bg-parchment border-rule rounded-control absolute top-full right-0 z-50 mt-1.5 max-h-72 min-w-[11rem] overflow-y-auto border shadow-sm">
          {versions === null ? (
            <p className="text-ink-muted px-3 py-2 text-xs">Loading…</p>
          ) : (
            <>
              {versions.map((v: any, i: number) => (
                <TokenLink
                  key={v.semver}
                  to={to(v.semver, i === 0)}
                  onClick={() => setOpen(false)}
                  className={`hover:bg-parchment-dark block px-3 py-1.5 font-mono text-xs transition-colors ${
                    v.semver === current ? 'text-ink font-semibold' : 'text-ink-light'
                  }`}
                >
                  {v.semver}
                  {i === 0 && <span className="text-ink-muted ml-1.5 font-sans">latest</span>}
                  {v.semver === current && <span className="text-ink-muted ml-1.5">✓</span>}
                </TokenLink>
              ))}
              <TokenLink
                to={`/${owner}/${collection}/versions`}
                onClick={() => setOpen(false)}
                className="text-link border-rule hover:bg-parchment-dark block border-t px-3 py-1.5 text-xs transition-colors"
              >
                All versions →
              </TokenLink>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Collection header, two rows:
 * - Top row is collection-wide: breadcrumb, visibility, Settings.
 * - Tab row is content: Overview / Records / Schemas / Files / Versions, with
 *   the version picker on its right edge scoping the version-aware tabs
 *   (Overview, Records, Schemas, Files). Versions is the full history.
 *   On a phone the tabs scroll sideways under the picker's own row.
 */
export function CollectionNav({
  owner,
  collection,
  isPublic,
  isOwner = false,
  active,
  version,
  isLatest = true,
}: {
  owner: string
  collection: string
  isPublic?: boolean
  isOwner?: boolean
  active: 'overview' | 'records' | 'schemas' | 'files' | 'versions'
  /** The version currently in context (defaults to latest). Absent on empty collections. */
  version?: string
  /** Whether the version in context is the latest ready version. */
  isLatest?: boolean
}) {
  // No -mb-px here: inside a scroll container it would overflow vertically by
  // 1px and make the row scrollable. The wrapper carries the offset instead.
  const linkClass =
    'shrink-0 whitespace-nowrap px-3 py-2 text-sm font-medium border-b-2 transition-colors'
  const activeClass = `${linkClass} border-ink text-ink`
  const inactiveClass = `${linkClass} border-transparent text-ink-muted hover:text-ink hover:border-rule`
  const shareToken = useShareToken()
  const [searchParams] = useSearchParams()

  // Version is a path prefix; views are path segments; latest is the default
  // when the prefix is absent. /acme/pubs/records vs /acme/pubs/v/1.0.0/records.
  const base = `/${owner}/${collection}`
  const prefix = isLatest || !version ? base : `${base}/v/${bareSemver(version)}`

  // Switching versions keeps you on the view you're looking at.
  function versionTo(semver: string, targetIsLatest: boolean): string {
    const target = targetIsLatest ? base : `${base}/v/${bareSemver(semver)}`
    switch (active) {
      case 'records': {
        const type = searchParams.get('type')
        return `${target}/records${type ? `?type=${encodeURIComponent(type)}` : ''}`
      }
      case 'schemas':
        return `${target}/schemas`
      case 'files':
        return `${target}/files`
      default:
        // overview, or a collection-level page like /versions
        return target
    }
  }

  return (
    <>
      <div className="mb-2 flex items-start justify-between gap-3">
        <nav className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-base sm:text-lg">
          <Link to={`/${owner}`} className="text-link whitespace-nowrap hover:underline">
            {owner}
          </Link>
          <span className="text-ink-muted">/</span>
          <TokenLink
            to={base}
            className="min-w-0 truncate font-semibold whitespace-nowrap hover:underline"
          >
            {collection}
          </TokenLink>
          {isPublic !== undefined && (
            <Badge className="sm:ml-2">{isPublic ? 'public' : 'private'}</Badge>
          )}
          {shareToken && !isOwner && (
            <Badge
              className="bg-parchment-dark"
              title="You are viewing this collection through a read-only shared link"
            >
              shared link
            </Badge>
          )}
        </nav>
        <div className="flex shrink-0 items-center gap-4 pt-1 text-sm">
          {isOwner && (
            <Link
              to={`${base}/settings`}
              className="text-ink-muted hover:text-ink transition-colors"
            >
              Settings
            </Link>
          )}
        </div>
      </div>
      <div className="border-rule mb-6 flex flex-wrap items-center gap-x-3 border-b">
        {/* Only the tabs scroll. The picker sits outside the scroll container:
            an overflow value other than visible clips absolutely-positioned
            descendants, which would cut off its dropdown. */}
        {/* -mb-px lifts the whole strip so the active tab's border covers the
            row rule. overflow-y-hidden because overflow-x-auto alone makes the
            y axis compute to auto, which rubber-bands on trackpads. */}
        <div className="order-2 -mb-px flex w-full min-w-0 items-center gap-0 overflow-x-auto overflow-y-hidden sm:order-none sm:w-auto">
          <TokenLink to={prefix} className={active === 'overview' ? activeClass : inactiveClass}>
            Overview
          </TokenLink>
          {version && (
            <TokenLink
              to={`${prefix}/records`}
              className={active === 'records' ? activeClass : inactiveClass}
            >
              Records
            </TokenLink>
          )}
          <TokenLink
            to={`${prefix}/schemas`}
            className={active === 'schemas' ? activeClass : inactiveClass}
          >
            Schemas
          </TokenLink>
          {version && (
            <TokenLink
              to={`${prefix}/files`}
              className={active === 'files' ? activeClass : inactiveClass}
            >
              Files
            </TokenLink>
          )}
          <TokenLink
            to={`${base}/versions`}
            className={active === 'versions' ? activeClass : inactiveClass}
          >
            Versions
          </TokenLink>
        </div>
        {version && (
          <div className="order-1 mb-1.5 ml-auto shrink-0 sm:order-none">
            <VersionPicker
              owner={owner}
              collection={collection}
              current={version}
              isLatest={isLatest}
              to={versionTo}
            />
          </div>
        )}
      </div>
    </>
  )
}
