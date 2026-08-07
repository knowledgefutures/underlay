import { Link, useLoaderData, useParams } from 'react-router'

import BaseLayout from '~/components/BaseLayout'
import { ButtonLink, EmptyState } from '~/components/ui'
import { useAppContext } from '~/lib/app-context'

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}

export default function OwnerPage() {
  const { owner } = useParams()
  const { currentUser } = useAppContext()
  const { account, collections, members } = useLoaderData() as {
    account: any
    collections: any[]
    members: any[]
  }

  const isMember = currentUser?.orgs?.some((o: any) => o.slug === owner) ?? false
  const isOwner = currentUser?.slug === owner

  return (
    <BaseLayout>
      <div className="mx-auto max-w-5xl px-4 py-8">
        {/* Full-width header */}
        <div className="mb-8 flex items-start gap-4">
          {account.avatarUrl ? (
            <img
              src={account.avatarUrl}
              alt={account.displayName}
              className="border-rule h-14 w-14 shrink-0 rounded-full border object-cover"
            />
          ) : (
            <div className="bg-parchment-dark border-rule text-ink-muted flex h-14 w-14 shrink-0 items-center justify-center rounded-full border text-xl font-semibold">
              {account.displayName?.charAt(0)?.toUpperCase() ?? '?'}
            </div>
          )}

          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between">
              <div className="flex items-baseline gap-2">
                <h1 className="text-xl font-semibold tracking-tight">{account.displayName}</h1>
                <span className="text-ink-muted font-mono text-sm">@{account.slug}</span>
              </div>
              <div className="flex items-center gap-3">
                {(isMember || isOwner) && (
                  <Link
                    to={`/${owner}/settings`}
                    className="text-ink-muted hover:text-ink text-sm transition-colors"
                  >
                    Settings
                  </Link>
                )}
              </div>
            </div>

            {account.bio && <p className="text-ink mt-1 text-sm leading-snug">{account.bio}</p>}

            <div className="text-ink-muted mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
              {account.location && <span>{account.location}</span>}
              {account.website && (
                <a
                  href={account.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-link hover:underline"
                >
                  {account.website.replace(/^https?:\/\//, '')}
                </a>
              )}
              <span>
                Joined{' '}
                {new Date(account.createdAt).toLocaleDateString('en-US', {
                  month: 'short',
                  year: 'numeric',
                })}
              </span>
              <span>
                <strong className="text-ink">{collections.length}</strong> collection
                {collections.length !== 1 ? 's' : ''}
              </span>
              {members.length > 0 && (
                <span>
                  <strong className="text-ink">{members.length}</strong> member
                  {members.length !== 1 ? 's' : ''}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Two-column body */}
        <div className="flex gap-6">
          {/* Main: collections table */}
          <div className="min-w-0 flex-1">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-ink-muted text-[11px] font-semibold tracking-wide uppercase">
                Collections
              </h2>
              {isMember && (
                <ButtonLink to={`/new?owner=${owner}`} size="sm">
                  New collection
                </ButtonLink>
              )}
            </div>

            {collections.length === 0 ? (
              <EmptyState>
                {isMember || isOwner ? 'No collections yet.' : 'No public collections yet.'}
              </EmptyState>
            ) : (
              <div className="border-rule rounded-surface overflow-x-auto border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-ink/5 text-ink-muted text-left text-xs">
                      <th className="py-2 pr-2 pl-3 font-medium">Collection</th>
                      <th className="px-2 py-2 font-medium">Visibility</th>
                      <th className="px-2 py-2 font-medium">Created</th>
                      <th className="py-2 pr-3 pl-2 text-right font-medium">Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {collections.map((c: any, i: number) => (
                      <tr
                        key={c.id}
                        className={`hover:bg-parchment-dark transition-colors ${
                          i < collections.length - 1 ? 'border-rule border-b' : ''
                        }`}
                      >
                        <td className="py-2 pr-2 pl-3">
                          <Link
                            to={`/${owner}/${c.slug}`}
                            className="text-link font-medium hover:underline"
                          >
                            {c.slug}
                          </Link>
                          {c.description && (
                            <p className="text-ink-muted mt-0.5 line-clamp-1 text-xs">
                              {c.description}
                            </p>
                          )}
                        </td>
                        <td className="px-2 py-2">
                          <span className="text-ink-muted text-xs">
                            {c.public ? 'public' : 'private'}
                          </span>
                        </td>
                        <td className="px-2 py-2">
                          <span className="text-ink-muted text-xs">
                            {c.createdAt ? timeAgo(c.createdAt) : '--'}
                          </span>
                        </td>
                        <td className="py-2 pr-3 pl-2 text-right">
                          <span className="text-ink-muted text-xs">
                            {c.updatedAt ? timeAgo(c.updatedAt) : '--'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Right sidebar */}
          <div className="hidden w-52 shrink-0 md:block">
            {/* Members */}
            {members.length > 0 && (
              <div className="mb-5">
                <h3 className="text-ink-muted mb-2 text-[11px] font-semibold tracking-wide uppercase">
                  Members
                </h3>
                <div className="space-y-0.5">
                  {members.map((m: any) => (
                    <Link
                      key={m.slug}
                      to={`/${m.slug}`}
                      className="hover:bg-parchment-dark rounded-control flex items-center gap-2 px-2 py-1 transition-colors"
                    >
                      <span className="text-sm font-medium">{m.slug}</span>
                      <span className="text-ink-muted text-[10px]">{m.role}</span>
                    </Link>
                  ))}
                </div>
              </div>
            )}

            {/* Subscribe */}
            <div>
              <h3 className="text-ink-muted mb-2 text-[11px] font-semibold tracking-wide uppercase">
                Subscribe
              </h3>
              <div className="space-y-2">
                <div>
                  <p className="text-ink-muted mb-0.5 text-[10px] font-medium">AT Protocol</p>
                  <code className="text-ink-muted bg-parchment-dark rounded-surface block px-2 py-1 text-[10px] break-all">
                    at://did:web:underlay.org:{owner}
                  </code>
                </div>
                <div>
                  <p className="text-ink-muted mb-0.5 text-[10px] font-medium">API</p>
                  <code className="text-ink-muted bg-parchment-dark rounded-surface block px-2 py-1 text-[10px] break-all">
                    GET /api/accounts/{owner}/collections
                  </code>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </BaseLayout>
  )
}
