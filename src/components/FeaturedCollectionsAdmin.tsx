import { useEffect, useState } from 'react'

interface CollectionOption {
  ownerSlug: string
  slug: string
  name: string
  description: string | null
  recordCount: number | null
}

export default function FeaturedCollectionsAdmin() {
  const [featured, setFeatured] = useState<string[]>([])
  const [allCollections, setAllCollections] = useState<CollectionOption[]>([])
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([
      fetch('/api/admin/explore-collections')
        .then((r) => r.json())
        .then((data) => data.collections ?? []),
      fetch('/api/collections?limit=100&sort=name')
        .then((r) => r.json())
        .then((data) => data.collections ?? []),
    ])
      .then(([feat, all]) => {
        setFeatured(feat)
        setAllCollections(all)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  async function save(updated: string[]) {
    setSaving(true)
    setMessage(null)
    try {
      const res = await fetch('/api/admin/explore-collections', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collections: updated }),
      })
      if (res.ok) {
        setFeatured(updated)
        setMessage('Saved')
      } else {
        const data = await res.json()
        setMessage(data.error ?? 'Failed to save')
      }
    } catch {
      setMessage('Failed to save')
    }
    setSaving(false)
  }

  function addCollection(slug: string) {
    if (featured.includes(slug)) return
    save([...featured, slug])
  }

  function removeCollection(slug: string) {
    save(featured.filter((s) => s !== slug))
  }

  function moveCollection(index: number, direction: -1 | 1) {
    const target = index + direction
    if (target < 0 || target >= featured.length) return
    const updated = [...featured]
    ;[updated[index], updated[target]] = [updated[target]!, updated[index]!]
    save(updated)
  }

  const available = allCollections.filter((c) => !featured.includes(`${c.ownerSlug}/${c.slug}`))

  if (loading) {
    return <p className="text-ink-muted text-sm">Loading...</p>
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="mb-1 text-lg font-semibold">Featured Collections</h2>
        <p className="text-ink-muted text-sm">
          These collections appear in a hero row at the top of the explore page. Pick 3-6 that
          showcase diversity.
        </p>
      </div>

      <div className="space-y-1.5">
        {featured.length === 0 && (
          <p className="text-ink-muted text-sm">
            No featured collections yet. The hero row won't appear.
          </p>
        )}
        {featured.map((slug, i) => {
          const col = allCollections.find((c) => `${c.ownerSlug}/${c.slug}` === slug)
          return (
            <div
              key={slug}
              className="border-rule flex items-center gap-2 rounded border px-3 py-2"
            >
              <div className="flex-1">
                <span className="text-sm font-medium">{slug}</span>
                {col?.description && (
                  <p className="text-ink-muted line-clamp-1 text-xs">{col.description}</p>
                )}
              </div>
              <button
                onClick={() => moveCollection(i, -1)}
                disabled={i === 0 || saving}
                className="text-ink-muted hover:text-ink text-xs disabled:opacity-30"
              >
                &uarr;
              </button>
              <button
                onClick={() => moveCollection(i, 1)}
                disabled={i === featured.length - 1 || saving}
                className="text-ink-muted hover:text-ink text-xs disabled:opacity-30"
              >
                &darr;
              </button>
              <button
                onClick={() => removeCollection(slug)}
                disabled={saving}
                className="text-ink-muted text-xs hover:text-red-600"
              >
                Remove
              </button>
            </div>
          )
        })}
      </div>

      {available.length > 0 && (
        <div>
          <label className="text-ink-muted mb-1 block text-xs font-medium">Add a collection</label>
          <select
            onChange={(e) => {
              if (e.target.value) addCollection(e.target.value)
              e.target.value = ''
            }}
            disabled={saving}
            className="bg-parchment border-rule text-ink-muted w-full rounded border px-3 py-2 text-sm focus:outline-none"
            defaultValue=""
          >
            <option value="" disabled>
              Select a collection...
            </option>
            {available.map((c) => (
              <option key={`${c.ownerSlug}/${c.slug}`} value={`${c.ownerSlug}/${c.slug}`}>
                {c.ownerSlug}/{c.slug} — {c.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {message && <p className="text-ink-muted text-xs">{message}</p>}
    </div>
  )
}
