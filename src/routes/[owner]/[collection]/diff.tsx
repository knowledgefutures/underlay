import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router'

import BaseLayout from '~/components/BaseLayout'
import { NotFoundError } from '~/components/NotFound'
import { useAppContext } from '~/lib/app-context'

import { CollectionNav } from '.'

function groupByType(records: any[]) {
  const groups: Record<string, any[]> = {}
  for (const r of records) {
    if (!groups[r.type]) groups[r.type] = []
    groups[r.type]!.push(r)
  }
  return groups
}

export default function CollectionDiffPage() {
  const { owner, collection } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const { currentUser } = useAppContext()

  const [data, setData] = useState<any>(null)
  const [versions, setVersions] = useState<any[]>([])
  const [isOwner, setIsOwner] = useState(false)
  const [diff, setDiff] = useState<any>(null)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [diffLoading, setDiffLoading] = useState(false)

  // Version selectors (semver strings, empty string = none/empty)
  const [fromVer, setFromVer] = useState<string>('')
  const [toVer, setToVer] = useState<string>('')

  useEffect(() => {
    if (!owner || !collection) return

    Promise.all([
      fetch(`/api/collections/${owner}/${collection}`, { credentials: 'include' }).then((r) =>
        r.ok ? r.json() : null,
      ),
      fetch(`/api/collections/${owner}/${collection}/versions?limit=100`, {
        credentials: 'include',
      }).then((r) => (r.ok ? r.json() : [])),
    ]).then(([col, vers]) => {
      if (!col) {
        setLoading(false)
        return
      }
      setData(col)
      setVersions(vers)

      if (currentUser) {
        setIsOwner(
          currentUser.slug === owner || currentUser.orgs?.some((o: any) => o.slug === owner),
        )
      }

      // Determine from/to from URL
      const latestSemver = vers.length > 0 ? vers[0].semver : ''
      const urlTo = searchParams.get('to')
      const urlFrom = searchParams.get('from')
      const target = urlTo || latestSemver
      const base = urlFrom ?? ''
      setToVer(target)
      setFromVer(base)

      setLoading(false)
    })
  }, [owner, collection, currentUser])

  // Fetch diff when from/to change
  useEffect(() => {
    if (!toVer || loading) return
    setDiffLoading(true)
    setDiff(null)
    setDiffError(null)

    const fromParam = fromVer ? `?from=${fromVer}` : ''
    fetch(`/api/collections/${owner}/${collection}/versions/${toVer}/diff${fromParam}`, {
      credentials: 'include',
    })
      .then(async (r) => {
        if (r.ok) {
          setDiff(await r.json())
        } else {
          const body = await r.json().catch(() => ({}))
          setDiffError(body.error ?? 'Failed to load diff')
        }
      })
      .finally(() => setDiffLoading(false))
  }, [fromVer, toVer, loading, owner, collection])

  function handleCompare(e: React.FormEvent) {
    e.preventDefault()
    const form = e.target as HTMLFormElement
    const fd = new FormData(form)
    const f = fd.get('from') as string
    const t = fd.get('to') as string
    setFromVer(f)
    setToVer(t)
    const params: Record<string, string> = { to: t }
    if (f) params.from = f
    setSearchParams(params)
  }

  if (loading) {
    return (
      <BaseLayout>
        <div className="text-ink-muted mx-auto max-w-5xl px-4 py-8 text-sm">Loading…</div>
      </BaseLayout>
    )
  }
  if (!data) throw new NotFoundError()

  const targetVersion = versions.find((v: any) => v.semver === toVer)
  const baseVersion = versions.find((v: any) => v.semver === fromVer)

  const addedByType = diff ? groupByType(diff.added) : {}
  const updatedByType = diff ? groupByType(diff.updated) : {}
  const removedCount = diff?.removed?.length ?? 0

  const totalAdded = diff?.added?.length ?? 0
  const totalUpdated = diff?.updated?.length ?? 0
  const totalRemoved = removedCount
  const totalChanges = totalAdded + totalUpdated + totalRemoved

  const meta = diff?.meta ?? {}
  const hasMetaChanges =
    meta.schemaChanged || meta.readmeChanged || meta.filesAdded > 0 || meta.filesRemoved > 0

  return (
    <BaseLayout>
      <div className="mx-auto max-w-5xl px-4 py-8">
        <CollectionNav
          owner={owner!}
          collection={collection!}
          isPublic={data.public}
          isOwner={isOwner}
          active="versions"
        />

        {/* Version selector */}
        <div className="mb-6 flex items-center gap-3">
          <form onSubmit={handleCompare} className="flex items-center gap-2 text-sm">
            <label className="text-ink-muted">Comparing</label>
            <select
              name="from"
              defaultValue={fromVer}
              className="border-rule bg-parchment rounded border px-2 py-1 text-sm"
            >
              <option value="">∅ (empty)</option>
              {versions.map((v: any) => (
                <option key={v.semver} value={v.semver}>
                  {v.semver}
                </option>
              ))}
            </select>
            <span className="text-ink-muted">→</span>
            <select
              name="to"
              defaultValue={toVer}
              className="border-rule bg-parchment rounded border px-2 py-1 text-sm"
            >
              {versions.map((v: any) => (
                <option key={v.semver} value={v.semver}>
                  {v.semver}
                </option>
              ))}
            </select>
            <button
              type="submit"
              className="bg-ink text-parchment rounded px-3 py-1 text-sm font-medium transition-opacity hover:opacity-90"
            >
              Compare
            </button>
          </form>
        </div>

        {diffError && (
          <div className="mb-6 rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {diffError}
          </div>
        )}

        {diffLoading && <p className="text-ink-muted py-8 text-center text-sm">Loading diff…</p>}

        {diff && (
          <div>
            {/* Summary bar */}
            <div className="border-rule bg-parchment-dark mb-6 flex items-center gap-4 rounded border px-4 py-2.5 text-sm">
              <span className="text-ink-muted">
                {baseVersion ? baseVersion.semver : '∅'} → {targetVersion?.semver}
              </span>
              <span className="text-ink-muted">·</span>
              <span>
                <strong className="text-ink">{totalChanges.toLocaleString()}</strong> changes
              </span>
              {totalAdded > 0 && (
                <span className="text-green-700">+{totalAdded.toLocaleString()} added</span>
              )}
              {totalUpdated > 0 && (
                <span className="text-amber-700">~{totalUpdated.toLocaleString()} updated</span>
              )}
              {totalRemoved > 0 && (
                <span className="text-red-700">-{totalRemoved.toLocaleString()} removed</span>
              )}
              {meta.schemaChanged && <span className="text-purple-700">schema</span>}
              {meta.readmeChanged && <span className="text-blue-700">readme</span>}
              {meta.filesAdded > 0 && (
                <span className="text-green-700">+{meta.filesAdded} files</span>
              )}
              {meta.filesRemoved > 0 && (
                <span className="text-red-700">-{meta.filesRemoved} files</span>
              )}
            </div>

            {/* Metadata changes */}
            {hasMetaChanges && (
              <div className="mb-8">
                <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
                  <span className="h-2 w-2 rounded-full bg-blue-600"></span>
                  Metadata changes
                </h3>
                <div className="border-rule overflow-hidden rounded border">
                  <table className="w-full text-sm">
                    <tbody>
                      {meta.schemaChanged && (
                        <tr className="border-rule border-b">
                          <td className="text-ink-muted w-32 p-3 font-medium">Schema</td>
                          <td className="p-3 text-purple-700">Modified</td>
                        </tr>
                      )}
                      {meta.readmeChanged && (
                        <tr className="border-rule border-b">
                          <td className="text-ink-muted w-32 p-3 font-medium">README</td>
                          <td className="p-3">
                            {!meta.readmeFrom && meta.readmeTo ? (
                              <span className="text-green-700">Added</span>
                            ) : meta.readmeFrom && !meta.readmeTo ? (
                              <span className="text-red-700">Removed</span>
                            ) : (
                              <span className="text-blue-700">Modified</span>
                            )}
                          </td>
                        </tr>
                      )}
                      {meta.filesAdded > 0 && (
                        <tr className="border-rule border-b">
                          <td className="text-ink-muted w-32 p-3 font-medium">Files added</td>
                          <td className="p-3 text-green-700">+{meta.filesAdded}</td>
                        </tr>
                      )}
                      {meta.filesRemoved > 0 && (
                        <tr className="border-rule border-b last:border-b-0">
                          <td className="text-ink-muted w-32 p-3 font-medium">Files removed</td>
                          <td className="p-3 text-red-700">-{meta.filesRemoved}</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {totalChanges === 0 && !hasMetaChanges && (
              <p className="text-ink-muted py-8 text-center text-sm">
                No changes between these versions.
              </p>
            )}

            {/* Added records */}
            {totalAdded > 0 && (
              <div className="mb-8">
                <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
                  <span className="h-2 w-2 rounded-full bg-green-600"></span>
                  Added ({totalAdded.toLocaleString()})
                </h3>
                {Object.entries(addedByType).map(([type, records]: [string, any[]]) => (
                  <div key={type} className="mb-4">
                    <div className="text-ink-muted mb-1.5 text-xs font-medium">
                      {type} ({records.length})
                    </div>
                    <div className="border-rule overflow-hidden rounded border">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-rule border-b bg-green-50">
                            <th className="w-48 p-2 text-left font-medium">ID</th>
                            <th className="p-2 text-left font-medium">Data</th>
                          </tr>
                        </thead>
                        <tbody>
                          {records.slice(0, 50).map((r: any) => (
                            <tr key={r.id} className="border-rule border-t hover:bg-green-50/50">
                              <td className="text-ink-muted p-2 align-top font-mono text-[11px]">
                                {r.id.length > 30 ? r.id.slice(0, 30) + '…' : r.id}
                              </td>
                              <td className="p-2">
                                <pre className="max-h-24 overflow-y-auto font-mono text-[11px] break-all whitespace-pre-wrap">
                                  {JSON.stringify(r.data, null, 2)}
                                </pre>
                              </td>
                            </tr>
                          ))}
                          {records.length > 50 && (
                            <tr className="border-rule border-t">
                              <td colSpan={2} className="text-ink-muted p-2 text-center">
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
              <div className="mb-8">
                <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
                  <span className="h-2 w-2 rounded-full bg-amber-500"></span>
                  Updated ({totalUpdated.toLocaleString()})
                </h3>
                {Object.entries(updatedByType).map(([type, records]: [string, any[]]) => (
                  <div key={type} className="mb-4">
                    <div className="text-ink-muted mb-1.5 text-xs font-medium">
                      {type} ({records.length})
                    </div>
                    <div className="border-rule overflow-hidden rounded border">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-rule border-b bg-amber-50">
                            <th className="w-48 p-2 text-left font-medium">ID</th>
                            <th className="p-2 text-left font-medium">New data</th>
                          </tr>
                        </thead>
                        <tbody>
                          {records.slice(0, 50).map((r: any) => (
                            <tr key={r.id} className="border-rule border-t hover:bg-amber-50/50">
                              <td className="text-ink-muted p-2 align-top font-mono text-[11px]">
                                {r.id.length > 30 ? r.id.slice(0, 30) + '…' : r.id}
                              </td>
                              <td className="p-2">
                                <pre className="max-h-24 overflow-y-auto font-mono text-[11px] break-all whitespace-pre-wrap">
                                  {JSON.stringify(r.data, null, 2)}
                                </pre>
                              </td>
                            </tr>
                          ))}
                          {records.length > 50 && (
                            <tr className="border-rule border-t">
                              <td colSpan={2} className="text-ink-muted p-2 text-center">
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
              <div className="mb-8">
                <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
                  <span className="h-2 w-2 rounded-full bg-red-600"></span>
                  Removed ({totalRemoved.toLocaleString()})
                </h3>
                <div className="border-rule overflow-hidden rounded border">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-rule border-b bg-red-50">
                        <th className="p-2 text-left font-medium">Record ID</th>
                      </tr>
                    </thead>
                    <tbody>
                      {diff.removed.slice(0, 100).map((id: string) => (
                        <tr key={id} className="border-rule border-t hover:bg-red-50/50">
                          <td className="text-ink-muted p-2 font-mono text-[11px]">{id}</td>
                        </tr>
                      ))}
                      {diff.removed.length > 100 && (
                        <tr className="border-rule border-t">
                          <td className="text-ink-muted p-2 text-center">
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
          <p className="text-ink-muted py-8 text-center text-sm">Select versions to compare.</p>
        )}
      </div>
    </BaseLayout>
  )
}
