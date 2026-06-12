import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'

interface Collection {
  id: string
  slug: string
  name: string
  description?: string
  tags?: string[]
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

interface TagFacet {
  name: string
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

type SortKey = 'featured' | 'updated' | 'name' | 'records'

export default function CollectionExplorer() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [query, setQuery] = useState(searchParams.get('q') ?? '')
  const [selectedOwner, setSelectedOwner] = useState<string | null>(searchParams.get('owner'))
  const [selectedTag, setSelectedTag] = useState<string | null>(searchParams.get('tag'))
  const initSort = searchParams.get('sort')
  const [sort, setSort] = useState<SortKey>(
    initSort === 'updated' || initSort === 'name' || initSort === 'records' ? initSort : 'featured',
  )
  const [collections, setCollections] = useState<Collection[]>([])
  const [owners, setOwners] = useState<OwnerFacet[]>([])
  const [tagFacets, setTagFacets] = useState<TagFacet[]>([])
  const [featuredTags, setFeaturedTags] = useState<string[]>([])
  const [featuredCollections, setFeaturedCollections] = useState<Collection[]>([])
  const [loading, setLoading] = useState(true)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  const isFiltered = !!(query || selectedOwner || selectedTag)

  function syncUrl(q: string, owner: string | null, sortBy: SortKey, tag: string | null) {
    const next = new URLSearchParams()
    if (q) next.set('q', q)
    if (owner) next.set('owner', owner)
    if (tag) next.set('tag', tag)
    if (sortBy !== 'featured') next.set('sort', sortBy)
    setSearchParams(next, { replace: true })
  }

  async function load(
    q = '',
    owner: string | null = null,
    sortBy: SortKey = sort,
    tag: string | null = selectedTag,
  ) {
    setLoading(true)
    syncUrl(q, owner, sortBy, tag)
    const params = new URLSearchParams()
    if (q) params.set('q', q)
    if (owner) params.set('owner', owner)
    if (tag) params.set('tag', tag)
    params.set('sort', sortBy)
    try {
      const res = await fetch(`/api/collections?${params}`)
      const data = await res.json()
      setCollections(data.collections)
      setOwners(data.facets.owners)
      setTagFacets(data.facets.tags ?? [])
      if (data.featuredTags) setFeaturedTags(data.featuredTags)
      if (data.featuredCollections) setFeaturedCollections(data.featuredCollections)
    } catch {
      setCollections([])
      setOwners([])
      setTagFacets([])
    }
    setLoading(false)
  }

  useEffect(() => {
    load(query, selectedOwner, sort, selectedTag)
  }, [])

  function handleInput(value: string) {
    setQuery(value)
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => load(value, selectedOwner, sort, selectedTag), 300)
  }

  function handleOwnerClick(ownerSlug: string | null) {
    setSelectedOwner(ownerSlug)
    load(query, ownerSlug, sort, selectedTag)
  }

  function handleTagClick(tag: string | null) {
    setSelectedTag(tag)
    load(query, selectedOwner, sort, tag)
  }

  function handleSortChange(value: string) {
    const s = value as SortKey
    setSort(s)
    load(query, selectedOwner, s, selectedTag)
  }

  const totalCount = owners.reduce((sum, o) => sum + o.count, 0)

  const visibleTags =
    featuredTags.length > 0
      ? featuredTags.filter((t) => tagFacets.some((f) => f.name === t))
      : tagFacets.slice(0, 12).map((f) => f.name)

  return (
    <div className="flex gap-8">
      {/* Sidebar facets */}
      {visibleTags.length > 0 && (
        <aside className="hidden w-44 shrink-0 space-y-6 md:block">
          {/* Tags */}
          {visibleTags.length > 0 && (
            <div>
              <h3 className="text-ink-muted mb-3 text-xs font-semibold tracking-wide uppercase">
                Topics
              </h3>
              <ul className="space-y-0.5">
                <li>
                  <button
                    onClick={() => handleTagClick(null)}
                    className={`w-full rounded-sm px-2.5 py-1.5 text-left text-sm transition-colors ${
                      !selectedTag
                        ? 'bg-parchment-dark text-ink font-medium'
                        : 'text-ink-muted hover:bg-parchment-dark/50 hover:text-ink'
                    }`}
                  >
                    All
                  </button>
                </li>
                {visibleTags.map((tag) => (
                  <li key={tag}>
                    <button
                      onClick={() => handleTagClick(tag)}
                      className={`w-full rounded-sm px-2.5 py-1.5 text-left text-sm transition-colors ${
                        selectedTag === tag
                          ? 'bg-parchment-dark text-ink font-medium'
                          : 'text-ink-muted hover:bg-parchment-dark/50 hover:text-ink'
                      }`}
                    >
                      {tag}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>
      )}

      {/* Main content */}
      <div className="min-w-0 flex-1">
        {/* Search + sort bar (always at top, never moves) */}
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
            <option value="featured">Featured</option>
            <option value="records">Most records</option>
            <option value="updated">Recent</option>
            <option value="name">Name</option>
          </select>
        </div>

        {/* Featured collections hero */}
        {featuredCollections.length > 0 && !isFiltered && (
          <div className="mb-6">
            <h3 className="text-ink-muted mb-3 text-xs font-semibold tracking-wide uppercase">
              Featured
            </h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {featuredCollections.map((c) => (
                <Link
                  key={`feat-${c.ownerSlug}/${c.slug}`}
                  to={`/${c.ownerSlug}/${c.slug}`}
                  className="border-rule hover:border-ink-muted/50 group rounded-sm border p-4 transition-all hover:shadow-sm"
                >
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-ink-muted text-xs">{c.ownerSlug}/</span>
                    <span className="text-sm font-semibold">{c.slug}</span>
                  </div>
                  {c.description && (
                    <p className="text-ink-muted mt-1.5 line-clamp-2 text-xs leading-relaxed">
                      {c.description}
                    </p>
                  )}
                  <div className="text-ink-muted mt-3 flex items-center gap-3 text-xs tabular-nums">
                    {c.recordCount != null && <span>{formatCount(c.recordCount)} records</span>}
                    {c.tags && c.tags.length > 0 && (
                      <span className="bg-parchment-dark rounded px-1.5 py-0.5 text-[10px] leading-none">
                        {c.tags[0]}
                      </span>
                    )}
                  </div>
                </Link>
              ))}
            </div>
          </div>
        )}

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
              {query || selectedOwner || selectedTag
                ? 'No collections match your filters.'
                : 'No public collections yet.'}
            </p>
          </div>
        ) : (
          <>
            <p className="text-ink-muted mb-3 text-xs">
              {collections.length} collection{collections.length !== 1 ? 's' : ''}
              {selectedTag && ` in ${selectedTag}`}
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
                      {c.tags && c.tags.length > 0 && (
                        <span className="flex gap-1">
                          {c.tags.slice(0, 2).map((tag) => (
                            <span
                              key={tag}
                              className="bg-parchment-dark text-ink-muted rounded px-1.5 py-0.5 text-[10px] leading-none"
                            >
                              {tag}
                            </span>
                          ))}
                        </span>
                      )}
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
