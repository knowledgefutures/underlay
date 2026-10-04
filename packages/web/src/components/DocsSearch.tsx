import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'

import { docSections } from '~/lib/docs-pages'

const docs = docSections.flatMap((s) => s.pages)

export default function DocsSearch() {
  const [query, setQuery] = useState('')
  const [showResults, setShowResults] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const q = query.trim().toLowerCase()

  const matches: { title: string; href: string; context?: string }[] = []
  if (q) {
    for (const doc of docs) {
      const titleMatch = doc.title.toLowerCase().includes(q)
      const headingMatches = doc.headings.filter((h) => h.toLowerCase().includes(q))
      if (titleMatch) {
        matches.push({ title: doc.title, href: doc.href })
      }
      for (const h of headingMatches) {
        if (!titleMatch || headingMatches.length > 0) {
          const slug = h
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/(^-|-$)/g, '')
          matches.push({ title: doc.title, href: `${doc.href}#${slug}`, context: h })
        }
      }
    }
  }

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setShowResults(false)
      }
    }
    document.addEventListener('click', handleClickOutside)
    return () => document.removeEventListener('click', handleClickOutside)
  }, [])

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      setShowResults(false)
      ;(e.target as HTMLInputElement).blur()
    }
  }

  return (
    <div ref={rootRef} className="docs-search-box">
      <input
        type="text"
        placeholder="Search docs..."
        aria-label="Search docs"
        autoComplete="off"
        className="border-rule bg-parchment placeholder:text-ink-muted/50 focus:border-ink-muted w-full border px-2.5 py-1.5 text-xs focus:outline-none"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setShowResults(true)
        }}
        onKeyDown={handleKeyDown}
      />
      {showResults && q && (
        <div id="docs-search-results">
          {matches.length === 0 ? (
            <div className="docs-search-empty">No results</div>
          ) : (
            matches.slice(0, 12).map((m, i) => (
              <Link key={i} to={m.href} className="docs-search-result">
                <span className="docs-search-result-title">{m.title}</span>
                {m.context && <span className="docs-search-result-context">{m.context}</span>}
              </Link>
            ))
          )}
        </div>
      )}
    </div>
  )
}
