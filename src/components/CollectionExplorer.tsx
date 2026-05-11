import { useEffect, useRef, useState, } from 'react'
import { Link, } from 'react-router'

interface Collection {
  ownerSlug: string
  slug: string
  name: string
  description?: string
}

export default function CollectionExplorer() {
  const [query, setQuery,] = useState('',)
  const [collections, setCollections,] = useState<Collection[]>([],)
  const [loading, setLoading,] = useState(true,)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined,)

  async function load(q = '',) {
    const params = new URLSearchParams()
    if (q) params.set('q', q,)
    try {
      const res = await fetch(`/api/collections?${params}`,)
      const data = await res.json()
      setCollections(data,)
    } catch {
      setCollections([],)
    }
    setLoading(false,)
  }

  useEffect(() => {
    load()
  }, [],)

  function handleInput(value: string,) {
    setQuery(value,)
    clearTimeout(timerRef.current,)
    timerRef.current = setTimeout(() => load(value,), 300,)
  }

  return (
    <>
      <div className='flex gap-3 mb-6'>
        <input
          type='search'
          placeholder='Search collections...'
          className='flex-1 bg-parchment border border-rule px-3 py-2 text-sm font-mono placeholder:text-ink-muted focus:outline-none focus:border-ink'
          value={query}
          onChange={(e,) => handleInput(e.target.value,)}
        />
      </div>

      <div className='space-y-2'>
        {loading
          ? <p className='text-sm text-ink-muted'>Loading...</p>
          : collections.length === 0
          ? <p className='text-sm text-ink-muted'>No collections found.</p>
          : (
            collections.map((c,) => (
              <Link
                key={`${c.ownerSlug}/${c.slug}`}
                to={`/${c.ownerSlug}/${c.slug}`}
                className='block border border-rule p-3 hover:bg-parchment-dark transition-colors'
              >
                <div className='flex items-center gap-2 mb-1'>
                  <span className='font-semibold text-sm'>
                    {c.ownerSlug}/{c.slug}
                  </span>
                </div>
                <p className='text-xs text-ink-muted'>{c.description ?? c.name}</p>
              </Link>
            ))
          )}
      </div>
    </>
  )
}
