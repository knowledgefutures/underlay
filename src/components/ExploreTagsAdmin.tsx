import { useEffect, useState } from 'react'

export default function ExploreTagsAdmin() {
  const [tags, setTags] = useState<string[]>([])
  const [newTag, setNewTag] = useState('')
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/admin/explore-tags')
      .then((r) => r.json())
      .then((data) => setTags(data.tags ?? []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  async function save(updated: string[]) {
    setSaving(true)
    setMessage(null)
    try {
      const res = await fetch('/api/admin/explore-tags', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: updated }),
      })
      if (res.ok) {
        setTags(updated)
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

  function addTag() {
    const tag = newTag.trim()
    if (!tag || tags.includes(tag)) return
    const updated = [...tags, tag]
    setNewTag('')
    save(updated)
  }

  function removeTag(tag: string) {
    save(tags.filter((t) => t !== tag))
  }

  function moveTag(index: number, direction: -1 | 1) {
    const target = index + direction
    if (target < 0 || target >= tags.length) return
    const updated = [...tags]
    ;[updated[index], updated[target]] = [updated[target]!, updated[index]!]
    save(updated)
  }

  if (loading) {
    return <p className="text-ink-muted text-sm">Loading...</p>
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="mb-1 text-lg font-semibold">Explore Page Tags</h2>
        <p className="text-ink-muted text-sm">
          These tags appear as filter chips on the explore page. Collections set their own tags in
          version metadata; this list controls which tags are featured.
        </p>
      </div>

      <div className="space-y-1.5">
        {tags.length === 0 && (
          <p className="text-ink-muted text-sm">
            No featured tags yet. The explore page will show the most common tags automatically.
          </p>
        )}
        {tags.map((tag, i) => (
          <div key={tag} className="border-rule flex items-center gap-2 rounded border px-3 py-2">
            <span className="flex-1 text-sm">{tag}</span>
            <button
              onClick={() => moveTag(i, -1)}
              disabled={i === 0 || saving}
              className="text-ink-muted hover:text-ink text-xs disabled:opacity-30"
            >
              &uarr;
            </button>
            <button
              onClick={() => moveTag(i, 1)}
              disabled={i === tags.length - 1 || saving}
              className="text-ink-muted hover:text-ink text-xs disabled:opacity-30"
            >
              &darr;
            </button>
            <button
              onClick={() => removeTag(tag)}
              disabled={saving}
              className="text-ink-muted text-xs hover:text-red-600"
            >
              Remove
            </button>
          </div>
        ))}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          addTag()
        }}
        className="flex gap-2"
      >
        <input
          type="text"
          value={newTag}
          onChange={(e) => setNewTag(e.target.value)}
          placeholder="New tag name..."
          className="bg-parchment border-rule placeholder:text-ink-muted flex-1 rounded border px-3 py-2 text-sm focus:outline-none"
        />
        <button
          type="submit"
          disabled={!newTag.trim() || saving}
          className="bg-ink text-parchment disabled:bg-ink/50 rounded px-4 py-2 text-sm"
        >
          Add
        </button>
      </form>

      {message && <p className="text-ink-muted text-xs">{message}</p>}
    </div>
  )
}
