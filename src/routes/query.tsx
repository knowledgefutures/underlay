import { useSSRData } from '~/lib/ssr-data'
import UserMenu from '~/components/UserMenu'
import QueryExplorer from '~/components/QueryExplorer'

export default function QueryPage() {
  const currentUser = useSSRData<{ slug: string; displayName: string; orgs?: { slug: string; displayName: string }[] } | null>('currentUser')

  return (
    <div className="h-screen flex flex-col overflow-hidden font-sans text-[15px] leading-relaxed">
      <header className="border-b border-rule shrink-0">
        <nav className="max-w-none px-4 py-3 flex items-center justify-between">
          <a href="/" className="flex items-center gap-2.5 no-underline">
            <img src="https://docs.underlay.org/logoLight.svg" alt="Underlay" className="h-6" />
            <span className="font-semibold text-ink tracking-tight text-base">Underlay</span>
          </a>
          <div className="flex items-center gap-5 text-sm text-ink-muted">
            <a href="/explore" className="hover:text-ink transition-colors">Explore</a>
            <a href="/schemas" className="hover:text-ink transition-colors">Schemas</a>
            <a href="/docs" className="hover:text-ink transition-colors">Docs</a>
            <a href="/blog" className="hover:text-ink transition-colors">Blog</a>
            {currentUser ? (
              <UserMenu slug={currentUser.slug} orgs={currentUser.orgs ?? []} />
            ) : (
              <a href="/login" className="hover:text-ink transition-colors">Log in</a>
            )}
          </div>
        </nav>
      </header>

      <main className="flex-1 min-h-0">
        <QueryExplorer />
      </main>

      <footer className="border-t border-rule shrink-0">
        <div className="px-4 py-2 flex items-center justify-between text-xs text-ink-muted">
          <div className="flex items-center gap-1.5">
            <span>&copy; {new Date().getFullYear()}</span>
            <a href="https://www.knowledgefutures.org" className="underline hover:text-ink">Knowledge Futures</a>
          </div>
          <div className="flex items-center gap-4">
            <a href="https://github.com/knowledgefutures/underlay" className="hover:text-ink">GitHub</a>
            <span className="text-rule">&middot;</span>
            <span className="font-mono">v0.1.0</span>
          </div>
        </div>
      </footer>
    </div>
  )
}
