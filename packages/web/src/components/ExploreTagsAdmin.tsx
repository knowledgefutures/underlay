import { useEffect, useState } from 'react'

import { Button, Input } from '~/components/ui'

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
    return <p className="text-ink-muted text-sm">Loading…</p>
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
          <div
            key={tag}
            className="border-rule rounded-surface flex items-center gap-2 border px-3 py-2"
          >
            <span className="flex-1 text-sm">{tag}</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => moveTag(i, -1)}
              disabled={i === 0 || saving}
              aria-label={`Move ${tag} up`}
            >
              &uarr;
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => moveTag(i, 1)}
              disabled={i === tags.length - 1 || saving}
              aria-label={`Move ${tag} down`}
            >
              &darr;
            </Button>
            <Button variant="dangerLink" size="sm" onClick={() => removeTag(tag)} disabled={saving}>
              Remove
            </Button>
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
        <Input
          type="text"
          value={newTag}
          onChange={(e) => setNewTag(e.target.value)}
          placeholder="New tag name…"
          className="placeholder:text-ink-muted flex-1"
        />
        <Button type="submit" disabled={!newTag.trim() || saving}>
          Add
        </Button>
      </form>

      {message && <p className="text-ink-muted text-xs">{message}</p>}
    </div>
  )
}
