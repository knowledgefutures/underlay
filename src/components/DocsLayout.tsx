import { Link, useLocation } from 'react-router'

import BaseLayout from '~/components/BaseLayout'
import DocsSearch from '~/components/DocsSearch'

const nav = [
  {
    section: 'Getting started',
    items: [
      { label: 'Overview', href: '/docs' },
      { label: 'Concepts', href: '/docs/concepts' },
      { label: 'Quickstart', href: '/docs/quickstart' },
      { label: 'Integration Guide', href: '/docs/integration' },
    ],
  },
  {
    section: 'API reference',
    items: [
      { label: 'Accounts', href: '/docs/api/accounts' },
      { label: 'Collections', href: '/docs/api/collections' },
      { label: 'Versions', href: '/docs/api/versions' },
      { label: 'Files', href: '/docs/api/files' },
    ],
  },
  {
    section: 'Infrastructure',
    items: [{ label: 'Self-hosting', href: '/docs/self-host' }],
  },
  {
    section: 'Specification',
    items: [{ label: 'Protocol', href: '/protocol' }],
  },
]

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
              {nav.map((group) => (
                <div key={group.section} className="docs-nav-group">
                  <p className="docs-nav-heading">{group.section}</p>
                  <ul>
                    {group.items.map((item) => (
                      <li key={item.href}>
                        <Link
                          to={item.href}
                          className={`docs-nav-link${currentPath === item.href ? ' active' : ''}`}
                        >
                          {item.label}
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
