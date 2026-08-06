import { useState } from 'react'
import { Link, useLoaderData, useSearchParams } from 'react-router'

import BaseLayout from '~/components/BaseLayout'
import { ButtonLink, EmptyState, Input } from '~/components/ui'
import { useAppContext } from '~/lib/app-context'
import { formatBytes, timeAgo } from '~/lib/format'

interface DashboardCollection {
  slug: string
  name: string
  public: boolean
  ownerSlug: string
  ownerName: string | null
  description: string | null
  latestVersion: string | null
  recordCount: number | null
  totalBytes: number | null
  lastPushAt: string | null
  updatedAt: string
}

interface OwnerFacet {
  slug: string
  name: string | null
  count: number
}

const FACET_COLLAPSE_COUNT = 8

export default function Dashboard() {
  const { currentUser } = useAppContext()
  const { collections, owners } = useLoaderData() as {
    collections: DashboardCollection[]
    owners: OwnerFacet[]
  }
  const [searchParams] = useSearchParams()
  const selectedOrg = searchParams.get('org')

  const [filter, setFilter] = useState('')
  const [showAllOrgs, setShowAllOrgs] = useState(false)

  const personalSlug: string | undefined = currentUser?.orgs?.find((o: any) => o.isDefault)?.slug

  // Personal org first, then by collection count (the server's order).
  const sortedOwners = [...owners].sort((a, b) => {
    if (a.slug === personalSlug) return -1
    if (b.slug === personalSlug) return 1
    return b.count - a.count
  })
  const visibleOwners = showAllOrgs ? sortedOwners : sortedOwners.slice(0, FACET_COLLAPSE_COUNT)
  const hiddenOwnerCount = sortedOwners.length - visibleOwners.length
  const totalCount = owners.reduce((sum, o) => sum + o.count, 0)

  const filtered = filter
    ? collections.filter((c) => {
        const term = filter.toLowerCase()
        return (
          `${c.ownerSlug}/${c.slug}`.includes(term) ||
          (c.name ?? '').toLowerCase().includes(term) ||
          (c.description ?? '').toLowerCase().includes(term)
        )
      })
    : collections

  const facetBase = 'flex items-center gap-2 rounded-control px-2 py-1.5 text-sm transition-colors'
  const facetActive = `${facetBase} bg-parchment-dark text-ink font-medium`
  const facetInactive = `${facetBase} text-ink-light hover:bg-parchment-dark/50 hover:text-ink`

  return (
    <BaseLayout>
      <div className="mx-auto flex max-w-5xl gap-6 px-4 py-8">
        {/* Left rail: org facets */}
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
            <Link to="/dashboard" className={selectedOrg ? facetInactive : facetActive}>
              <span className="min-w-0 truncate">All collections</span>
              <span className="text-ink-muted ml-auto font-mono text-[10px]">{totalCount}</span>
            </Link>
            {visibleOwners.map((org) => (
              <Link
                key={org.slug}
                to={`/dashboard?org=${encodeURIComponent(org.slug)}`}
                className={selectedOrg === org.slug ? facetActive : facetInactive}
              >
                <span className="bg-parchment-dark text-ink-muted flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold">
                  {(org.name ?? org.slug).charAt(0).toUpperCase()}
                </span>
                <span className="min-w-0 truncate">
                  {org.name ?? org.slug}
                  {org.slug === personalSlug && (
                    <span className="text-ink-muted ml-1 font-normal">(personal)</span>
                  )}
                </span>
                <span className="text-ink-muted ml-auto font-mono text-[10px]">{org.count}</span>
              </Link>
            ))}
            {hiddenOwnerCount > 0 && (
              <button
                type="button"
                onClick={() => setShowAllOrgs(true)}
                className="text-link block cursor-pointer px-2 py-1 text-xs hover:underline"
              >
                Show {hiddenOwnerCount} more…
              </button>
            )}
            {showAllOrgs && sortedOwners.length > FACET_COLLAPSE_COUNT && (
              <button
                type="button"
                onClick={() => setShowAllOrgs(false)}
                className="text-ink-muted hover:text-ink block cursor-pointer px-2 py-1 text-xs"
              >
                Show fewer
              </button>
            )}
          </div>

          <h3 className="text-ink-muted mb-2 text-[11px] font-semibold tracking-wide uppercase">
            Tools
          </h3>
          <div className="space-y-0.5 text-sm">
            <Link to="/new" className="text-link block px-2 py-1 hover:underline">
              New collection
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

        {/* Main: collection list */}
        <div className="min-w-0 flex-1">
          <div className="mb-3 flex items-center gap-3">
            <Input
              type="text"
              placeholder={
                selectedOrg ? `Find a collection in ${selectedOrg}...` : 'Find a collection...'
              }
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="min-w-0 flex-1 py-1.5"
            />
            <ButtonLink to={selectedOrg ? `/new?owner=${selectedOrg}` : '/new'} size="sm">
              New collection
            </ButtonLink>
          </div>

          {filtered.length === 0 ? (
            <EmptyState>
              {collections.length === 0 ? (
                selectedOrg ? (
                  <span>
                    No collections in {selectedOrg} yet.{' '}
                    <Link to={`/new?owner=${selectedOrg}`} className="text-link hover:underline">
                      Create one
                    </Link>
                  </span>
                ) : (
                  <span>
                    No collections yet.{' '}
                    <Link to="/new" className="text-link hover:underline">
                      Create your first collection
                    </Link>
                  </span>
                )
              ) : (
                'No collections match your search.'
              )}
            </EmptyState>
          ) : (
            <div className="border-rule rounded-surface divide-rule divide-y overflow-hidden border">
              {filtered.map((c) => (
                <div
                  key={`${c.ownerSlug}/${c.slug}`}
                  className="hover:bg-parchment-dark/40 px-3 py-2.5 transition-colors"
                >
                  <div className="flex items-baseline gap-2">
                    <Link
                      to={`/${c.ownerSlug}/${c.slug}`}
                      className="text-link min-w-0 truncate text-sm font-medium hover:underline"
                    >
                      <span className="text-ink-muted font-normal">{c.ownerSlug}/</span>
                      {c.slug}
                    </Link>
                    {!c.public && (
                      <span className="border-rule text-ink-muted rounded-control shrink-0 border px-1 py-px font-mono text-[10px]">
                        private
                      </span>
                    )}
                    <span className="text-ink-muted ml-auto shrink-0 font-mono text-[11px]">
                      {c.latestVersion ? (
                        <>
                          v{c.latestVersion} · {(c.recordCount ?? 0).toLocaleString()} records
                          {c.totalBytes ? ` · ${formatBytes(c.totalBytes)}` : ''}
                          {c.lastPushAt ? ` · pushed ${timeAgo(c.lastPushAt)}` : ''}
                        </>
                      ) : (
                        <>empty · created {timeAgo(c.updatedAt)}</>
                      )}
                    </span>
                  </div>
                  {c.description && (
                    <p className="text-ink-muted mt-0.5 line-clamp-1 text-xs">{c.description}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </BaseLayout>
  )
}
