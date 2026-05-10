import { useState, useEffect } from 'react'
import BaseLayout from '~/components/BaseLayout'
import SchemaLabelManager from '~/components/SchemaLabelManager'
import { useSSRData } from '~/lib/ssr-data'

interface SchemaData {
  id: number
  schemaHash: string
  schema: Record<string, any>
  createdAt: string
  labels?: { label: string; createdAt: string }[]
  usage?: { slug: string; semver: string; versionNumber: number; collection: string }[]
}

export default function SchemaDetailPage() {
  const schemaId = useSSRData<string>('schemaId')
  const [schema, setSchema] = useState<SchemaData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!schemaId) return
    fetch(`/api/schemas/${schemaId}`, { credentials: 'same-origin' })
      .then(async (res) => {
        if (!res.ok) {
          setError('Schema not found.')
          return
        }
        setSchema(await res.json())
      })
      .catch(() => setError('Failed to load schema.'))
      .finally(() => setLoading(false))
  }, [schemaId])

  if (loading) {
    return (
      <BaseLayout>
        <div className="max-w-5xl mx-auto px-4 py-10">
          <p className="text-sm text-ink-muted">Loading…</p>
        </div>
      </BaseLayout>
    )
  }

  if (error || !schema) {
    return (
      <BaseLayout>
        <div className="max-w-5xl mx-auto px-4 py-10">
          <p className="text-sm text-red-700">{error || 'Schema not found.'}</p>
        </div>
      </BaseLayout>
    )
  }

  const properties = (schema.schema as any)?.properties ?? {}
  const fields = Object.entries(properties)
  const isPrivate = (schema.schema as any)?.private === true
  const labels: { label: string; createdAt: string }[] = schema.labels ?? []
  const usage: { slug: string; semver: string; versionNumber: number; collection: string }[] = schema.usage ?? []

  return (
    <BaseLayout>
      <div className="max-w-5xl mx-auto px-4 py-10">
        {/* Header */}
        <div className="mb-6">
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-lg font-semibold font-mono">{schema.schemaHash.slice(0, 16)}…</h1>
            {isPrivate && <span className="text-xs border border-rule px-1.5 py-0.5 text-ink-muted">private type</span>}
          </div>
          <div className="flex items-center gap-4 text-xs text-ink-muted">
            <span>Created {new Date(schema.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
            <span>{fields.length} field{fields.length !== 1 ? 's' : ''}</span>
            <span>{usage.length} collection{usage.length !== 1 ? 's' : ''} using this schema</span>
          </div>
        </div>

        {/* Labels (interactive) */}
        <SchemaLabelManager schemaId={String(schema.id)} initialLabels={labels} />

        {/* Two-column layout: fields + JSON */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
          {/* Fields table */}
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-muted mb-2">Fields</h2>
            <div className="border border-rule rounded overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-parchment-dark border-b border-rule">
                    <th className="text-left p-2.5 font-medium">Name</th>
                    <th className="text-left p-2.5 font-medium">Type</th>
                    <th className="text-left p-2.5 font-medium">Info</th>
                  </tr>
                </thead>
                <tbody>
                  {fields.map(([name, def]: [string, any]) => {
                    const fieldType = def.type ?? 'unknown'
                    const format = def.format ? ` (${def.format})` : ''
                    const refType = def['x-ref-type']
                    const isFieldPrivate = def.private === true

                    return (
                      <tr key={name} className="border-t border-rule">
                        <td className="p-2.5 font-mono font-medium">{name}</td>
                        <td className="p-2.5 text-ink-muted">{fieldType}{format}</td>
                        <td className="p-2.5">
                          <div className="flex items-center gap-2">
                            {refType && (
                              <span className="inline-flex items-center gap-1 text-[11px] bg-parchment-dark border border-rule px-1.5 py-0.5 rounded">
                                → {refType}
                              </span>
                            )}
                            {isFieldPrivate && (
                              <span className="text-[11px] border border-rule px-1.5 py-0.5 rounded text-ink-muted">private</span>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Raw JSON */}
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-muted mb-2">JSON Schema</h2>
            <div className="border border-rule rounded overflow-hidden">
              <pre className="p-4 text-xs font-mono overflow-x-auto bg-ink text-parchment max-h-96"><code>{JSON.stringify(schema.schema, null, 2)}</code></pre>
            </div>
          </div>
        </div>

        {/* Usage: which collections reference this schema */}
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-muted mb-2">
            Used by {usage.length} collection{usage.length !== 1 ? 's' : ''}
          </h2>
          {usage.length === 0 ? (
            <p className="text-sm text-ink-muted py-4">No public collections reference this schema yet.</p>
          ) : (
            <div className="border border-rule rounded overflow-hidden">
              {usage.map((u, i) => (
                <a
                  key={`${u.collection}-${u.slug}`}
                  href={`/${u.collection}/v/${u.versionNumber}?type=${u.slug}`}
                  className={`flex items-center justify-between px-4 py-2.5 text-sm hover:bg-parchment-dark/50 transition-colors ${i < usage.length - 1 ? 'border-b border-rule' : ''}`}
                >
                  <div className="flex items-center gap-3">
                    <span className="font-medium">{u.collection}</span>
                    <span className="text-ink-muted text-xs">as <code className="font-mono">{u.slug}</code></span>
                  </div>
                  <span className="text-xs text-ink-muted">{u.semver}</span>
                </a>
              ))}
            </div>
          )}
        </div>

        {/* Full hash */}
        <div className="mt-8 pt-4 border-t border-rule">
          <p className="text-xs text-ink-muted">
            <span className="font-medium">Full hash:</span>
            <code className="font-mono ml-2">{schema.schemaHash}</code>
          </p>
          <p className="text-xs text-ink-muted mt-1">
            <span className="font-medium">ID:</span>
            <code className="font-mono ml-2">{schema.id}</code>
          </p>
        </div>
      </div>
    </BaseLayout>
  )
}
