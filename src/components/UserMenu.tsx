import { useCallback, useRef, useState } from 'react'
import { Link } from 'react-router'

import { useDismissable } from '~/lib/use-dismissable'

interface Org {
  slug: string
  displayName: string
  isDefault?: boolean
}

interface UserMenuProps {
  slug: string
  displayName?: string | null
  avatarUrl?: string | null
  orgs?: Org[]
  isSteward?: boolean
}

export default function UserMenu({
  slug,
  displayName,
  avatarUrl,
  orgs = [],
  isSteward = false,
}: UserMenuProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useDismissable(
    open,
    useCallback(() => setOpen(false), []),
    rootRef,
  )

  const initial = (displayName || slug || '?').charAt(0).toUpperCase()

  // Personal org first, then alphabetical — the raw membership order is arbitrary.
  const sortedOrgs = [...orgs].sort(
    (a, b) =>
      Number(b.isDefault ?? false) - Number(a.isDefault ?? false) ||
      a.displayName.localeCompare(b.displayName),
  )

  return (
    <div ref={rootRef} className="relative">
      <button
        className="bg-ink text-parchment flex h-7 w-7 cursor-pointer items-center justify-center overflow-hidden rounded-full text-xs font-semibold transition-opacity hover:opacity-80"
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Account menu"
      >
        {avatarUrl ? (
          <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          initial
        )}
      </button>
      {open && (
        <div className="absolute top-full right-0 z-50 pt-1">
          <div className="bg-parchment border-rule rounded-control min-w-48 overflow-hidden border shadow-sm">
            <Link
              to="/dashboard"
              className="text-ink-light hover:bg-parchment-dark block px-3 py-2 text-sm transition-colors"
              onClick={() => setOpen(false)}
            >
              Dashboard
            </Link>
            <Link
              to="/settings"
              className="text-ink-light hover:bg-parchment-dark block px-3 py-2 text-sm transition-colors"
              onClick={() => setOpen(false)}
            >
              Settings
            </Link>
            {isSteward && (
              <Link
                to="/superadmin"
                className="text-ink-light hover:bg-parchment-dark block px-3 py-2 text-sm transition-colors"
                onClick={() => setOpen(false)}
              >
                Admin
              </Link>
            )}
            {sortedOrgs.length > 0 && (
              <>
                <hr className="border-rule" />
                <p className="text-ink-muted px-3 pt-2 pb-1 text-[10px] font-semibold tracking-wide uppercase">
                  Your organizations
                </p>
                <div className="max-h-64 overflow-y-auto">
                  {sortedOrgs.map((org) => (
                    <Link
                      key={org.slug}
                      to={`/${org.slug}`}
                      className="text-ink-light hover:bg-parchment-dark block px-3 py-1.5 text-sm transition-colors"
                      onClick={() => setOpen(false)}
                    >
                      {org.displayName}
                      {org.isDefault && (
                        <span className="text-ink-muted ml-1 text-xs">(personal)</span>
                      )}
                    </Link>
                  ))}
                </div>
              </>
            )}
            <hr className="border-rule" />
            <Link
              to="/logout"
              className="text-ink-muted hover:bg-parchment-dark block px-3 py-2 text-sm transition-colors"
              onClick={() => setOpen(false)}
            >
              Sign out
            </Link>
          </div>
        </div>
      )}
    </div>
  )
}
