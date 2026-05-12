import { type FormEvent, useEffect, useState, } from 'react'
import { Link, useParams, } from 'react-router'
import BaseLayout from '~/components/BaseLayout'
import { NotFoundError, } from '~/components/NotFound'
import { useSSRData, } from '~/lib/ssr-data'
import { CollectionNav, } from '.'

export default function CollectionSchemasPage() {
  const { owner, collection, } = useParams()
  const currentUser = useSSRData<any>('currentUser',)

  const [data, setData,] = useState<any>(null,)
  const [isOwner, setIsOwner,] = useState(false,)
  const [schemas, setSchemas,] = useState<any[]>([],)
  const [schemasData, setSchemasData,] = useState<any>({},)
  const [arkRecordTypes, setArkRecordTypes,] = useState<Record<string, string>>({},)
  const [loading, setLoading,] = useState(true,)
  const [arkSuccess, setArkSuccess,] = useState('',)
  const [arkError, setArkError,] = useState('',)

  useEffect(() => {
    if (!owner || !collection) return

    const ownerFlag = currentUser
      && (currentUser.slug === owner
        || currentUser.orgs?.some((o: any,) => o.slug === owner))
    setIsOwner(!!ownerFlag,)

    Promise.all([
      fetch(`/api/collections/${owner}/${collection}`, { credentials: 'include', },).then((r,) =>
        r.ok ? r.json() : null
      ),
      fetch(`/api/collections/${owner}/${collection}/schemas`, { credentials: 'include', },).then(
        (r,) => (r.ok ? r.json() : { schemas: [], version: null, semver: null, }),
      ),
      ownerFlag
        ? fetch(`/api/collections/${owner}/${collection}/ark/record-types`, {
          credentials: 'include',
        },).then((r,) => (r.ok ? r.json() : []))
        : Promise.resolve([],),
    ],).then(([col, sd, arkTypes,],) => {
      if (!col) {
        setLoading(false,)
        return
      }
      setData(col,)
      setSchemasData(sd,)
      setSchemas(sd.schemas ?? [],)

      const types: Record<string, string> = {}
      for (const entry of arkTypes) {
        types[entry.recordType] = entry.redirectUrlField
      }
      setArkRecordTypes(types,)

      setLoading(false,)
    },)
  }, [owner, collection, currentUser,],)

  async function handleUpdateArkType(e: FormEvent, slug: string,) {
    e.preventDefault()
    setArkSuccess('',)
    setArkError('',)
    const form = e.target as HTMLFormElement
    const formData = new FormData(form,)
    const redirectUrlField = (formData.get('redirectUrlField',) as string) || null

    const res = await fetch(`/api/collections/${owner}/${collection}/ark/record-types`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', },
      credentials: 'include',
      body: JSON.stringify({ recordType: slug, redirectUrlField, },),
    },)
    if (res.ok) {
      setArkSuccess(`ARK settings updated for ${slug}.`,)
      setArkRecordTypes((prev,) => {
        const next = { ...prev, }
        if (redirectUrlField) {
          next[slug] = redirectUrlField
        } else {
          delete next[slug]
        }
        return next
      },)
    } else {
      const body = await res.json().catch(() => ({}))
      setArkError(body.error ?? 'Failed to update ARK settings.',)
    }
  }

  if (loading) {
    return (
      <BaseLayout>
        <div className='max-w-5xl mx-auto px-4 py-8 text-sm text-ink-muted'>Loading…</div>
      </BaseLayout>
    )
  }
  if (!data) throw new NotFoundError()

  return (
    <BaseLayout>
      <div className='max-w-5xl mx-auto px-4 py-8'>
        <CollectionNav
          owner={owner!}
          collection={collection!}
          isPublic={data.public}
          isOwner={isOwner}
          active='schemas'
        />

        {arkSuccess && (
          <p className='text-sm text-green-800 bg-green-50 border border-green-200 px-3 py-2 mb-4'>
            {arkSuccess}
          </p>
        )}
        {arkError && (
          <p className='text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 mb-4'>
            {arkError}
          </p>
        )}

        <div className='flex items-center justify-between mb-4'>
          <h2 className='text-sm font-semibold text-ink-muted'>
            {schemas.length} type{schemas.length !== 1 ? 's' : ''}
            {schemasData.semver && <span className='font-normal ml-1'>in {schemasData.semver}</span>}
          </h2>
        </div>

        {schemas.length === 0
          ? (
            <p className='text-sm text-ink-muted py-8 text-center'>
              No schemas in this version.
            </p>
          )
          : (
            <div className='space-y-4'>
              {schemas.map((s: any,) => {
                const properties = (s.schema as any)?.properties ?? {}
                const fields = Object.entries(properties,)
                const isPrivate = (s.schema as any)?.private === true
                const labels: string[] = (s.schema as any)?.['x-underlay-labels'] ?? []

                const urlFields = fields
                  .filter(
                    ([, def,]: [string, any,],) =>
                      def.type === 'string'
                      && (def.format === 'uri' || def.format === 'url'),
                  )
                  .map(([name,]: [string, any,],) => name)
                const currentField = arkRecordTypes[s.slug] ?? ''

                return (
                  <div key={s.slug} className='border border-rule rounded overflow-hidden'>
                    {/* Header */}
                    <div className='flex items-center justify-between px-4 py-3 bg-parchment-dark border-b border-rule'>
                      <div className='flex items-center gap-3'>
                        <svg
                          className='w-4 h-4 text-ink-muted shrink-0'
                          fill='none'
                          stroke='currentColor'
                          viewBox='0 0 24 24'
                        >
                          <path
                            strokeLinecap='round'
                            strokeLinejoin='round'
                            strokeWidth={2}
                            d='M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10'
                          />
                        </svg>
                        <span className='font-medium text-sm'>{s.slug}</span>
                        {isPrivate && (
                          <span className='text-[11px] border border-rule px-1.5 py-0.5 text-ink-muted'>
                            private
                          </span>
                        )}
                      </div>
                      <div className='flex items-center gap-3'>
                        {labels.length > 0 && (
                          <div className='flex items-center gap-1'>
                            {labels.map((label: string,) => (
                              <span
                                key={label}
                                className='text-[11px] bg-parchment border border-rule px-1.5 py-0.5 rounded text-ink-muted'
                              >
                                {label}
                              </span>
                            ))}
                          </div>
                        )}
                        <Link
                          to={`/schemas/${s.schemaId}`}
                          className='text-[11px] text-link hover:underline'
                          title='View global schema detail'
                        >
                          {s.schemaHash.slice(0, 10,)}…
                        </Link>
                      </div>
                    </div>

                    {/* Fields table */}
                    <table className='w-full text-xs'>
                      <thead>
                        <tr className='border-b border-rule'>
                          <th className='text-left p-2.5 font-medium w-48'>Field</th>
                          <th className='text-left p-2.5 font-medium w-32'>Type</th>
                          <th className='text-left p-2.5 font-medium'>Annotations</th>
                        </tr>
                      </thead>
                      <tbody>
                        {fields.map(([name, def,]: [string, any,],) => {
                          const fieldType = def.type ?? 'unknown'
                          const format = def.format ? ` (${def.format})` : ''
                          const refType = def['x-ref-type']
                          const isFieldPrivate = def.private === true

                          return (
                            <tr
                              key={name}
                              className='border-t border-rule hover:bg-parchment-dark/50'
                            >
                              <td className='p-2.5 font-mono'>{name}</td>
                              <td className='p-2.5 text-ink-muted'>
                                {fieldType}
                                {format}
                              </td>
                              <td className='p-2.5'>
                                <div className='flex items-center gap-2'>
                                  {refType && (
                                    <span className='inline-flex items-center gap-1 text-[11px] bg-parchment-dark border border-rule px-1.5 py-0.5 rounded'>
                                      <svg
                                        className='w-3 h-3 text-ink-muted'
                                        fill='none'
                                        stroke='currentColor'
                                        viewBox='0 0 24 24'
                                      >
                                        <path
                                          strokeLinecap='round'
                                          strokeLinejoin='round'
                                          strokeWidth={2}
                                          d='M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101'
                                        />
                                        <path
                                          strokeLinecap='round'
                                          strokeLinejoin='round'
                                          strokeWidth={2}
                                          d='M10.172 13.828a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1'
                                        />
                                      </svg>
                                      → {refType}
                                    </span>
                                  )}
                                  {isFieldPrivate && (
                                    <span className='text-[11px] border border-rule px-1.5 py-0.5 rounded text-ink-muted'>
                                      private
                                    </span>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )
                        },)}
                      </tbody>
                    </table>

                    {/* ARK section for this type (owner only) */}
                    {isOwner && urlFields.length > 0 && (
                      <div className='border-t border-rule px-4 py-3 bg-parchment-dark/30'>
                        <p className='text-xs font-medium text-ink-muted uppercase tracking-wide mb-2'>
                          ARK identifiers for this type
                        </p>
                        <form
                          onSubmit={(e,) => handleUpdateArkType(e, s.slug,)}
                          className='flex items-center gap-3'
                        >
                          <label
                            htmlFor={`ark-field-${s.slug}`}
                            className='text-xs text-ink-muted shrink-0'
                          >
                            Redirect URL field:
                          </label>
                          <select
                            id={`ark-field-${s.slug}`}
                            name='redirectUrlField'
                            defaultValue={currentField}
                            className='bg-parchment border border-rule px-2 py-1 text-xs focus:outline-none focus:border-ink'
                          >
                            <option value=''>Disabled</option>
                            {urlFields.map((f: string,) => (
                              <option key={f} value={f}>
                                {f}
                              </option>
                            ))}
                          </select>
                          <button
                            type='submit'
                            className='bg-ink text-parchment px-3 py-1 text-xs font-medium hover:opacity-90 transition-opacity'
                          >
                            Save
                          </button>
                        </form>
                      </div>
                    )}
                  </div>
                )
              },)}
            </div>
          )}
      </div>
    </BaseLayout>
  )
}
