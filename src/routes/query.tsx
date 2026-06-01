import { Link } from 'react-router'

import QueryExplorer from '~/components/QueryExplorer'
import UserMenu from '~/components/UserMenu'
import { useSSRData } from '~/lib/ssr-data'

export default function QueryPage() {
  const currentUser = useSSRData<{
    slug: string
    displayName: string
    orgs?: { slug: string; displayName: string }[]
  } | null>('currentUser')

  return (
    <div className="flex h-screen flex-col overflow-hidden font-sans text-[15px] leading-relaxed">
      <header className="border-rule shrink-0 border-b">
        <nav className="flex max-w-none items-center justify-between px-4 py-3">
          <Link to="/" className="flex items-center gap-2.5 no-underline">
            <img src="https://docs.underlay.org/logoLight.svg" alt="Underlay" className="h-6" />
            <span className="text-ink text-base font-semibold tracking-tight">Underlay</span>
          </Link>
          <div className="text-ink-muted flex items-center gap-5 text-sm">
            <Link to="/explore" className="hover:text-ink transition-colors">
              Explore
            </Link>
            <Link to="/schemas" className="hover:text-ink transition-colors">
              Schemas
            </Link>
            <Link to="/docs" className="hover:text-ink transition-colors">
              Docs
            </Link>
            <Link to="/blog" className="hover:text-ink transition-colors">
              Blog
            </Link>
            {currentUser ? (
              <UserMenu
                slug={currentUser.slug}
                displayName={currentUser.displayName}
                orgs={currentUser.orgs ?? []}
              />
            ) : (
              <a href="/login" className="hover:text-ink transition-colors">
                Log in
              </a>
            )}
          </div>
        </nav>
      </header>

      <main className="min-h-0 flex-1">
        <QueryExplorer />
      </main>

      <footer className="border-rule shrink-0 border-t">
        <div className="text-ink-muted flex items-center justify-between px-4 py-2 text-xs">
          <div className="flex items-center gap-1.5">
            <span>&copy; {new Date().getFullYear()}</span>
            <a href="https://www.knowledgefutures.org" className="hover:text-ink underline">
              Knowledge Futures
            </a>
          </div>
          <div className="flex items-center gap-4">
            <a href="https://github.com/knowledgefutures/underlay" className="hover:text-ink">
              GitHub
            </a>
            <span className="text-rule">&middot;</span>
            <span className="font-mono">v0.1.0</span>
          </div>
        </div>
      </footer>
    </div>
  )
}
