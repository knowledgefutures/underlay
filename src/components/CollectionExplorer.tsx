import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'

interface Collection {
  ownerSlug: string
  slug: string
  name: string
  description?: string
}

export default function CollectionExplorer() {
  const [query, setQuery] = useState('')
  const [collections, setCollections] = useState<Collection[]>([])
  const [loading, setLoading] = useState(true)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  async function load(q = '') {
    const params = new URLSearchParams()
    if (q) params.set('q', q)
    try {
      const res = await fetch(`/api/collections?${params}`)
      const data = await res.json()
      setCollections(data)
    } catch {
      setCollections([])
    }
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  function handleInput(value: string) {
    setQuery(value)
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => load(value), 300)
  }

  return (
    <>
      <div className="mb-6 flex gap-3">
        <input
          type="search"
          placeholder="Search collections..."
          className="bg-parchment border-rule placeholder:text-ink-muted focus:border-ink flex-1 border px-3 py-2 font-mono text-sm focus:outline-none"
          value={query}
          onChange={(e) => handleInput(e.target.value)}
        />
      </div>

      <div className="space-y-2">
        {loading ? (
          <p className="text-ink-muted text-sm">Loading...</p>
        ) : collections.length === 0 ? (
          <p className="text-ink-muted text-sm">No collections found.</p>
        ) : (
          collections.map((c) => (
            <Link
              key={`${c.ownerSlug}/${c.slug}`}
              to={`/${c.ownerSlug}/${c.slug}`}
              className="border-rule hover:bg-parchment-dark block border p-3 transition-colors"
            >
              <div className="mb-1 flex items-center gap-2">
                <span className="text-sm font-semibold">
                  {c.ownerSlug}/{c.slug}
                </span>
              </div>
              <p className="text-ink-muted text-xs">{c.description ?? c.name}</p>
            </Link>
          ))
        )}
      </div>
    </>
  )
}
