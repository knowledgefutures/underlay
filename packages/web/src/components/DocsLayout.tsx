import { useEffect, useRef } from 'react'
import { Link, useLocation } from 'react-router'

import BaseLayout from '~/components/BaseLayout'
import DocsSearch from '~/components/DocsSearch'
import { docSections, headingSlug } from '~/lib/docs-pages'

export default function DocsLayout({
  children,
  title,
  eyebrow,
}: {
  children: React.ReactNode
  title: string
  /** A short line above the title, e.g. the protocol version a page describes. */
  eyebrow?: string
}) {
  const location = useLocation()
  const currentPath = location.pathname.replace(/\/$/, '')
  const prose = useRef<HTMLDivElement>(null)

  // Search links to headings by slug: give an h2 without an id its slug, then
  // scroll to the linked one (it may not have had an id when the page loaded).
  useEffect(() => {
    for (const h of prose.current?.querySelectorAll('h2:not([id])') ?? []) {
      h.id = headingSlug(h.textContent ?? '')
    }
    const id = decodeURIComponent(location.hash.slice(1))
    if (id) document.getElementById(id)?.scrollIntoView()
  }, [location.pathname, location.hash])

  return (
    <BaseLayout>
      <div className="docs-shell">
        <aside className="docs-sidebar">
          <div className="docs-sidebar-inner">
            <DocsSearch />

            <nav className="docs-nav">
              {docSections.map((group) => (
                <div key={group.section} className="docs-nav-group">
                  <p className="docs-nav-heading">{group.section}</p>
                  <ul>
                    {group.pages.map((page) => (
                      <li key={page.href}>
                        <Link
                          to={page.href}
                          className={`docs-nav-link${currentPath === page.href ? ' active' : ''}`}
                        >
                          {page.label ?? page.title}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </nav>
          </div>
        </aside>

        <div className="docs-main">
          {eyebrow && <p className="text-ink-muted mb-1 font-mono text-xs">{eyebrow}</p>}
          <h1 className="mb-6 font-sans text-xl font-semibold tracking-tight">{title}</h1>
          <div className="docs-prose" ref={prose}>
            {children}
          </div>
        </div>
      </div>
    </BaseLayout>
  )
}

/** A code sample in the docs. */
export function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="bg-ink text-parchment rounded-surface mb-3 overflow-x-auto p-3 text-xs">
      <code>{children}</code>
    </pre>
  )
}
