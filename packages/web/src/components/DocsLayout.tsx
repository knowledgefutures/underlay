import { Link, useLocation } from 'react-router'

import BaseLayout from '~/components/BaseLayout'
import DocsSearch from '~/components/DocsSearch'
import { docSections } from '~/lib/docs-pages'

export default function DocsLayout({
  children,
  title,
}: {
  children: React.ReactNode
  title: string
}) {
  const location = useLocation()
  const currentPath = location.pathname.replace(/\/$/, '')

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
          <h1 className="mb-6 font-sans text-xl font-semibold tracking-tight">{title}</h1>
          <div className="docs-prose">{children}</div>
        </div>
      </div>
    </BaseLayout>
  )
}

/** A code sample in the docs. */
export function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="bg-ink text-parchment rounded-surface overflow-x-auto p-3 text-xs">
      <code>{children}</code>
    </pre>
  )
}
