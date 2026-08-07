import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'

import { Badge } from '~/components/ui'

interface SchemaResult {
  id: string
  schema: Record<string, unknown>
  schemaHash: string
  createdAt: string
  labels: string[]
}

export default function SchemaBrowser() {
  const [query, setQuery] = useState('')
  const [filterType, setFilterType] = useState<'q' | 'label' | 'slug'>('q')
  const [schemas, setSchemas] = useState<SchemaResult[]>([])
  const [loading, setLoading] = useState(true)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  async function load(q = '', type = filterType) {
    setLoading(true)
    const params = new URLSearchParams()
    if (q) params.set(type, q)
    params.set('limit', '50')
    try {
      const res = await fetch(`/api/schemas?${params}`)
      const data = await res.json()
      setSchemas(Array.isArray(data) ? data : data.id ? [data] : [])
    } catch {
      setSchemas([])
    }
    setLoading(false)
  }

  useEffect(() => {
    load()
  }, [])

  function handleInput(value: string) {
    setQuery(value)
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => load(value, filterType), 300)
  }

  function handleFilterChange(type: 'q' | 'label' | 'slug') {
    setFilterType(type)
    if (query) {
      clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => load(query, type), 100)
    }
  }

  return (
    <>
      <div className="mb-6 flex gap-2">
        <input
          type="search"
          placeholder={
            filterType === 'q'
              ? 'Search schema content...'
              : filterType === 'label'
                ? 'Search by label...'
                : 'Search by type name...'
          }
          className="bg-parchment border-rule placeholder:text-ink-muted focus:border-ink rounded-control flex-1 border px-3 py-2 font-mono text-sm focus:outline-none"
          value={query}
          onChange={(e) => handleInput(e.target.value)}
        />
        <div className="border-rule rounded-control flex overflow-hidden border text-xs">
          <button
            onClick={() => handleFilterChange('q')}
            className={`cursor-pointer px-3 py-2 transition-colors ${
              filterType === 'q' ? 'bg-ink text-parchment' : 'hover:bg-parchment-dark'
            }`}
          >
            Content
          </button>
          <button
            onClick={() => handleFilterChange('slug')}
            className={`border-rule cursor-pointer border-l px-3 py-2 transition-colors ${
              filterType === 'slug' ? 'bg-ink text-parchment' : 'hover:bg-parchment-dark'
            }`}
          >
            Type
          </button>
          <button
            onClick={() => handleFilterChange('label')}
            className={`border-rule cursor-pointer border-l px-3 py-2 transition-colors ${
              filterType === 'label' ? 'bg-ink text-parchment' : 'hover:bg-parchment-dark'
            }`}
          >
            Label
          </button>
        </div>
      </div>

      <div className="space-y-2">
        {loading ? (
          <p className="text-ink-muted py-8 text-center text-sm">Loading...</p>
        ) : schemas.length === 0 ? (
          <p className="text-ink-muted py-8 text-center text-sm">No schemas found.</p>
        ) : (
          schemas.map((s) => {
            const properties = (s.schema as any)?.properties ?? {}
            const fieldNames = Object.keys(properties)
            const isPrivate = (s.schema as any)?.private === true

            return (
              <Link
                key={s.id}
                to={`/schemas/${s.id}`}
                className="border-rule rounded-surface hover:bg-parchment-dark/50 block border p-4 transition-colors"
              >
                <div className="mb-2 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <code className="text-ink-muted font-mono text-xs">
                      {s.schemaHash.slice(0, 12)}…
                    </code>
                    {isPrivate && <Badge>private</Badge>}
                  </div>
                  <span className="text-ink-muted text-[11px]">
                    {new Date(s.createdAt).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </span>
                </div>

                {/* Field summary */}
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {fieldNames.slice(0, 8).map((name) => (
                    <span
                      key={name}
                      className="bg-parchment-dark border-rule rounded-control border px-1.5 py-0.5 font-mono text-[11px]"
                    >
                      {name}
                    </span>
                  ))}
                  {fieldNames.length > 8 && (
                    <span className="text-ink-muted px-1.5 py-0.5 text-[11px]">
                      +{fieldNames.length - 8} more
                    </span>
                  )}
                </div>

                {/* Labels */}
                {s.labels.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {s.labels.map((label) => (
                      <span
                        key={label}
                        className="text-link rounded-control border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[11px]"
                      >
                        {label}
                      </span>
                    ))}
                  </div>
                )}
              </Link>
            )
          })
        )}
      </div>
    </>
  )
}
