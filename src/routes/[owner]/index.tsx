import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'

import BaseLayout from '~/components/BaseLayout'
import { NotFoundError } from '~/components/NotFound'
import { useAppContext } from '~/lib/app-context'

export const handle = { title: (params: Record<string, string>) => params.owner + ' — Underlay' }

export default function OwnerPage() {
  const { owner } = useParams()
  const { currentUser } = useAppContext()

  const [account, setAccount] = useState<any>(null)
  const [collections, setCollections] = useState<any[]>([])
  const [members, setMembers] = useState<any[]>([])
  const [isMember, setIsMember] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!owner) return
    setLoading(true)

    Promise.all([
      fetch(`/api/accounts/${owner}`, { credentials: 'include' }).then((r) =>
        r.ok ? r.json() : null,
      ),
      fetch(`/api/accounts/${owner}/collections`, { credentials: 'include' }).then((r) =>
        r.ok ? r.json() : [],
      ),
      fetch(`/api/accounts/${owner}/members`, { credentials: 'include' }).then((r) =>
        r.ok ? r.json() : [],
      ),
    ]).then(([acct, cols, mems]) => {
      if (!acct) {
        setLoading(false)
        return
      }
      setAccount(acct)
      setCollections(cols)
      setMembers(mems)

      if (currentUser) {
        setIsMember(currentUser.orgs?.some((o: any) => o.slug === owner) ?? false)
      }

      setLoading(false)
    })
  }, [owner, currentUser])

  if (loading) {
    return (
      <BaseLayout>
        <div className="text-ink-muted mx-auto max-w-5xl px-4 py-8 text-sm">Loading…</div>
      </BaseLayout>
    )
  }
  if (!account) throw new NotFoundError()

  const totalVersions = collections.reduce((sum: number, c: any) => sum + (c.versionCount ?? 0), 0)

  return (
    <BaseLayout>
      <div className="mx-auto max-w-5xl px-4 py-8">
        <div className="mb-8 flex gap-6">
          {/* Avatar */}
          {account.avatarUrl ? (
            <img
              src={account.avatarUrl}
              alt={account.displayName}
              className="border-rule h-20 w-20 flex-shrink-0 rounded-full border object-cover"
            />
          ) : (
            <div className="bg-parchment-dark border-rule text-ink-muted flex h-20 w-20 flex-shrink-0 items-center justify-center rounded-full border text-2xl font-semibold">
              {account.displayName?.charAt(0)?.toUpperCase() ?? '?'}
            </div>
          )}

          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between">
              <h1 className="text-xl font-semibold tracking-tight">{account.displayName}</h1>
              {isMember && (
                <Link
                  to={`/${owner}/settings`}
                  className="text-ink-muted hover:text-ink text-sm transition-colors"
                >
                  Settings
                </Link>
              )}
            </div>
            <p className="text-ink-muted mt-1 font-mono text-sm">@{account.slug}</p>

            {account.bio && <p className="text-ink mt-2 text-sm">{account.bio}</p>}

            <div className="text-ink-muted mt-2 flex flex-wrap items-center gap-4 text-xs">
              {account.location && <span>{account.location}</span>}
              {account.website && (
                <Link
                  to={account.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-link hover:underline"
                >
                  {account.website.replace(/^https?:\/\//, '')}
                </Link>
              )}
              <span>
                Joined{' '}
                {new Date(account.createdAt).toLocaleDateString('en-US', {
                  month: 'short',
                  year: 'numeric',
                })}
              </span>
            </div>

            {/* Activity summary */}
            <div className="text-ink-muted mt-2 flex items-center gap-3 text-xs">
              <span>
                <strong className="text-ink">{collections.length}</strong> collection
                {collections.length !== 1 ? 's' : ''}
              </span>
              {totalVersions > 0 && (
                <span>
                  <strong className="text-ink">{totalVersions}</strong> version
                  {totalVersions !== 1 ? 's' : ''}
                </span>
              )}
              {members.length > 0 && (
                <span>
                  <strong className="text-ink">{members.length}</strong> member
                  {members.length !== 1 ? 's' : ''}
                </span>
              )}
            </div>

            <div className="mt-3 flex items-center gap-2">
              <div className="group relative">
                <button className="border-rule hover:bg-parchment-dark flex items-center gap-1 border px-3 py-1.5 text-xs font-medium transition-colors">
                  Subscribe ▾
                </button>
                <div className="bg-parchment border-rule absolute top-full left-0 z-10 mt-1 hidden min-w-[16rem] border shadow-sm group-hover:block">
                  <div className="border-rule border-b p-3">
                    <p className="mb-1 text-xs font-medium">AT Protocol</p>
                    <code className="text-ink-muted bg-parchment-dark block px-2 py-1 text-[11px] break-all">
                      {`at://did:web:underlay.org:${owner}`}
                    </code>
                    <p className="text-ink-muted mt-1 text-[10px]">Follow in any AT Proto app</p>
                  </div>
                  <div className="p-3">
                    <p className="mb-1 text-xs font-medium">API</p>
                    <code className="text-ink-muted bg-parchment-dark block px-2 py-1 text-[11px] break-all">
                      {`GET /api/accounts/${owner}/collections`}
                    </code>
                    <p className="text-ink-muted mt-1 text-[10px]">
                      Poll for new collections and versions
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-8 md:flex-row">
          <div className="min-w-0 flex-1">
            <h2 className="text-ink-muted mb-3 text-sm font-semibold tracking-wide uppercase">
              Collections ({collections.length})
            </h2>

            {collections.length === 0 ? (
              <p className="text-ink-muted text-sm">No public collections yet.</p>
            ) : (
              <div className="space-y-2">
                {collections.map((c: any) => (
                  <Link
                    key={c.id}
                    to={`/${owner}/${c.slug}`}
                    className="border-rule hover:bg-parchment-dark block rounded border p-4 transition-colors"
                  >
                    <div className="mb-1 flex items-center gap-2">
                      <span className="text-link text-sm font-semibold">{c.name}</span>
                      <span className="text-ink-muted border-rule border px-1.5 py-0.5 text-xs">
                        {c.public ? 'public' : 'private'}
                      </span>
                    </div>
                    {c.description && (
                      <p className="text-ink-muted mt-1 line-clamp-2 text-xs">{c.description}</p>
                    )}
                  </Link>
                ))}
              </div>
            )}
          </div>

          {members.length > 0 && (
            <div className="flex-shrink-0 md:w-56">
              <h2 className="text-ink-muted mb-3 text-sm font-semibold tracking-wide uppercase">
                Members
              </h2>
              <div className="space-y-1.5">
                {members.map((m: any) => (
                  <Link
                    key={m.slug}
                    to={`/${m.slug}`}
                    className="hover:bg-parchment-dark flex items-center gap-2 rounded px-2 py-1.5 transition-colors"
                    title={m.displayName}
                  >
                    <span className="text-sm font-medium">{m.slug}</span>
                    <span className="text-ink-muted border-rule border px-1 py-0.5 text-[10px]">
                      {m.role}
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </BaseLayout>
  )
}
