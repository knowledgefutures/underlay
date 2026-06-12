import { useEffect, useState } from 'react'
import { Link } from 'react-router'

import BaseLayout from '~/components/BaseLayout'
import { useAppContext } from '~/lib/app-context'

interface Collection {
  id: string
  slug: string
  name: string
  public: boolean
  description?: string
  semver?: string
  lastPushAt?: string
  createdAt?: string
  updatedAt?: string
}

interface Org {
  slug: string
  displayName: string
  role: string
  isDefault: boolean
  collections: Collection[]
}

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

export default function Dashboard() {
  const { currentUser } = useAppContext()
  const [orgs, setOrgs] = useState<Org[]>([])
  const [filter, setFilter] = useState('')

  useEffect(() => {
    if (!currentUser) return

    if (currentUser.orgs?.length) {
      Promise.all(
        currentUser.orgs.map(async (org: any) => {
          const res = await fetch(`/api/accounts/${org.slug}/collections`, {
            credentials: 'include',
          })
          return {
            slug: org.slug,
            displayName: org.name ?? org.displayName,
            role: org.role,
            isDefault: !!org.isDefault,
            collections: res.ok ? await res.json() : [],
          }
        }),
      ).then(setOrgs)
    }
  }, [currentUser])

  const allCollections = orgs
    .flatMap((org) =>
      org.collections.map((c) => ({ ...c, orgSlug: org.slug, orgName: org.displayName })),
    )
    .sort((a, b) => {
      if (a.updatedAt && b.updatedAt)
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      if (a.updatedAt) return -1
      if (b.updatedAt) return 1
      return a.slug.localeCompare(b.slug)
    })

  const filtered = filter
    ? allCollections.filter((c) => {
        const term = filter.toLowerCase()
        return (
          `${c.orgSlug}/${c.slug}`.includes(term) ||
          (c.description ?? '').toLowerCase().includes(term)
        )
      })
    : allCollections

  return (
    <BaseLayout>
      <div className="mx-auto flex max-w-5xl gap-6 px-4 py-8">
        {/* Left sidebar */}
        <div className="hidden w-52 shrink-0 md:block">
          <div className="mb-1 flex items-center justify-between">
            <h3 className="text-ink-muted text-[11px] font-semibold tracking-wide uppercase">
              Organizations
            </h3>
            <Link
              to="/new-org"
              className="text-ink-muted hover:text-ink text-[11px] transition-colors"
            >
              + New
            </Link>
          </div>
          <div className="mb-5 space-y-0.5">
            {orgs.map((org) => (
              <Link
                key={org.slug}
                to={`/${org.slug}`}
                className="hover:bg-parchment-dark flex items-center gap-2 rounded px-2 py-1.5 transition-colors"
              >
                <span className="bg-parchment-dark text-ink-muted flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold">
                  {org.displayName.charAt(0).toUpperCase()}
                </span>
                <span className="min-w-0 truncate text-sm font-medium">
                  {org.displayName}
                  {org.isDefault && (
                    <span className="text-ink-muted ml-1 font-normal">(personal)</span>
                  )}
                </span>
                <span className="text-ink-muted ml-auto text-[10px]">{org.collections.length}</span>
              </Link>
            ))}
          </div>

          <h3 className="text-ink-muted mb-2 text-[11px] font-semibold tracking-wide uppercase">
            Tools
          </h3>
          <div className="space-y-0.5 text-sm">
            <Link to="/new" className="text-link block px-2 py-1 hover:underline">
              New collection
            </Link>
            <Link to="/new-org" className="text-link block px-2 py-1 hover:underline">
              New organization
            </Link>
            <Link to="/settings/keys" className="text-link block px-2 py-1 hover:underline">
              API keys
            </Link>
            <Link to="/settings" className="text-link block px-2 py-1 hover:underline">
              Settings
            </Link>
            <Link to="/explore" className="text-link block px-2 py-1 hover:underline">
              Explore
            </Link>
          </div>
        </div>

        {/* Main: collections table */}
        <div className="min-w-0 flex-1">
          <div className="mb-3 flex items-center gap-3">
            <input
              type="text"
              placeholder="Find a collection..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="bg-parchment border-rule focus:border-ink min-w-0 flex-1 rounded border px-3 py-1.5 text-sm focus:outline-none"
            />
            <Link
              to="/new"
              className="bg-ink text-parchment visited:text-parchment shrink-0 rounded px-3 py-1.5 text-sm font-medium transition-opacity hover:opacity-90"
            >
              New collection
            </Link>
          </div>

          {filtered.length === 0 ? (
            <div className="text-ink-muted border-rule rounded border px-4 py-8 text-center text-sm">
              {allCollections.length === 0 ? (
                <span>
                  No collections yet.{' '}
                  <Link to="/new" className="text-link hover:underline">
                    Create your first collection
                  </Link>
                </span>
              ) : (
                'No collections match your search.'
              )}
            </div>
          ) : (
            <div className="border-rule overflow-hidden rounded border">
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
                  {filtered.map((c, i) => (
                    <tr
                      key={`${c.orgSlug}/${c.slug}`}
                      className={`hover:bg-parchment-dark transition-colors ${
                        i < filtered.length - 1 ? 'border-rule border-b' : ''
                      }`}
                    >
                      <td className="py-2 pr-2 pl-3">
                        <Link
                          to={`/${c.orgSlug}/${c.slug}`}
                          className="text-link font-medium hover:underline"
                        >
                          <span className="text-ink-muted font-normal">{c.orgSlug}/</span>
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
      </div>
    </BaseLayout>
  )
}
