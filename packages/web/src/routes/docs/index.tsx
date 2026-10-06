import { Link } from 'react-router'

import DocsLayout from '~/components/DocsLayout'
import { docSections } from '~/lib/docs-pages'

export default function Docs() {
  return (
    <DocsLayout title="Documentation">
      <p>
        Underlay has a small API surface. These docs are the SDK. Read them, point your LLM at them,
        or just curl the endpoints. For a machine-readable version, see{' '}
        <a href="/llms.txt" className="text-link underline">
          llms.txt
        </a>
        .
      </p>

      <nav className="space-y-5 text-sm">
        {docSections.map((group) => (
          <section key={group.section}>
            <h2>{group.section}</h2>
            <ul className="space-y-1 pl-0.5">
              {group.pages
                .filter((page) => page.href !== '/docs')
                .map((page) => (
                  <li key={page.href}>
                    <Link to={page.href} className="text-link underline">
                      {page.label ?? page.title}
                    </Link>{' '}
                    <span className="text-ink-muted text-xs">{page.blurb}</span>
                  </li>
                ))}
            </ul>
          </section>
        ))}
      </nav>
    </DocsLayout>
  )
}
