import { useSSRData } from '~/lib/ssr-data'
import UserMenu from '~/components/UserMenu'

interface MirrorConfig {
  enabled: boolean
  nodeName: string
  upstream: string
}

export default function BaseLayout({ children }: { children: React.ReactNode }) {
  const currentUser = useSSRData<any>('currentUser')
  const mirrorConfig = useSSRData<MirrorConfig>('mirrorConfig')

  return (
    <>
      <header className="border-b border-rule">
        <nav className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <a href="/" className="flex items-center gap-2.5 no-underline">
            <img
              src="https://docs.underlay.org/logoLight.svg"
              alt="Underlay"
              className="h-6"
            />
            <span className="font-semibold text-ink tracking-tight text-base">Underlay</span>
            {mirrorConfig?.enabled && (
              <span className="text-sm font-medium text-ink-muted self-center ml-1">&middot; {mirrorConfig.nodeName}</span>
            )}
          </a>
          <div className="flex items-center gap-5 text-sm text-ink-muted">
            <a href="/explore" className="hover:text-ink transition-colors">Explore</a>
            <a href="/schemas" className="hover:text-ink transition-colors">Schemas</a>
            <a href="/docs" className="hover:text-ink transition-colors">Docs</a>
            {!mirrorConfig?.enabled && (
              <a href="/blog" className="hover:text-ink transition-colors">Blog</a>
            )}
            {mirrorConfig?.enabled ? (
              currentUser ? (
                <a href="/admin/mirror" className="hover:text-ink transition-colors">Admin</a>
              ) : (
                <a href="/login" className="hover:text-ink transition-colors">Log in</a>
              )
            ) : currentUser ? (
              <UserMenu slug={currentUser.slug} orgs={currentUser.orgs ?? []} />
            ) : (
              <a href="/login" className="hover:text-ink transition-colors">Log in</a>
            )}
          </div>
        </nav>
      </header>

      <main>
        {children}
      </main>

      <footer className="border-t border-rule mt-16">
        <div className="max-w-5xl mx-auto px-4 py-6 flex items-center justify-between text-xs text-ink-muted">
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
    </>
  )
}
