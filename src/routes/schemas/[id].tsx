import { Link, useLoaderData } from 'react-router'

import BaseLayout from '~/components/BaseLayout'
import SchemaLabelManager from '~/components/SchemaLabelManager'
import { Badge } from '~/components/ui'

interface SchemaData {
  id: number
  schemaHash: string
  schema: Record<string, any>
  createdAt: string
  labels?: { label: string; createdAt: string }[]
  usage?: { slug: string; semver: string; collection: string }[]
}

export default function SchemaDetailPage() {
  const schema = useLoaderData() as SchemaData

  const properties = (schema.schema as any)?.properties ?? {}
  const fields = Object.entries(properties)
  const isPrivate = (schema.schema as any)?.private === true
  const labels: { label: string; createdAt: string }[] = schema.labels ?? []
  const usage: { slug: string; semver: string; collection: string }[] = schema.usage ?? []

  // Usage arrives as one row per (collection, version); group per collection + type slug.
  const usageByCollection = (() => {
    const map = new Map<string, { collection: string; slug: string; semvers: string[] }>()
    for (const u of usage) {
      const key = `${u.collection}:${u.slug}`
      let entry = map.get(key)
      if (!entry) {
        entry = { collection: u.collection, slug: u.slug, semvers: [] }
        map.set(key, entry)
      }
      entry.semvers.push(u.semver)
    }
    return [...map.values()]
  })()

  return (
    <BaseLayout>
      <div className="mx-auto max-w-5xl px-4 py-10">
        {/* Header */}
        <div className="mb-6">
          <div className="mb-2 flex items-center gap-3">
            <h1 className="font-mono text-lg font-semibold">{schema.schemaHash.slice(0, 16)}…</h1>
            {isPrivate && <Badge>private type</Badge>}
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
              {usageByCollection.length} collection{usageByCollection.length !== 1 ? 's' : ''} using
              this schema
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
            <div className="border-rule rounded-surface overflow-x-auto border">
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
                              <span className="bg-parchment-dark border-rule rounded-control inline-flex items-center gap-1 border px-1.5 py-0.5 text-[11px]">
                                → {refType}
                              </span>
                            )}
                            {isFieldPrivate && <Badge>private</Badge>}
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
            <div className="border-rule rounded-surface overflow-hidden border">
              <pre className="bg-ink text-parchment max-h-96 overflow-x-auto p-4 font-mono text-xs">
                <code>{JSON.stringify(schema.schema, null, 2)}</code>
              </pre>
            </div>
          </div>
        </div>

        {/* Usage: which collections reference this schema */}
        <div>
          <h2 className="text-ink-muted mb-2 text-xs font-semibold tracking-wide uppercase">
            Used by {usageByCollection.length} collection
            {usageByCollection.length !== 1 ? 's' : ''}
            {usage.length > usageByCollection.length && (
              <span className="font-normal normal-case"> · {usage.length} versions</span>
            )}
          </h2>
          {usageByCollection.length === 0 ? (
            <p className="text-ink-muted py-4 text-sm">
              No public collections reference this schema yet.
            </p>
          ) : (
            <div className="border-rule rounded-surface overflow-hidden border">
              {usageByCollection.map((u, i) => (
                <div
                  key={`${u.collection}-${u.slug}`}
                  className={`px-4 py-3 ${i < usageByCollection.length - 1 ? 'border-rule border-b' : ''}`}
                >
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <Link
                      to={`/${u.collection}`}
                      className="min-w-0 truncate text-sm font-medium hover:underline"
                    >
                      {u.collection}
                    </Link>
                    <span className="text-ink-muted shrink-0 text-xs">
                      as <code className="font-mono">{u.slug}</code> · {u.semvers.length} version
                      {u.semvers.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {u.semvers.map((semver) => (
                      <Link
                        key={semver}
                        to={`/${u.collection}/v/${semver.replace(/^v/, '')}/records?type=${u.slug}`}
                        className="border-rule text-link rounded-control hover:bg-parchment-dark border px-1.5 py-0.5 font-mono text-[11px] transition-colors"
                      >
                        {semver}
                      </Link>
                    ))}
                  </div>
                </div>
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
