import { Link, } from 'react-router'
import UserMenu from '~/components/UserMenu'
import { useSSRData, } from '~/lib/ssr-data'

interface MirrorConfig {
  enabled: boolean
  nodeName: string
  upstream: string
}

export default function BaseLayout({ children, }: { children: React.ReactNode },) {
  const currentUser = useSSRData<any>('currentUser',)
  const mirrorConfig = useSSRData<MirrorConfig>('mirrorConfig',)

  return (
    <>
      <header className='border-b border-rule'>
        <nav className='max-w-5xl mx-auto px-4 py-3 flex items-center justify-between'>
          <Link to='/' className='flex items-center gap-2.5 no-underline'>
            <img
              src='https://docs.underlay.org/logoLight.svg'
              alt='Underlay'
              className='h-6'
            />
            <span className='font-semibold text-ink tracking-tight text-base'>Underlay</span>
            {mirrorConfig?.enabled && (
              <span className='text-sm font-medium text-ink-muted self-center ml-1'>
                &middot; {mirrorConfig.nodeName}
              </span>
            )}
          </Link>
          <div className='flex items-center gap-5 text-sm text-ink-muted'>
            <Link to='/explore' className='hover:text-ink transition-colors'>Explore</Link>
            <Link to='/schemas' className='hover:text-ink transition-colors'>Schemas</Link>
            <Link to='/docs' className='hover:text-ink transition-colors'>Docs</Link>
            {!mirrorConfig?.enabled && <Link to='/blog' className='hover:text-ink transition-colors'>Blog</Link>}
            {mirrorConfig?.enabled
              ? (
                currentUser
                  ? <Link to='/admin/mirror' className='hover:text-ink transition-colors'>Admin</Link>
                  : <a href='/auth/login' className='hover:text-ink transition-colors'>Log in</a>
              )
              : currentUser
              ? <UserMenu slug={currentUser.slug} displayName={currentUser.displayName} orgs={currentUser.orgs ?? []} />
              : <a href='/auth/login' className='hover:text-ink transition-colors'>Log in</a>}
          </div>
        </nav>
      </header>

      <main>
        {children}
      </main>

      <footer className='border-t border-rule mt-16'>
        <div className='max-w-5xl mx-auto px-4 py-6 flex items-center justify-between text-xs text-ink-muted'>
          <div className='flex items-center gap-1.5'>
            <span>&copy; {new Date().getFullYear()}</span>
            <a href='https://www.knowledgefutures.org' className='underline hover:text-ink'>Knowledge Futures</a>
          </div>
          <div className='flex items-center gap-4'>
            <a href='https://github.com/knowledgefutures/underlay' className='hover:text-ink'>GitHub</a>
            <span className='text-rule'>&middot;</span>
            <span className='font-mono'>v0.1.0</span>
          </div>
        </div>
      </footer>
    </>
  )
}
