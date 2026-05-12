import { useEffect, useState, } from 'react'
import { useParams, useSearchParams, } from 'react-router'
import BaseLayout from '~/components/BaseLayout'
import { NotFoundError, } from '~/components/NotFound'
import { useSSRData, } from '~/lib/ssr-data'
import { CollectionNav, } from '.'

function groupByType(records: any[],) {
  const groups: Record<string, any[]> = {}
  for (const r of records) {
    if (!groups[r.type]) groups[r.type] = []
    groups[r.type]!.push(r,)
  }
  return groups
}

export default function CollectionDiffPage() {
  const { owner, collection, } = useParams()
  const [searchParams, setSearchParams,] = useSearchParams()
  const currentUser = useSSRData<any>('currentUser',)

  const [data, setData,] = useState<any>(null,)
  const [versions, setVersions,] = useState<any[]>([],)
  const [isOwner, setIsOwner,] = useState(false,)
  const [diff, setDiff,] = useState<any>(null,)
  const [diffError, setDiffError,] = useState<string | null>(null,)
  const [loading, setLoading,] = useState(true,)
  const [diffLoading, setDiffLoading,] = useState(false,)

  // Version selectors
  const [fromNum, setFromNum,] = useState<number>(0,)
  const [toNum, setToNum,] = useState<number>(0,)

  useEffect(() => {
    if (!owner || !collection) return

    Promise.all([
      fetch(`/api/collections/${owner}/${collection}`, { credentials: 'include', },).then((r,) =>
        r.ok ? r.json() : null
      ),
      fetch(`/api/collections/${owner}/${collection}/versions?limit=100`, {
        credentials: 'include',
      },).then((r,) => (r.ok ? r.json() : [])),
    ],).then(([col, vers,],) => {
      if (!col) {
        setLoading(false,)
        return
      }
      setData(col,)
      setVersions(vers,)

      if (currentUser) {
        setIsOwner(
          currentUser.slug === owner
            || currentUser.orgs?.some((o: any,) => o.slug === owner),
        )
      }

      // Determine from/to from URL
      const latestNum = vers.length > 0 ? vers[0].number : null
      const urlTo = searchParams.get('to',)
      const urlFrom = searchParams.get('from',)
      const target = urlTo ? parseInt(urlTo, 10,) : latestNum ?? 0
      const base = urlFrom ? parseInt(urlFrom, 10,) : target ? target - 1 : 0
      setToNum(target,)
      setFromNum(base,)

      setLoading(false,)
    },)
  }, [owner, collection, currentUser,],)

  // Fetch diff when from/to change
  useEffect(() => {
    if (!toNum || toNum <= 0 || loading) return
    setDiffLoading(true,)
    setDiff(null,)
    setDiffError(null,)

    const fromParam = fromNum >= 0 ? `?from=${fromNum}` : ''
    fetch(
      `/api/collections/${owner}/${collection}/versions/${toNum}/diff${fromParam}`,
      { credentials: 'include', },
    )
      .then(async (r,) => {
        if (r.ok) {
          setDiff(await r.json(),)
        } else {
          const body = await r.json().catch(() => ({}))
          setDiffError(body.error ?? 'Failed to load diff',)
        }
      },)
      .finally(() => setDiffLoading(false,))
  }, [fromNum, toNum, loading, owner, collection,],)

  function handleCompare(e: React.FormEvent,) {
    e.preventDefault()
    const form = e.target as HTMLFormElement
    const fd = new FormData(form,)
    const f = parseInt(fd.get('from',) as string, 10,)
    const t = parseInt(fd.get('to',) as string, 10,)
    setFromNum(f,)
    setToNum(t,)
    setSearchParams({ from: String(f,), to: String(t,), },)
  }

  if (loading) {
    return (
      <BaseLayout>
        <div className='max-w-5xl mx-auto px-4 py-8 text-sm text-ink-muted'>Loading…</div>
      </BaseLayout>
    )
  }
  if (!data) throw new NotFoundError()

  const targetVersion = versions.find((v: any,) => v.number === toNum)
  const baseVersion = versions.find((v: any,) => v.number === fromNum)

  const addedByType = diff ? groupByType(diff.added,) : {}
  const updatedByType = diff ? groupByType(diff.updated,) : {}
  const removedCount = diff?.removed?.length ?? 0

  const totalAdded = diff?.added?.length ?? 0
  const totalUpdated = diff?.updated?.length ?? 0
  const totalRemoved = removedCount
  const totalChanges = totalAdded + totalUpdated + totalRemoved

  const meta = diff?.meta ?? {}
  const hasMetaChanges = meta.schemaChanged
    || meta.readmeChanged
    || meta.filesAdded > 0
    || meta.filesRemoved > 0

  return (
    <BaseLayout>
      <div className='max-w-5xl mx-auto px-4 py-8'>
        <CollectionNav
          owner={owner!}
          collection={collection!}
          isPublic={data.public}
          isOwner={isOwner}
          active='versions'
        />

        {/* Version selector */}
        <div className='flex items-center gap-3 mb-6'>
          <form onSubmit={handleCompare} className='flex items-center gap-2 text-sm'>
            <label className='text-ink-muted'>Comparing</label>
            <select
              name='from'
              defaultValue={fromNum}
              className='border border-rule rounded px-2 py-1 text-sm bg-parchment'
            >
              <option value='0'>∅ (empty)</option>
              {versions.map((v: any,) => (
                <option key={v.number} value={v.number}>
                  v{v.number} ({v.semver})
                </option>
              ))}
            </select>
            <span className='text-ink-muted'>→</span>
            <select
              name='to'
              defaultValue={toNum}
              className='border border-rule rounded px-2 py-1 text-sm bg-parchment'
            >
              {versions.map((v: any,) => (
                <option key={v.number} value={v.number}>
                  v{v.number} ({v.semver})
                </option>
              ))}
            </select>
            <button
              type='submit'
              className='bg-ink text-parchment px-3 py-1 rounded text-sm font-medium hover:opacity-90 transition-opacity'
            >
              Compare
            </button>
          </form>
        </div>

        {diffError && (
          <div className='border border-red-200 bg-red-50 text-red-700 text-sm px-4 py-3 rounded mb-6'>
            {diffError}
          </div>
        )}

        {diffLoading && <p className='text-sm text-ink-muted py-8 text-center'>Loading diff…</p>}

        {diff && (
          <div>
            {/* Summary bar */}
            <div className='flex items-center gap-4 text-sm py-2.5 px-4 border border-rule rounded bg-parchment-dark mb-6'>
              <span className='text-ink-muted'>
                {baseVersion ? `v${baseVersion.number}` : '∅'} → v{targetVersion?.number}
              </span>
              <span className='text-ink-muted'>·</span>
              <span>
                <strong className='text-ink'>{totalChanges.toLocaleString()}</strong> changes
              </span>
              {totalAdded > 0 && (
                <span className='text-green-700'>
                  +{totalAdded.toLocaleString()} added
                </span>
              )}
              {totalUpdated > 0 && (
                <span className='text-amber-700'>
                  ~{totalUpdated.toLocaleString()} updated
                </span>
              )}
              {totalRemoved > 0 && (
                <span className='text-red-700'>
                  -{totalRemoved.toLocaleString()} removed
                </span>
              )}
              {meta.schemaChanged && <span className='text-purple-700'>schema</span>}
              {meta.readmeChanged && <span className='text-blue-700'>readme</span>}
              {meta.filesAdded > 0 && <span className='text-green-700'>+{meta.filesAdded} files</span>}
              {meta.filesRemoved > 0 && <span className='text-red-700'>-{meta.filesRemoved} files</span>}
            </div>

            {/* Metadata changes */}
            {hasMetaChanges && (
              <div className='mb-8'>
                <h3 className='flex items-center gap-2 text-sm font-semibold mb-3'>
                  <span className='w-2 h-2 rounded-full bg-blue-600'></span>
                  Metadata changes
                </h3>
                <div className='border border-rule rounded overflow-hidden'>
                  <table className='w-full text-sm'>
                    <tbody>
                      {meta.schemaChanged && (
                        <tr className='border-b border-rule'>
                          <td className='p-3 font-medium text-ink-muted w-32'>Schema</td>
                          <td className='p-3 text-purple-700'>Modified</td>
                        </tr>
                      )}
                      {meta.readmeChanged && (
                        <tr className='border-b border-rule'>
                          <td className='p-3 font-medium text-ink-muted w-32'>README</td>
                          <td className='p-3'>
                            {!meta.readmeFrom && meta.readmeTo
                              ? <span className='text-green-700'>Added</span>
                              : meta.readmeFrom && !meta.readmeTo
                              ? <span className='text-red-700'>Removed</span>
                              : <span className='text-blue-700'>Modified</span>}
                          </td>
                        </tr>
                      )}
                      {meta.filesAdded > 0 && (
                        <tr className='border-b border-rule'>
                          <td className='p-3 font-medium text-ink-muted w-32'>Files added</td>
                          <td className='p-3 text-green-700'>+{meta.filesAdded}</td>
                        </tr>
                      )}
                      {meta.filesRemoved > 0 && (
                        <tr className='border-b border-rule last:border-b-0'>
                          <td className='p-3 font-medium text-ink-muted w-32'>
                            Files removed
                          </td>
                          <td className='p-3 text-red-700'>-{meta.filesRemoved}</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {totalChanges === 0 && !hasMetaChanges && (
              <p className='text-sm text-ink-muted py-8 text-center'>
                No changes between these versions.
              </p>
            )}

            {/* Added records */}
            {totalAdded > 0 && (
              <div className='mb-8'>
                <h3 className='flex items-center gap-2 text-sm font-semibold mb-3'>
                  <span className='w-2 h-2 rounded-full bg-green-600'></span>
                  Added ({totalAdded.toLocaleString()})
                </h3>
                {Object.entries(addedByType,).map(([type, records,]: [string, any[],],) => (
                  <div key={type} className='mb-4'>
                    <div className='text-xs font-medium text-ink-muted mb-1.5'>
                      {type} ({records.length})
                    </div>
                    <div className='border border-rule rounded overflow-hidden'>
                      <table className='w-full text-xs'>
                        <thead>
                          <tr className='bg-green-50 border-b border-rule'>
                            <th className='text-left p-2 font-medium w-48'>ID</th>
                            <th className='text-left p-2 font-medium'>Data</th>
                          </tr>
                        </thead>
                        <tbody>
                          {records.slice(0, 50,).map((r: any,) => (
                            <tr
                              key={r.id}
                              className='border-t border-rule hover:bg-green-50/50'
                            >
                              <td className='p-2 font-mono text-[11px] text-ink-muted align-top'>
                                {r.id.length > 30 ? r.id.slice(0, 30,) + '…' : r.id}
                              </td>
                              <td className='p-2'>
                                <pre className='text-[11px] font-mono whitespace-pre-wrap break-all max-h-24 overflow-y-auto'>
                                  {JSON.stringify(r.data, null, 2)}
                                </pre>
                              </td>
                            </tr>
                          ))}
                          {records.length > 50 && (
                            <tr className='border-t border-rule'>
                              <td colSpan={2} className='p-2 text-center text-ink-muted'>
                                … and {records.length - 50} more
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Updated records */}
            {totalUpdated > 0 && (
              <div className='mb-8'>
                <h3 className='flex items-center gap-2 text-sm font-semibold mb-3'>
                  <span className='w-2 h-2 rounded-full bg-amber-500'></span>
                  Updated ({totalUpdated.toLocaleString()})
                </h3>
                {Object.entries(updatedByType,).map(([type, records,]: [string, any[],],) => (
                  <div key={type} className='mb-4'>
                    <div className='text-xs font-medium text-ink-muted mb-1.5'>
                      {type} ({records.length})
                    </div>
                    <div className='border border-rule rounded overflow-hidden'>
                      <table className='w-full text-xs'>
                        <thead>
                          <tr className='bg-amber-50 border-b border-rule'>
                            <th className='text-left p-2 font-medium w-48'>ID</th>
                            <th className='text-left p-2 font-medium'>New data</th>
                          </tr>
                        </thead>
                        <tbody>
                          {records.slice(0, 50,).map((r: any,) => (
                            <tr
                              key={r.id}
                              className='border-t border-rule hover:bg-amber-50/50'
                            >
                              <td className='p-2 font-mono text-[11px] text-ink-muted align-top'>
                                {r.id.length > 30 ? r.id.slice(0, 30,) + '…' : r.id}
                              </td>
                              <td className='p-2'>
                                <pre className='text-[11px] font-mono whitespace-pre-wrap break-all max-h-24 overflow-y-auto'>
                                  {JSON.stringify(r.data, null, 2)}
                                </pre>
                              </td>
                            </tr>
                          ))}
                          {records.length > 50 && (
                            <tr className='border-t border-rule'>
                              <td colSpan={2} className='p-2 text-center text-ink-muted'>
                                … and {records.length - 50} more
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Removed records */}
            {totalRemoved > 0 && (
              <div className='mb-8'>
                <h3 className='flex items-center gap-2 text-sm font-semibold mb-3'>
                  <span className='w-2 h-2 rounded-full bg-red-600'></span>
                  Removed ({totalRemoved.toLocaleString()})
                </h3>
                <div className='border border-rule rounded overflow-hidden'>
                  <table className='w-full text-xs'>
                    <thead>
                      <tr className='bg-red-50 border-b border-rule'>
                        <th className='text-left p-2 font-medium'>Record ID</th>
                      </tr>
                    </thead>
                    <tbody>
                      {diff.removed.slice(0, 100,).map((id: string,) => (
                        <tr
                          key={id}
                          className='border-t border-rule hover:bg-red-50/50'
                        >
                          <td className='p-2 font-mono text-[11px] text-ink-muted'>{id}</td>
                        </tr>
                      ))}
                      {diff.removed.length > 100 && (
                        <tr className='border-t border-rule'>
                          <td className='p-2 text-center text-ink-muted'>
                            … and {diff.removed.length - 100} more
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {!diff && !diffError && !diffLoading && (
          <p className='text-sm text-ink-muted py-8 text-center'>
            Select versions to compare.
          </p>
        )}
      </div>
    </BaseLayout>
  )
}
