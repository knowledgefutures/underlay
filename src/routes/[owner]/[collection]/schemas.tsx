import { type FormEvent, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'

import BaseLayout from '~/components/BaseLayout'
import { NotFoundError } from '~/components/NotFound'
import { useAppContext } from '~/lib/app-context'

import { CollectionNav } from '.'

export default function CollectionSchemasPage() {
  const { owner, collection } = useParams()
  const { currentUser } = useAppContext()

  const [data, setData] = useState<any>(null)
  const [isOwner, setIsOwner] = useState(false)
  const [schemas, setSchemas] = useState<any[]>([])
  const [schemasData, setSchemasData] = useState<any>({})
  const [arkRecordTypes, setArkRecordTypes] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [arkSuccess, setArkSuccess] = useState('')
  const [arkError, setArkError] = useState('')

  useEffect(() => {
    if (!owner || !collection) return

    const ownerFlag =
      currentUser &&
      (currentUser.slug === owner || currentUser.orgs?.some((o: any) => o.slug === owner))
    setIsOwner(!!ownerFlag)

    Promise.all([
      fetch(`/api/collections/${owner}/${collection}`, { credentials: 'include' }).then((r) =>
        r.ok ? r.json() : null,
      ),
      fetch(`/api/collections/${owner}/${collection}/schemas`, { credentials: 'include' }).then(
        (r) => (r.ok ? r.json() : { schemas: [], version: null, semver: null }),
      ),
      ownerFlag
        ? fetch(`/api/collections/${owner}/${collection}/ark/record-types`, {
            credentials: 'include',
          }).then((r) => (r.ok ? r.json() : []))
        : Promise.resolve([]),
    ]).then(([col, sd, arkTypes]) => {
      if (!col) {
        setLoading(false)
        return
      }
      setData(col)
      setSchemasData(sd)
      setSchemas(sd.schemas ?? [])

      const types: Record<string, string> = {}
      for (const entry of arkTypes) {
        types[entry.recordType] = entry.redirectUrlField
      }
      setArkRecordTypes(types)

      setLoading(false)
    })
  }, [owner, collection, currentUser])

  async function handleUpdateArkType(e: FormEvent, slug: string) {
    e.preventDefault()
    setArkSuccess('')
    setArkError('')
    const form = e.target as HTMLFormElement
    const formData = new FormData(form)
    const redirectUrlField = (formData.get('redirectUrlField') as string) || null

    const res = await fetch(`/api/collections/${owner}/${collection}/ark/record-types`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ recordType: slug, redirectUrlField }),
    })
    if (res.ok) {
      setArkSuccess(`ARK settings updated for ${slug}.`)
      setArkRecordTypes((prev) => {
        const next = { ...prev }
        if (redirectUrlField) {
          next[slug] = redirectUrlField
        } else {
          delete next[slug]
        }
        return next
      })
    } else {
      const body = await res.json().catch(() => ({}))
      setArkError(body.error ?? 'Failed to update ARK settings.')
    }
  }

  if (loading) {
    return (
      <BaseLayout>
        <div className="text-ink-muted mx-auto max-w-5xl px-4 py-8 text-sm">Loading…</div>
      </BaseLayout>
    )
  }
  if (!data) throw new NotFoundError()

  return (
    <BaseLayout>
      <div className="mx-auto max-w-5xl px-4 py-8">
        <CollectionNav
          owner={owner!}
          collection={collection!}
          isPublic={data.public}
          isOwner={isOwner}
          active="schemas"
        />

        {arkSuccess && (
          <p className="mb-4 border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
            {arkSuccess}
          </p>
        )}
        {arkError && (
          <p className="mb-4 border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {arkError}
          </p>
        )}

        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-ink-muted text-sm font-semibold">
            {schemas.length} type{schemas.length !== 1 ? 's' : ''}
            {schemasData.semver && (
              <span className="ml-1 font-normal">in {schemasData.semver}</span>
            )}
          </h2>
        </div>

        {schemas.length === 0 ? (
          <p className="text-ink-muted py-8 text-center text-sm">No schemas in this version.</p>
        ) : (
          <div className="space-y-4">
            {schemas.map((s: any) => {
              const properties = (s.schema as any)?.properties ?? {}
              const fields = Object.entries(properties)
              const isPrivate = (s.schema as any)?.private === true
              const labels: string[] = (s.schema as any)?.['x-underlay-labels'] ?? []

              const urlFields = fields
                .filter(
                  ([, def]: [string, any]) =>
                    def.type === 'string' && (def.format === 'uri' || def.format === 'url'),
                )
                .map(([name]: [string, any]) => name)
              const currentField = arkRecordTypes[s.slug] ?? ''

              return (
                <div key={s.slug} className="border-rule overflow-hidden rounded border">
                  {/* Header */}
                  <div className="bg-parchment-dark border-rule flex items-center justify-between border-b px-4 py-3">
                    <div className="flex items-center gap-3">
                      <svg
                        className="text-ink-muted h-4 w-4 shrink-0"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
                        />
                      </svg>
                      <span className="text-sm font-medium">{s.slug}</span>
                      {isPrivate && (
                        <span className="border-rule text-ink-muted border px-1.5 py-0.5 text-[11px]">
                          private
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3">
                      {labels.length > 0 && (
                        <div className="flex items-center gap-1">
                          {labels.map((label: string) => (
                            <span
                              key={label}
                              className="bg-parchment border-rule text-ink-muted rounded border px-1.5 py-0.5 text-[11px]"
                            >
                              {label}
                            </span>
                          ))}
                        </div>
                      )}
                      <Link
                        to={`/schemas/${s.schemaId}`}
                        className="text-link text-[11px] hover:underline"
                        title="View global schema detail"
                      >
                        {s.schemaHash.slice(0, 10)}…
                      </Link>
                    </div>
                  </div>

                  {/* Fields table */}
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-rule border-b">
                        <th className="w-48 p-2.5 text-left font-medium">Field</th>
                        <th className="w-32 p-2.5 text-left font-medium">Type</th>
                        <th className="p-2.5 text-left font-medium">Annotations</th>
                      </tr>
                    </thead>
                    <tbody>
                      {fields.map(([name, def]: [string, any]) => {
                        const fieldType = def.type ?? 'unknown'
                        const format = def.format ? ` (${def.format})` : ''
                        const refType = def['x-ref-type']
                        const isFieldPrivate = def.private === true

                        return (
                          <tr
                            key={name}
                            className="border-rule hover:bg-parchment-dark/50 border-t"
                          >
                            <td className="p-2.5 font-mono">{name}</td>
                            <td className="text-ink-muted p-2.5">
                              {fieldType}
                              {format}
                            </td>
                            <td className="p-2.5">
                              <div className="flex items-center gap-2">
                                {refType && (
                                  <span className="bg-parchment-dark border-rule inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px]">
                                    <svg
                                      className="text-ink-muted h-3 w-3"
                                      fill="none"
                                      stroke="currentColor"
                                      viewBox="0 0 24 24"
                                    >
                                      <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={2}
                                        d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101"
                                      />
                                      <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={2}
                                        d="M10.172 13.828a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
                                      />
                                    </svg>
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

                  {/* ARK section for this type (owner only) */}
                  {isOwner && urlFields.length > 0 && (
                    <div className="border-rule bg-parchment-dark/30 border-t px-4 py-3">
                      <p className="text-ink-muted mb-2 text-xs font-medium tracking-wide uppercase">
                        ARK identifiers for this type
                      </p>
                      <form
                        onSubmit={(e) => handleUpdateArkType(e, s.slug)}
                        className="flex items-center gap-3"
                      >
                        <label
                          htmlFor={`ark-field-${s.slug}`}
                          className="text-ink-muted shrink-0 text-xs"
                        >
                          Redirect URL field:
                        </label>
                        <select
                          id={`ark-field-${s.slug}`}
                          name="redirectUrlField"
                          defaultValue={currentField}
                          className="bg-parchment border-rule focus:border-ink border px-2 py-1 text-xs focus:outline-none"
                        >
                          <option value="">Disabled</option>
                          {urlFields.map((f: string) => (
                            <option key={f} value={f}>
                              {f}
                            </option>
                          ))}
                        </select>
                        <button
                          type="submit"
                          className="bg-ink text-parchment px-3 py-1 text-xs font-medium transition-opacity hover:opacity-90"
                        >
                          Save
                        </button>
                      </form>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </BaseLayout>
  )
}
