import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'

interface Org {
  slug: string
  displayName: string
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

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('click', handleClickOutside)
    return () => document.removeEventListener('click', handleClickOutside)
  }, [])

  const initial = (displayName || slug || '?').charAt(0).toUpperCase()

  return (
    <div ref={rootRef} className="relative">
      <button
        className="bg-ink text-parchment flex h-7 w-7 cursor-pointer items-center justify-center overflow-hidden rounded-full text-xs font-semibold transition-opacity hover:opacity-80"
        type="button"
        onClick={() => setOpen((v) => !v)}
      >
        {avatarUrl ? (
          <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          initial
        )}
      </button>
      {open && (
        <div className="absolute top-full right-0 z-50 pt-1">
          <div className="bg-parchment border-rule min-w-48 border shadow-sm">
            <Link
              to={`/${slug}`}
              className="text-ink-light hover:bg-parchment-dark block px-3 py-2 text-sm transition-colors"
              onClick={() => setOpen(false)}
            >
              Your Profile
            </Link>
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
            {orgs.length > 0 && (
              <>
                <hr className="border-rule" />
                <p className="text-ink-muted px-3 pt-2 pb-1 text-[10px] font-semibold tracking-wide uppercase">
                  Your organizations
                </p>
                {orgs.map((org) => (
                  <Link
                    key={org.slug}
                    to={`/${org.slug}`}
                    className="text-ink-light hover:bg-parchment-dark block px-3 py-1.5 text-sm transition-colors"
                    onClick={() => setOpen(false)}
                  >
                    {org.displayName}
                  </Link>
                ))}
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
