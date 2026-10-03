import { useCallback, useRef, useState } from 'react'
import { Link } from 'react-router'

import { useDismissable } from '~/lib/use-dismissable'

export default function CreateMenu() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useDismissable(
    open,
    useCallback(() => setOpen(false), []),
    ref,
  )

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="border-rule bg-parchment-dark hover:bg-rule/30 rounded-control cursor-pointer border px-2.5 py-1 text-xs transition-colors"
      >
        New +
      </button>
      {open && (
        <div className="bg-parchment border-rule rounded-control absolute top-full right-0 z-50 mt-1.5 min-w-[10rem] overflow-hidden border shadow-sm">
          <Link
            to="/new"
            onClick={() => setOpen(false)}
            className="text-ink hover:bg-parchment-dark block px-3 py-2 text-sm transition-colors"
          >
            New collection
          </Link>
          <Link
            to="/new-org"
            onClick={() => setOpen(false)}
            className="text-ink hover:bg-parchment-dark block px-3 py-2 text-sm transition-colors"
          >
            New organization
          </Link>
        </div>
      )}
    </div>
  )
}
