import { Link } from 'react-router'

import UserMenu from '~/components/UserMenu'
import { useSSRData } from '~/lib/ssr-data'

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
      <header className="border-rule border-b">
        <nav className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <Link to="/" className="flex items-center gap-2.5 no-underline">
            <img src="https://docs.underlay.org/logoLight.svg" alt="Underlay" className="h-6" />
            <span className="text-ink text-base font-semibold tracking-tight">Underlay</span>
            {mirrorConfig?.enabled && (
              <span className="text-ink-muted ml-1 self-center text-sm font-medium">
                &middot; {mirrorConfig.nodeName}
              </span>
            )}
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
            {!mirrorConfig?.enabled && (
              <Link to="/blog" className="hover:text-ink transition-colors">
                Blog
              </Link>
            )}
            {mirrorConfig?.enabled ? (
              currentUser ? (
                <Link to="/admin/mirror" className="hover:text-ink transition-colors">
                  Admin
                </Link>
              ) : (
                <a href="/auth/login" className="hover:text-ink transition-colors">
                  Log in
                </a>
              )
            ) : currentUser ? (
              <UserMenu
                slug={currentUser.slug}
                displayName={currentUser.displayName}
                orgs={currentUser.orgs ?? []}
              />
            ) : (
              <a href="/auth/login" className="hover:text-ink transition-colors">
                Log in
              </a>
            )}
          </div>
        </nav>
      </header>

      <main>{children}</main>

      <footer className="border-rule mt-16 border-t">
        <div className="text-ink-muted mx-auto flex max-w-5xl items-center justify-between px-4 py-6 text-xs">
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
    </>
  )
}
