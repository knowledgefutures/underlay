import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'

interface Org {
  slug: string
  displayName: string
}

interface UserMenuProps {
  slug: string
  displayName?: string | null
  orgs?: Org[]
}

export default function UserMenu({ slug, displayName, orgs = [] }: UserMenuProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const hideTimeout = useRef<ReturnType<typeof setTimeout>>(undefined)

  function show() {
    clearTimeout(hideTimeout.current)
    setOpen(true)
  }

  function scheduleHide() {
    hideTimeout.current = setTimeout(() => setOpen(false), 150)
  }

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('click', handleClickOutside)
    return () => document.removeEventListener('click', handleClickOutside)
  }, [])

  return (
    <div ref={rootRef} className="relative" onMouseEnter={show} onMouseLeave={scheduleHide}>
      <button
        className="hover:text-ink text-ink cursor-pointer font-medium transition-colors"
        type="button"
        onClick={() => setOpen((v) => !v)}
      >
        {displayName || slug} ▾
      </button>
      {open && (
        <div className="absolute top-full right-0 z-50 pt-1">
          <div className="bg-parchment border-rule min-w-48 border shadow-sm">
            <Link
              to={`/${slug}`}
              className="text-ink-light hover:bg-parchment-dark block px-3 py-2 text-sm transition-colors"
            >
              Your Profile
            </Link>
            <Link
              to="/dashboard"
              className="text-ink-light hover:bg-parchment-dark block px-3 py-2 text-sm transition-colors"
            >
              Dashboard
            </Link>
            <Link
              to="/settings"
              className="text-ink-light hover:bg-parchment-dark block px-3 py-2 text-sm transition-colors"
            >
              Settings
            </Link>
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
            >
              Sign out
            </Link>
          </div>
        </div>
      )}
    </div>
  )
}
