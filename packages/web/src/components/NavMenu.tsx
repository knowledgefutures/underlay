import { useCallback, useRef, useState } from 'react'
import { Link } from 'react-router'

import { UNDERLAY_UPDATES_URL } from '~/lib/kf-updates'
import { useDismissable } from '~/lib/use-dismissable'

const item = 'text-ink hover:bg-parchment-dark block px-3 py-2 text-sm transition-colors'

/** The header's site links in a menu, for narrow screens. */
export default function NavMenu() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])

  useDismissable(open, close, ref)

  return (
    <div ref={ref} className="relative sm:hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Menu"
        className="hover:text-ink flex cursor-pointer items-center p-1 transition-colors"
      >
        <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeWidth={2} d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      </button>
      {open && (
        <div className="bg-parchment border-rule rounded-control absolute top-full right-0 z-50 mt-1.5 min-w-[10rem] overflow-hidden border shadow-sm">
          <Link to="/explore" onClick={close} className={item}>
            Explore
          </Link>
          <Link to="/docs" onClick={close} className={item}>
            Docs
          </Link>
          <a href={UNDERLAY_UPDATES_URL} onClick={close} className={item}>
            Updates
          </a>
        </div>
      )}
    </div>
  )
}
