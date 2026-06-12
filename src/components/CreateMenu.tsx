import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'

export default function CreateMenu() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="border-rule bg-parchment-dark hover:bg-rule/30 cursor-pointer rounded border px-2.5 py-1 text-xs transition-colors"
      >
        New +
      </button>
      {open && (
        <div className="bg-parchment border-rule absolute top-full right-0 z-50 mt-1.5 min-w-[10rem] overflow-hidden rounded border shadow-sm">
          <Link
            to="/new"
            onClick={() => setOpen(false)}
            className="text-ink hover:bg-parchment-dark block px-3 py-2 text-sm transition-colors"
          >
            New collection
          </Link>
          <Link
            to="/dashboard?newOrg=1"
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
