import { Link } from 'react-router'

import CreateMenu from '~/components/CreateMenu'
import UserMenu from '~/components/UserMenu'
import { useAppContext } from '~/lib/app-context'

export default function BaseLayout({ children }: { children: React.ReactNode }) {
  const { currentUser, mirrorConfig } = useAppContext()
  const isSteward = currentUser?.kfRole === 'admin'

  return (
    <>
      <header className="border-rule border-b">
        <nav className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <Link to="/" className="flex items-center gap-2.5 no-underline">
            <img src="/logoLight.svg" alt="Underlay" className="h-6" />
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
                <a href="/login" className="hover:text-ink transition-colors">
                  Log in
                </a>
              )
            ) : currentUser ? (
              <>
                <CreateMenu />
                <UserMenu
                  slug={currentUser.slug}
                  displayName={currentUser.displayName}
                  avatarUrl={currentUser.avatarUrl}
                  orgs={currentUser.orgs ?? []}
                  isSteward={isSteward}
                />
              </>
            ) : (
              <a href="/login" className="hover:text-ink transition-colors">
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
          <div>
            <a
              href="https://github.com/knowledgefutures/underlay"
              className="hover:text-ink underline"
            >
              GitHub
            </a>
          </div>
        </div>
      </footer>
    </>
  )
}
