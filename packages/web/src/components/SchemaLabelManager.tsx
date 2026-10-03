import { useState } from 'react'

import { Button, Input } from '~/components/ui'

interface Label {
  label: string
  createdAt: string
}

interface Props {
  schemaId: string
  initialLabels: Label[]
}

export default function SchemaLabelManager({ schemaId, initialLabels }: Props) {
  const [labels, setLabels] = useState<Label[]>(initialLabels)
  const [newLabel, setNewLabel] = useState('')
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)

  async function addLabel(e: React.FormEvent) {
    e.preventDefault()
    if (!newLabel.trim()) return
    setAdding(true)
    setError('')

    try {
      const res = await fetch(`/api/schemas/${schemaId}/labels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: newLabel.trim() }),
      })

      if (res.status === 401) {
        setError('Login required')
        return
      }
      if (!res.ok) {
        const data = await res.json()
        setError(data.error ?? 'Failed to add label')
        return
      }

      const data = await res.json()
      if (data.status === 'created') {
        setLabels([...labels, { label: newLabel.trim(), createdAt: new Date().toISOString() }])
      }
      setNewLabel('')
    } catch {
      setError('Network error')
    } finally {
      setAdding(false)
    }
  }

  async function removeLabel(label: string) {
    try {
      const res = await fetch(`/api/schemas/${schemaId}/labels/${encodeURIComponent(label)}`, {
        method: 'DELETE',
      })

      if (res.status === 401) {
        setError('Login required')
        return
      }
      if (res.ok) {
        setLabels(labels.filter((l) => l.label !== label))
        setError('')
      } else {
        const data = await res.json()
        setError(data.error ?? 'Failed to remove label')
      }
    } catch {
      setError('Network error')
    }
  }

  return (
    <div className="mb-6">
      <h2 className="text-ink-muted mb-2 text-xs font-semibold tracking-wide uppercase">Labels</h2>

      {/* Existing labels */}
      {labels.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2">
          {labels.map((l) => (
            <span
              key={l.label}
              className="bg-parchment border-rule rounded-control group inline-flex items-center gap-2 border px-3 py-1.5 text-sm"
            >
              <span className="text-ink">{l.label}</span>
              <span className="text-ink-muted text-[11px]">
                {new Date(l.createdAt).toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                })}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => removeLabel(l.label)}
                className="ml-1 opacity-0 group-hover:opacity-100 hover:text-red-600"
                title="Remove label"
                aria-label={`Remove label ${l.label}`}
              >
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </Button>
            </span>
          ))}
        </div>
      )}

      {labels.length === 0 && <p className="text-ink-muted mb-3 text-xs">No labels yet.</p>}

      {/* Add label form */}
      <form onSubmit={addLabel} className="flex items-center gap-2">
        <Input
          type="text"
          placeholder="Add label (e.g. schema.org/Person)"
          className="placeholder:text-ink-muted w-64 px-2.5 py-1.5 font-mono text-xs"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
        />
        <Button type="submit" variant="secondary" size="sm" disabled={adding || !newLabel.trim()}>
          {adding ? 'Adding…' : 'Add'}
        </Button>
      </form>

      {error && <p className="mt-1.5 text-xs text-red-600">{error}</p>}
    </div>
  )
}
