import { useEffect, useState, } from 'react'
import { Link, useParams, } from 'react-router'
import BaseLayout from '~/components/BaseLayout'
import { useSSRData, } from '~/lib/ssr-data'

export default function OwnerPage() {
  const { owner, } = useParams()
  const currentUser = useSSRData<any>('currentUser',)

  const [account, setAccount,] = useState<any>(null,)
  const [collections, setCollections,] = useState<any[]>([],)
  const [members, setMembers,] = useState<any[]>([],)
  const [isMember, setIsMember,] = useState(false,)
  const [loading, setLoading,] = useState(true,)

  useEffect(() => {
    if (!owner) return
    setLoading(true,)

    Promise.all([
      fetch(`/api/accounts/${owner}`, { credentials: 'include', },).then((r,) => r.ok ? r.json() : null),
      fetch(`/api/accounts/${owner}/collections`, { credentials: 'include', },).then((r,) => r.ok ? r.json() : []),
    ],).then(([acct, cols,],) => {
      if (!acct) {
        window.location.href = '/404'
        return
      }
      setAccount(acct,)
      setCollections(cols,)

      if (acct.type === 'org') {
        fetch(`/api/accounts/${owner}/members`, { credentials: 'include', },)
          .then((r,) => (r.ok ? r.json() : []))
          .then(setMembers,)
      }

      if (currentUser && acct.type === 'org') {
        setIsMember(currentUser.orgs?.some((o: any,) => o.slug === owner) ?? false,)
      }

      setLoading(false,)
    },)
  }, [owner, currentUser,],)

  if (loading || !account) {
    return (
      <BaseLayout>
        <div className='max-w-5xl mx-auto px-4 py-8 text-sm text-ink-muted'>Loading…</div>
      </BaseLayout>
    )
  }

  const totalVersions = collections.reduce(
    (sum: number, c: any,) => sum + (c.versionCount ?? 0),
    0,
  )

  return (
    <BaseLayout>
      <div className='max-w-5xl mx-auto px-4 py-8'>
        <div className='mb-8 flex gap-6'>
          {/* Avatar */}
          {account.avatarUrl
            ? (
              <img
                src={account.avatarUrl}
                alt={account.displayName}
                className='w-20 h-20 rounded-full object-cover border border-rule flex-shrink-0'
              />
            )
            : (
              <div className='w-20 h-20 rounded-full bg-parchment-dark border border-rule flex items-center justify-center text-ink-muted text-2xl font-semibold flex-shrink-0'>
                {account.displayName?.charAt(0,)?.toUpperCase() ?? '?'}
              </div>
            )}

          <div className='flex-1 min-w-0'>
            <div className='flex items-center justify-between'>
              <h1 className='text-xl font-semibold tracking-tight'>{account.displayName}</h1>
              {isMember && (
                <Link
                  to={`/${owner}/settings`}
                  className='text-sm text-ink-muted hover:text-ink transition-colors'
                >
                  Settings
                </Link>
              )}
            </div>
            <div className='flex items-center gap-3 mt-1'>
              <p className='text-sm text-ink-muted font-mono'>@{account.slug}</p>
              <span className='text-xs text-ink-muted border border-rule px-1.5 py-0.5'>
                {account.type === 'org' ? 'Organization' : 'User'}
              </span>
            </div>

            {account.bio && <p className='text-sm text-ink mt-2'>{account.bio}</p>}

            <div className='flex items-center gap-4 mt-2 text-xs text-ink-muted flex-wrap'>
              {account.location && <span>{account.location}</span>}
              {account.website && (
                <Link
                  to={account.website}
                  target='_blank'
                  rel='noopener noreferrer'
                  className='text-link hover:underline'
                >
                  {account.website.replace(/^https?:\/\//, '',)}
                </Link>
              )}
              <span>
                Joined {new Date(account.createdAt,).toLocaleDateString('en-US', {
                  month: 'short',
                  year: 'numeric',
                },)}
              </span>
            </div>

            {/* Activity summary */}
            <div className='flex items-center gap-3 mt-2 text-xs text-ink-muted'>
              <span>
                <strong className='text-ink'>{collections.length}</strong> collection
                {collections.length !== 1 ? 's' : ''}
              </span>
              {totalVersions > 0 && (
                <span>
                  <strong className='text-ink'>{totalVersions}</strong> version
                  {totalVersions !== 1 ? 's' : ''}
                </span>
              )}
              {members.length > 0 && (
                <span>
                  <strong className='text-ink'>{members.length}</strong> member
                  {members.length !== 1 ? 's' : ''}
                </span>
              )}
            </div>

            <div className='flex items-center gap-2 mt-3'>
              <div className='relative group'>
                <button className='flex items-center gap-1 border border-rule px-3 py-1.5 text-xs font-medium hover:bg-parchment-dark transition-colors'>
                  Subscribe ▾
                </button>
                <div className='hidden group-hover:block absolute left-0 top-full mt-1 bg-parchment border border-rule shadow-sm z-10 min-w-[16rem]'>
                  <div className='p-3 border-b border-rule'>
                    <p className='text-xs font-medium mb-1'>AT Protocol</p>
                    <code className='block text-[11px] text-ink-muted break-all bg-parchment-dark px-2 py-1'>
                      {`at://did:web:underlay.org:${owner}`}
                    </code>
                    <p className='text-[10px] text-ink-muted mt-1'>Follow in any AT Proto app</p>
                  </div>
                  <div className='p-3'>
                    <p className='text-xs font-medium mb-1'>API</p>
                    <code className='block text-[11px] text-ink-muted break-all bg-parchment-dark px-2 py-1'>
                      {`GET /api/accounts/${owner}/collections`}
                    </code>
                    <p className='text-[10px] text-ink-muted mt-1'>
                      Poll for new collections and versions
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Public member list for orgs */}
        {account.type === 'org' && members.length > 0
          ? (
            <div className='flex flex-col md:flex-row gap-8'>
              {/* Collections - main column */}
              <div className='flex-1 min-w-0'>
                <h2 className='text-sm font-semibold uppercase tracking-wide text-ink-muted mb-3'>
                  Collections ({collections.length})
                </h2>

                {collections.length === 0
                  ? <p className='text-sm text-ink-muted'>No public collections yet.</p>
                  : (
                    <div className='space-y-2'>
                      {collections.map((c: any,) => (
                        <Link
                          key={c.id}
                          to={`/${owner}/${c.slug}`}
                          className='block border border-rule p-4 rounded hover:bg-parchment-dark transition-colors'
                        >
                          <div className='flex items-center gap-2 mb-1'>
                            <span className='font-semibold text-sm text-link'>{c.name}</span>
                            <span className='text-xs text-ink-muted border border-rule px-1.5 py-0.5'>
                              {c.public ? 'public' : 'private'}
                            </span>
                          </div>
                          {c.description && (
                            <p className='text-xs text-ink-muted mt-1 line-clamp-2'>
                              {c.description}
                            </p>
                          )}
                        </Link>
                      ))}
                    </div>
                  )}
              </div>

              {/* Members - right sidebar */}
              <div className='md:w-56 flex-shrink-0'>
                <h2 className='text-sm font-semibold uppercase tracking-wide text-ink-muted mb-3'>
                  Members
                </h2>
                <div className='space-y-1.5'>
                  {members.map((m: any,) => (
                    <Link
                      key={m.slug}
                      to={`/${m.slug}`}
                      className='flex items-center gap-2 px-2 py-1.5 hover:bg-parchment-dark transition-colors rounded'
                      title={m.displayName}
                    >
                      <span className='text-sm font-medium'>{m.slug}</span>
                      <span className='text-[10px] text-ink-muted border border-rule px-1 py-0.5'>
                        {m.role}
                      </span>
                    </Link>
                  ))}
                </div>
              </div>
            </div>
          )
          : (
            <>
              <h2 className='text-sm font-semibold uppercase tracking-wide text-ink-muted mb-3'>
                Collections ({collections.length})
              </h2>

              {collections.length === 0
                ? <p className='text-sm text-ink-muted'>No public collections yet.</p>
                : (
                  <div className='grid grid-cols-1 md:grid-cols-2 gap-3'>
                    {collections.map((c: any,) => (
                      <Link
                        key={c.id}
                        to={`/${owner}/${c.slug}`}
                        className='block border border-rule p-4 rounded hover:bg-parchment-dark transition-colors'
                      >
                        <div className='flex items-center gap-2 mb-1'>
                          <span className='font-semibold text-sm text-link'>{c.name}</span>
                          <span className='text-xs text-ink-muted border border-rule px-1.5 py-0.5'>
                            {c.public ? 'public' : 'private'}
                          </span>
                        </div>
                        {c.description && <p className='text-xs text-ink-muted mt-1 line-clamp-2'>{c.description}</p>}
                      </Link>
                    ))}
                  </div>
                )}
            </>
          )}
      </div>
    </BaseLayout>
  )
}
