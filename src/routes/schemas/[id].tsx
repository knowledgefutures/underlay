import { useEffect, useState } from 'react'
import { Link } from 'react-router'

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
        <div className="mx-auto max-w-5xl px-4 py-10">
          <p className="text-ink-muted text-sm">Loading…</p>
        </div>
      </BaseLayout>
    )
  }

  if (error || !schema) {
    return (
      <BaseLayout>
        <div className="mx-auto max-w-5xl px-4 py-10">
          <p className="text-sm text-red-700">{error || 'Schema not found.'}</p>
        </div>
      </BaseLayout>
    )
  }

  const properties = (schema.schema as any)?.properties ?? {}
  const fields = Object.entries(properties)
  const isPrivate = (schema.schema as any)?.private === true
  const labels: { label: string; createdAt: string }[] = schema.labels ?? []
  const usage: { slug: string; semver: string; versionNumber: number; collection: string }[] =
    schema.usage ?? []

  return (
    <BaseLayout>
      <div className="mx-auto max-w-5xl px-4 py-10">
        {/* Header */}
        <div className="mb-6">
          <div className="mb-2 flex items-center gap-3">
            <h1 className="font-mono text-lg font-semibold">{schema.schemaHash.slice(0, 16)}…</h1>
            {isPrivate && (
              <span className="border-rule text-ink-muted border px-1.5 py-0.5 text-xs">
                private type
              </span>
            )}
          </div>
          <div className="text-ink-muted flex items-center gap-4 text-xs">
            <span>
              Created{' '}
              {new Date(schema.createdAt).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })}
            </span>
            <span>
              {fields.length} field{fields.length !== 1 ? 's' : ''}
            </span>
            <span>
              {usage.length} collection{usage.length !== 1 ? 's' : ''} using this schema
            </span>
          </div>
        </div>

        {/* Labels (interactive) */}
        <SchemaLabelManager schemaId={String(schema.id)} initialLabels={labels} />

        {/* Two-column layout: fields + JSON */}
        <div className="mb-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Fields table */}
          <div>
            <h2 className="text-ink-muted mb-2 text-xs font-semibold tracking-wide uppercase">
              Fields
            </h2>
            <div className="border-rule overflow-hidden rounded border">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-parchment-dark border-rule border-b">
                    <th className="p-2.5 text-left font-medium">Name</th>
                    <th className="p-2.5 text-left font-medium">Type</th>
                    <th className="p-2.5 text-left font-medium">Info</th>
                  </tr>
                </thead>
                <tbody>
                  {fields.map(([name, def]: [string, any]) => {
                    const fieldType = def.type ?? 'unknown'
                    const format = def.format ? ` (${def.format})` : ''
                    const refType = def['x-ref-type']
                    const isFieldPrivate = def.private === true

                    return (
                      <tr key={name} className="border-rule border-t">
                        <td className="p-2.5 font-mono font-medium">{name}</td>
                        <td className="text-ink-muted p-2.5">
                          {fieldType}
                          {format}
                        </td>
                        <td className="p-2.5">
                          <div className="flex items-center gap-2">
                            {refType && (
                              <span className="bg-parchment-dark border-rule inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px]">
                                → {refType}
                              </span>
                            )}
                            {isFieldPrivate && (
                              <span className="border-rule text-ink-muted rounded border px-1.5 py-0.5 text-[11px]">
                                private
                              </span>
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
            <h2 className="text-ink-muted mb-2 text-xs font-semibold tracking-wide uppercase">
              JSON Schema
            </h2>
            <div className="border-rule overflow-hidden rounded border">
              <pre className="bg-ink text-parchment max-h-96 overflow-x-auto p-4 font-mono text-xs">
                <code>{JSON.stringify(schema.schema, null, 2)}</code>
              </pre>
            </div>
          </div>
        </div>

        {/* Usage: which collections reference this schema */}
        <div>
          <h2 className="text-ink-muted mb-2 text-xs font-semibold tracking-wide uppercase">
            Used by {usage.length} collection{usage.length !== 1 ? 's' : ''}
          </h2>
          {usage.length === 0 ? (
            <p className="text-ink-muted py-4 text-sm">
              No public collections reference this schema yet.
            </p>
          ) : (
            <div className="border-rule overflow-hidden rounded border">
              {usage.map((u, i) => (
                <Link
                  key={`${u.collection}-${u.slug}`}
                  to={`/${u.collection}/v/${u.versionNumber}?type=${u.slug}`}
                  className={`hover:bg-parchment-dark/50 flex items-center justify-between px-4 py-2.5 text-sm transition-colors ${
                    i < usage.length - 1 ? 'border-rule border-b' : ''
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <span className="font-medium">{u.collection}</span>
                    <span className="text-ink-muted text-xs">
                      as <code className="font-mono">{u.slug}</code>
                    </span>
                  </div>
                  <span className="text-ink-muted text-xs">{u.semver}</span>
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* Full hash */}
        <div className="border-rule mt-8 border-t pt-4">
          <p className="text-ink-muted text-xs">
            <span className="font-medium">Full hash:</span>
            <code className="ml-2 font-mono">{schema.schemaHash}</code>
          </p>
          <p className="text-ink-muted mt-1 text-xs">
            <span className="font-medium">ID:</span>
            <code className="ml-2 font-mono">{schema.id}</code>
          </p>
        </div>
      </div>
    </BaseLayout>
  )
}
