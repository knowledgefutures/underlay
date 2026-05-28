import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'

interface Collection {
  id: string
  slug: string
  name: string
  description?: string
  ownerSlug: string
  ownerName?: string
  createdAt: string
  updatedAt: string
  latestVersion: number | null
  semver: string | null
  recordCount: number | null
  fileCount: number | null
  totalBytes: number | null
  lastPushAt: string | null
}

interface OwnerFacet {
  slug: string
  name: string | null
  count: number
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function formatCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
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

export default function CollectionExplorer() {
  const [query, setQuery] = useState('')
  const [selectedOwner, setSelectedOwner] = useState<string | null>(null)
  const [sort, setSort] = useState<'updated' | 'name'>('updated')
  const [collections, setCollections] = useState<Collection[]>([])
  const [owners, setOwners] = useState<OwnerFacet[]>([])
  const [loading, setLoading] = useState(true)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  async function load(q = '', owner: string | null = null, sortBy = sort) {
    setLoading(true)
    const params = new URLSearchParams()
    if (q) params.set('q', q)
    if (owner) params.set('owner', owner)
    params.set('sort', sortBy)
    try {
      const res = await fetch(`/api/collections?${params}`)
      const data = await res.json()
      setCollections(data.collections)
      setOwners(data.facets.owners)
    } catch {
      setCollections([])
      setOwners([])
    }
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  function handleInput(value: string) {
    setQuery(value)
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => load(value, selectedOwner), 300)
  }

  function handleOwnerClick(ownerSlug: string | null) {
    setSelectedOwner(ownerSlug)
    load(query, ownerSlug)
  }

  function handleSortChange(value: string) {
    const s = value as 'updated' | 'name'
    setSort(s)
    load(query, selectedOwner, s)
  }

  const totalCount = owners.reduce((sum, o) => sum + o.count, 0)

  return (
    <div className="flex gap-8">
      {/* Sidebar facets */}
      {owners.length > 0 && (
        <aside className="hidden w-44 shrink-0 md:block">
          <h3 className="text-ink-muted mb-3 text-xs font-semibold tracking-wide uppercase">
            Organizations
          </h3>
          <ul className="space-y-0.5">
            <li>
              <button
                onClick={() => handleOwnerClick(null)}
                className={`flex w-full items-center justify-between rounded-sm px-2.5 py-1.5 text-left text-sm transition-colors ${
                  !selectedOwner
                    ? 'bg-parchment-dark text-ink font-medium'
                    : 'text-ink-muted hover:bg-parchment-dark/50 hover:text-ink'
                }`}
              >
                <span>All</span>
                <span className="text-ink-muted text-xs">{totalCount}</span>
              </button>
            </li>
            {owners.map((o) => (
              <li key={o.slug}>
                <button
                  onClick={() => handleOwnerClick(o.slug)}
                  className={`flex w-full items-center justify-between rounded-sm px-2.5 py-1.5 text-left text-sm transition-colors ${
                    selectedOwner === o.slug
                      ? 'bg-parchment-dark text-ink font-medium'
                      : 'text-ink-muted hover:bg-parchment-dark/50 hover:text-ink'
                  }`}
                >
                  <span className="truncate">{o.name ?? o.slug}</span>
                  <span className="text-ink-muted ml-2 shrink-0 text-xs">{o.count}</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>
      )}

      {/* Main content */}
      <div className="min-w-0 flex-1">
        {/* Search + sort bar */}
        <div className="mb-5 flex gap-3">
          <div className="relative flex-1">
            <svg
              className="text-ink-muted pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
            <input
              type="search"
              placeholder="Search collections..."
              className="bg-parchment border-rule placeholder:text-ink-muted focus:border-ink w-full rounded-sm border py-2 pr-3 pl-10 text-sm focus:outline-none"
              value={query}
              onChange={(e) => handleInput(e.target.value)}
            />
          </div>
          <select
            value={sort}
            onChange={(e) => handleSortChange(e.target.value)}
            className="bg-parchment border-rule text-ink-muted rounded-sm border px-3 py-2 text-sm focus:outline-none"
          >
            <option value="updated">Recent</option>
            <option value="name">Name</option>
          </select>
        </div>

        {/* Mobile owner filter */}
        {owners.length > 0 && (
          <div className="mb-4 flex flex-wrap gap-1.5 md:hidden">
            <button
              onClick={() => handleOwnerClick(null)}
              className={`rounded-full px-3 py-1 text-xs transition-colors ${
                !selectedOwner
                  ? 'bg-ink text-parchment'
                  : 'bg-parchment-dark text-ink-muted hover:text-ink'
              }`}
            >
              All
            </button>
            {owners.map((o) => (
              <button
                key={o.slug}
                onClick={() => handleOwnerClick(o.slug)}
                className={`rounded-full px-3 py-1 text-xs transition-colors ${
                  selectedOwner === o.slug
                    ? 'bg-ink text-parchment'
                    : 'bg-parchment-dark text-ink-muted hover:text-ink'
                }`}
              >
                {o.name ?? o.slug}
              </button>
            ))}
          </div>
        )}

        {loading ? (
          <p className="text-ink-muted py-8 text-center text-sm">Loading...</p>
        ) : collections.length === 0 ? (
          <div className="py-12 text-center">
            <p className="text-ink-muted text-sm">
              {query || selectedOwner
                ? 'No collections match your search.'
                : 'No public collections yet.'}
            </p>
          </div>
        ) : (
          <>
            <p className="text-ink-muted mb-3 text-xs">
              {collections.length} collection{collections.length !== 1 ? 's' : ''}
              {selectedOwner && ` from ${selectedOwner}`}
              {query && ` matching "${query}"`}
            </p>
            <div className="space-y-2">
              {collections.map((c) => (
                <Link
                  key={`${c.ownerSlug}/${c.slug}`}
                  to={`/${c.ownerSlug}/${c.slug}`}
                  className="border-rule hover:border-ink-muted/50 group flex items-start gap-4 rounded-sm border px-3 py-2.5 transition-all hover:shadow-sm"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-ink-muted text-xs">{c.ownerSlug}/</span>
                      <span className="text-sm font-semibold">{c.slug}</span>
                    </div>
                    {c.description && (
                      <p className="text-ink-muted mt-0.5 line-clamp-1 text-xs leading-relaxed">
                        {c.description}
                      </p>
                    )}
                  </div>
                  <div className="text-ink-muted flex shrink-0 items-center gap-3 pt-0.5 text-xs tabular-nums">
                    {c.semver && <span className="font-mono">{c.semver}</span>}
                    {c.recordCount != null && (
                      <span className="w-14 text-right">{formatCount(c.recordCount)} rec</span>
                    )}
                    {c.totalBytes != null && c.totalBytes > 0 && (
                      <span className="hidden w-14 text-right sm:inline">
                        {formatBytes(c.totalBytes)}
                      </span>
                    )}
                    {c.lastPushAt && (
                      <span className="w-16 text-right">{timeAgo(c.lastPushAt)}</span>
                    )}
                  </div>
                </Link>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
