import { useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'

import BaseLayout from '~/components/BaseLayout'
import { NotFoundError } from '~/components/NotFound'
import { useSSRData } from '~/lib/ssr-data'

import { CollectionNav, formatBytes } from '..'

export default function CollectionVersionPage() {
  const { owner, collection, n } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const currentUser = useSSRData<any>('currentUser')

  const [version, setVersion] = useState<any>(null)
  const [collectionData, setCollectionData] = useState<any>(null)
  const [isOwner, setIsOwner] = useState(false)
  const [readmeHtml, setReadmeHtml] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // Tab state
  const tab = searchParams.get('tab') ?? 'records'
  const selectedType = searchParams.get('type') ?? null

  // Records state
  const [records, setRecords] = useState<any[]>([])
  const [totalRecords, setTotalRecords] = useState(0)

  // Files state
  const [files, setFiles] = useState<any[]>([])

  useEffect(() => {
    if (!owner || !collection || !n) return

    Promise.all([
      fetch(`/api/collections/${owner}/${collection}/versions/${n}`, {
        credentials: 'include',
      }).then((r) => (r.ok ? r.json() : null)),
      fetch(`/api/collections/${owner}/${collection}`, { credentials: 'include' }).then((r) =>
        r.ok ? r.json() : null,
      ),
    ]).then(([ver, col]) => {
      if (!ver) {
        setLoading(false)
        return
      }
      setVersion(ver)
      setCollectionData(col)

      if (ver.readme) {
        import('marked').then(({ marked }) => {
          setReadmeHtml(marked.parse(ver.readme) as string)
        })
      }

      if (currentUser) {
        setIsOwner(
          currentUser.slug === owner || currentUser.orgs?.some((o: any) => o.slug === owner),
        )
      }

      setLoading(false)
    })
  }, [owner, collection, n, currentUser])

  // Fetch records when tab/type/page changes
  const page = parseInt(searchParams.get('page') ?? '1', 10)
  const pageSize = 100

  useEffect(() => {
    if (!version || tab !== 'records') return

    const schemasMap = (version.schemas ?? {}) as Record<string, any>
    const allTypes = Object.keys(schemasMap).sort()
    const currentType = selectedType || (allTypes.length > 0 ? allTypes[0] : null)

    if (!currentType) return

    const offset = (page - 1) * pageSize
    fetch(
      `/api/collections/${owner}/${collection}/versions/${n}/records?type=${currentType}&limit=${pageSize}&offset=${offset}`,
      { credentials: 'include' },
    )
      .then((r) => (r.ok ? r.json() : { records: [], pagination: {} }))
      .then((body) => {
        setRecords(body.records ?? body)
        setTotalRecords(body.pagination?.total ?? version.recordCount ?? 0)
      })
  }, [version, tab, selectedType, page, owner, collection, n])

  // Fetch files when files tab selected
  useEffect(() => {
    if (!version || tab !== 'files') return

    fetch(`/api/collections/${owner}/${collection}/versions/${n}/files`, {
      credentials: 'include',
    })
      .then((r) => (r.ok ? r.json() : []))
      .then(setFiles)
  }, [version, tab, owner, collection, n])

  if (loading) {
    return (
      <BaseLayout>
        <div className="text-ink-muted mx-auto max-w-5xl px-4 py-8 text-sm">Loading…</div>
      </BaseLayout>
    )
  }
  if (!version) throw new NotFoundError()

  const schemasMap = (version.schemas ?? {}) as Record<string, any>
  const allTypes = Object.keys(schemasMap).sort()
  const currentType = selectedType || (allTypes.length > 0 ? allTypes[0] : null)

  const currentTypeFields: string[] = currentType
    ? schemasMap[currentType]?.properties
      ? Object.keys(schemasMap[currentType].properties)
      : records.length > 0
        ? Object.keys(records[0].data ?? {})
        : []
    : []

  const versionArkPath: string | null = version.ark ? new URL(version.ark).pathname : null

  const offset = (page - 1) * pageSize
  const totalPages = Math.ceil(totalRecords / pageSize) || 1

  const pageNumbers: number[] = []
  if (totalPages > 1) {
    const maxVisible = Math.min(totalPages, 7)
    for (let i = 0; i < maxVisible; i++) {
      let p: number
      if (totalPages <= 7) {
        p = i + 1
      } else if (page <= 4) {
        p = i + 1
      } else if (page >= totalPages - 3) {
        p = totalPages - 6 + i
      } else {
        p = page - 3 + i
      }
      pageNumbers.push(p)
    }
  }

  function setTab(t: string, extra?: Record<string, string>) {
    const params = new URLSearchParams()
    if (t !== 'records') params.set('tab', t)
    if (extra) {
      for (const [k, v] of Object.entries(extra)) params.set(k, v)
    }
    setSearchParams(params)
  }

  return (
    <BaseLayout>
      <div className="mx-auto max-w-5xl px-4 py-8">
        <CollectionNav
          owner={owner!}
          collection={collection!}
          isPublic={collectionData?.public}
          isOwner={isOwner}
          active="versions"
          versionLabel={version.semver}
        />

        {version.message && <p className="text-ink-muted mb-4 text-sm">{version.message}</p>}
        {!version.message && <div className="mb-4" />}

        {/* Info bar */}
        <div className="text-ink-muted border-rule bg-parchment-dark mb-6 flex items-center justify-between rounded border px-4 py-2.5 text-xs">
          <div className="flex items-center gap-4">
            <span>
              <strong className="text-ink">{version.recordCount.toLocaleString()}</strong> records
            </span>
            <span>
              <strong className="text-ink">{version.fileCount.toLocaleString()}</strong> files
            </span>
            <span>
              <strong className="text-ink">{formatBytes(version.totalBytes)}</strong> total
            </span>
            <span>
              <strong className="text-ink">{allTypes.length}</strong> types
            </span>
          </div>
          <div className="flex items-center gap-4">
            {version.appId && (
              <span>
                via <strong className="text-ink">{version.appId}</strong>
              </span>
            )}
            <span>
              {new Date(version.createdAt).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })}
            </span>
            <code className="text-ink-muted font-mono text-[11px]" title={version.hash}>
              sha256:{version.hash.slice(0, 12)}…
            </code>
            {versionArkPath && (
              <Link to={versionArkPath} className="text-link font-mono text-[11px] hover:underline">
                {versionArkPath.slice(1)}
              </Link>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div className="border-rule mb-6 flex items-center gap-0 border-b">
          <button
            onClick={() => setTab('records', currentType ? { type: currentType } : undefined)}
            className={`-mb-px border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
              tab === 'records'
                ? 'border-ink text-ink'
                : 'text-ink-muted hover:text-ink hover:border-rule border-transparent'
            }`}
          >
            Records{' '}
            <span className="text-ink-muted font-normal">
              ({version.recordCount.toLocaleString()})
            </span>
          </button>
          <button
            onClick={() => setTab('schema')}
            className={`-mb-px border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
              tab === 'schema'
                ? 'border-ink text-ink'
                : 'text-ink-muted hover:text-ink hover:border-rule border-transparent'
            }`}
          >
            Schema
          </button>
          <button
            onClick={() => setTab('files')}
            className={`-mb-px border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
              tab === 'files'
                ? 'border-ink text-ink'
                : 'text-ink-muted hover:text-ink hover:border-rule border-transparent'
            }`}
          >
            Files{' '}
            <span className="text-ink-muted font-normal">
              ({version.fileCount.toLocaleString()})
            </span>
          </button>
          <button
            onClick={() => setTab('metadata')}
            className={`-mb-px border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
              tab === 'metadata'
                ? 'border-ink text-ink'
                : 'text-ink-muted hover:text-ink hover:border-rule border-transparent'
            }`}
          >
            Metadata
          </button>
        </div>

        {/* Records tab */}
        {tab === 'records' && (
          <div className="grid grid-cols-[180px_1fr] gap-6">
            {/* Type sidebar */}
            <nav className="space-y-0.5">
              <h3 className="text-ink-muted mb-2 text-xs font-semibold tracking-wide uppercase">
                Types
              </h3>
              {allTypes.map((t) => (
                <Link
                  key={t}
                  to={`/${owner}/${collection}/v/${n}?type=${t}`}
                  className={`block rounded px-3 py-1.5 text-sm transition-colors ${
                    t === currentType
                      ? 'bg-ink text-parchment font-medium'
                      : 'text-ink-muted hover:bg-parchment-dark hover:text-ink'
                  }`}
                >
                  {t}
                </Link>
              ))}
            </nav>

            {/* Table area */}
            <div className="min-w-0">
              {currentType && records.length > 0 ? (
                <div>
                  <div className="border-rule overflow-x-auto rounded border">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="bg-parchment-dark">
                          <th className="border-rule border-b p-2 text-left font-medium">id</th>
                          {currentTypeFields.map((f: string) => (
                            <th key={f} className="border-rule border-b p-2 text-left font-medium">
                              {f}
                            </th>
                          ))}
                          {records[0]?.ark && (
                            <th className="border-rule border-b p-2 text-left font-medium">ARK</th>
                          )}
                        </tr>
                      </thead>
                      <tbody>
                        {records.map((r: any) => (
                          <tr
                            key={r.id}
                            className="border-rule hover:bg-parchment-dark/50 border-t"
                          >
                            <td className="text-ink-muted p-2 font-mono">{r.id}</td>
                            {currentTypeFields.map((f: string) => {
                              const val = r.data?.[f]
                              if (val && typeof val === 'object' && '$file' in val) {
                                const hash = ((val as any).$file as string).replace('sha256:', '')
                                const fileUrl = `https://assets.underlay.org/files/${hash.slice(0, 2)}/${hash.slice(
                                  2,
                                  4,
                                )}/${hash}`
                                const label = f === 'pdf' ? 'PDF' : 'File'
                                return (
                                  <td key={f} className="p-2">
                                    <Link
                                      to={fileUrl}
                                      target="_blank"
                                      className="text-link inline-flex items-center gap-1 hover:underline"
                                    >
                                      <svg
                                        className="h-3.5 w-3.5"
                                        fill="none"
                                        stroke="currentColor"
                                        viewBox="0 0 24 24"
                                      >
                                        <path
                                          strokeLinecap="round"
                                          strokeLinejoin="round"
                                          strokeWidth={2}
                                          d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                                        />
                                      </svg>
                                      {label}
                                    </Link>
                                  </td>
                                )
                              }
                              if (typeof val === 'string' && val.match(/^https?:\/\//)) {
                                return (
                                  <td key={f} className="max-w-56 truncate p-2">
                                    <Link
                                      to={val}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="text-link hover:underline"
                                    >
                                      {val}
                                    </Link>
                                  </td>
                                )
                              }
                              const display =
                                val === null || val === undefined
                                  ? ''
                                  : typeof val === 'object'
                                    ? JSON.stringify(val)
                                    : String(val)
                              return (
                                <td key={f} className="max-w-56 truncate p-2">
                                  {display}
                                </td>
                              )
                            })}
                            {r.ark && (
                              <td className="p-2">
                                <Link
                                  to={new URL(r.ark).pathname}
                                  className="text-link font-mono text-[11px] hover:underline"
                                >
                                  ark
                                </Link>
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {totalPages > 1 && (
                    <nav className="flex items-center justify-between py-3 text-xs">
                      <span className="text-ink-muted">
                        Showing {offset + 1}–{Math.min(offset + pageSize, totalRecords)} of{' '}
                        {totalRecords.toLocaleString()}
                      </span>
                      <div className="flex items-center gap-1">
                        {page > 1 && (
                          <Link
                            to={`/${owner}/${collection}/v/${n}?type=${currentType}&page=${page - 1}`}
                            className="border-rule hover:bg-parchment-dark rounded border px-2 py-1"
                          >
                            ← Prev
                          </Link>
                        )}
                        {pageNumbers.map((p) => (
                          <Link
                            key={p}
                            to={`/${owner}/${collection}/v/${n}?type=${currentType}&page=${p}`}
                            className={
                              p === page
                                ? 'border-ink bg-ink text-parchment rounded border px-2 py-1 font-medium'
                                : 'border-rule hover:bg-parchment-dark rounded border px-2 py-1'
                            }
                          >
                            {p}
                          </Link>
                        ))}
                        {page < totalPages && (
                          <Link
                            to={`/${owner}/${collection}/v/${n}?type=${currentType}&page=${page + 1}`}
                            className="border-rule hover:bg-parchment-dark rounded border px-2 py-1"
                          >
                            Next →
                          </Link>
                        )}
                      </div>
                    </nav>
                  )}
                </div>
              ) : (
                <p className="text-ink-muted py-8 text-center text-sm">
                  Select a type to view records.
                </p>
              )}
            </div>
          </div>
        )}

        {/* Schema tab */}
        {tab === 'schema' && (
          <div className="border-rule overflow-hidden rounded border">
            <pre className="bg-ink text-parchment overflow-x-auto p-4 font-mono text-xs">
              <code>{JSON.stringify(version.schemas, null, 2)}</code>
            </pre>
          </div>
        )}

        {/* Files tab */}
        {tab === 'files' && (
          <div>
            {files.length === 0 ? (
              <p className="text-ink-muted py-8 text-center text-sm">No files in this version.</p>
            ) : (
              <div>
                <p className="text-ink-muted mb-3 text-xs">
                  {files.length} file{files.length !== 1 ? 's' : ''} ·{' '}
                  {formatBytes(files.reduce((sum: number, f: any) => sum + (f.size ?? 0), 0))} total
                </p>
                <div className="border-rule overflow-hidden rounded border">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-parchment-dark border-rule border-b">
                        <th className="p-2.5 text-left font-medium">File</th>
                        <th className="p-2.5 text-left font-medium">Referenced by</th>
                        <th className="p-2.5 text-right font-medium">Size</th>
                        <th className="p-2.5 text-right font-medium"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {files.map((f: any) => {
                        const refs: any[] = f.references ?? []
                        const isPdf = f.mimeType === 'application/pdf'
                        const isImage = f.mimeType?.startsWith('image/')
                        return (
                          <tr
                            key={f.hash}
                            className="border-rule hover:bg-parchment-dark/50 border-t"
                          >
                            <td className="p-2.5">
                              <div className="flex items-center gap-2">
                                {isPdf ? (
                                  <svg
                                    className="h-4 w-4 shrink-0 text-red-600"
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                  >
                                    <path
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                      strokeWidth={2}
                                      d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"
                                    />
                                  </svg>
                                ) : isImage ? (
                                  <svg
                                    className="h-4 w-4 shrink-0 text-blue-600"
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                  >
                                    <path
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                      strokeWidth={2}
                                      d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                                    />
                                  </svg>
                                ) : (
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
                                      d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                                    />
                                  </svg>
                                )}
                                <div>
                                  <code className="text-ink-muted font-mono text-[11px]">
                                    {f.hash.slice(0, 12)}…
                                  </code>
                                  <span className="text-ink-muted ml-2">{f.mimeType}</span>
                                </div>
                              </div>
                            </td>
                            <td className="p-2.5">
                              {refs.length > 0 ? (
                                <div className="flex flex-wrap gap-1">
                                  {refs.slice(0, 3).map((ref: any, idx: number) => (
                                    <Link
                                      key={idx}
                                      to={`/${owner}/${collection}/v/${n}?type=${ref.type}`}
                                      className="bg-parchment-dark border-rule hover:border-ink-muted inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] transition-colors"
                                    >
                                      <span className="text-ink-muted">{ref.type}</span>
                                      <span className="font-mono">
                                        {ref.recordId.length > 20
                                          ? ref.recordId.slice(0, 20) + '…'
                                          : ref.recordId}
                                      </span>
                                    </Link>
                                  ))}
                                  {refs.length > 3 && (
                                    <span className="text-ink-muted px-1.5 py-0.5 text-[11px]">
                                      +{refs.length - 3} more
                                    </span>
                                  )}
                                </div>
                              ) : (
                                <span className="text-ink-muted">—</span>
                              )}
                            </td>
                            <td className="p-2.5 text-right whitespace-nowrap">
                              {formatBytes(f.size)}
                            </td>
                            <td className="p-2.5 text-right">
                              <a
                                href={`https://assets.underlay.org/files/${f.hash.slice(0, 2)}/${f.hash.slice(
                                  2,
                                  4,
                                )}/${f.hash}`}
                                target="_blank"
                                className="text-link hover:underline"
                              >
                                <svg
                                  className="inline h-4 w-4"
                                  fill="none"
                                  stroke="currentColor"
                                  viewBox="0 0 24 24"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                                  />
                                </svg>
                              </a>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Metadata tab */}
        {tab === 'metadata' && (
          <div className="max-w-2xl">
            {/* Collection-level metadata */}
            <h3 className="text-ink-muted mb-3 text-xs font-semibold tracking-wide uppercase">
              Collection
            </h3>
            <table className="mb-8 w-full text-sm">
              <tbody>
                {collectionData?.name && (
                  <tr className="border-rule border-b">
                    <td className="text-ink-muted w-40 py-3 pr-6 font-medium">Name</td>
                    <td className="py-3">{collectionData.name}</td>
                  </tr>
                )}
                {collectionData?.description && (
                  <tr className="border-rule border-b">
                    <td className="text-ink-muted py-3 pr-6 font-medium">Description</td>
                    <td className="py-3">{collectionData.description}</td>
                  </tr>
                )}
                <tr className="border-rule border-b">
                  <td className="text-ink-muted py-3 pr-6 font-medium">Owner</td>
                  <td className="py-3">
                    <Link to={`/${owner}`} className="text-link hover:underline">
                      {collectionData?.ownerName ?? owner}
                    </Link>{' '}
                    <span className="text-ink-muted text-xs">({owner})</span>
                  </td>
                </tr>
                <tr className="border-rule border-b">
                  <td className="text-ink-muted py-3 pr-6 font-medium">Visibility</td>
                  <td className="py-3">{collectionData?.public ? 'Public' : 'Private'}</td>
                </tr>
              </tbody>
            </table>

            {/* Version-level metadata */}
            <h3 className="text-ink-muted mb-3 text-xs font-semibold tracking-wide uppercase">
              Version
            </h3>
            <table className="mb-8 w-full text-sm">
              <tbody>
                <tr className="border-rule border-b">
                  <td className="text-ink-muted w-40 py-3 pr-6 font-medium">Version</td>
                  <td className="py-3">
                    {version.number} ({version.semver})
                  </td>
                </tr>
                <tr className="border-rule border-b">
                  <td className="text-ink-muted py-3 pr-6 font-medium">Hash</td>
                  <td className="py-3 font-mono text-xs break-all">sha256:{version.hash}</td>
                </tr>
                <tr className="border-rule border-b">
                  <td className="text-ink-muted py-3 pr-6 font-medium">Created</td>
                  <td className="py-3">
                    {new Date(version.createdAt).toLocaleDateString('en-US', {
                      year: 'numeric',
                      month: 'long',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </td>
                </tr>
                {version.baseNumber !== null && version.baseNumber !== undefined && (
                  <tr className="border-rule border-b">
                    <td className="text-ink-muted py-3 pr-6 font-medium">Base version</td>
                    <td className="py-3">
                      <Link
                        to={`/${owner}/${collection}/v/${version.baseNumber}`}
                        className="text-link hover:underline"
                      >
                        v{version.baseNumber}
                      </Link>
                    </td>
                  </tr>
                )}
                {version.message && (
                  <tr className="border-rule border-b">
                    <td className="text-ink-muted py-3 pr-6 font-medium">Message</td>
                    <td className="py-3">{version.message}</td>
                  </tr>
                )}
                <tr className="border-rule border-b">
                  <td className="text-ink-muted py-3 pr-6 font-medium">Records</td>
                  <td className="py-3">{version.recordCount.toLocaleString()}</td>
                </tr>
                <tr className="border-rule border-b">
                  <td className="text-ink-muted py-3 pr-6 font-medium">Files</td>
                  <td className="py-3">{version.fileCount.toLocaleString()}</td>
                </tr>
                <tr className="border-rule border-b">
                  <td className="text-ink-muted py-3 pr-6 font-medium">Total size</td>
                  <td className="py-3">{formatBytes(version.totalBytes)}</td>
                </tr>
                <tr className="border-rule border-b">
                  <td className="text-ink-muted py-3 pr-6 font-medium">Types</td>
                  <td className="py-3">{allTypes.join(', ') || '—'}</td>
                </tr>
              </tbody>
            </table>

            {/* Provenance */}
            <h3 className="text-ink-muted mb-3 text-xs font-semibold tracking-wide uppercase">
              Provenance
            </h3>
            <table className="mb-8 w-full text-sm">
              <tbody>
                {version.appId && (
                  <tr className="border-rule border-b">
                    <td className="text-ink-muted w-40 py-3 pr-6 font-medium">App ID</td>
                    <td className="py-3 font-mono text-xs">{version.appId}</td>
                  </tr>
                )}
                {version.actorId && (
                  <tr className="border-rule border-b">
                    <td className="text-ink-muted py-3 pr-6 font-medium">Actor ID</td>
                    <td className="py-3 font-mono text-xs">{version.actorId}</td>
                  </tr>
                )}
                {version.pushedBy && (
                  <tr className="border-rule border-b">
                    <td className="text-ink-muted py-3 pr-6 font-medium">Pushed by</td>
                    <td className="py-3 font-mono text-xs">{version.pushedBy}</td>
                  </tr>
                )}
                {version.signature && (
                  <tr className="border-rule border-b">
                    <td className="text-ink-muted py-3 pr-6 font-medium">Signature</td>
                    <td className="py-3 font-mono text-xs break-all">{version.signature}</td>
                  </tr>
                )}
              </tbody>
            </table>

            {/* README */}
            {version.readme && readmeHtml && (
              <div>
                <h3 className="text-ink-muted mb-3 text-xs font-semibold tracking-wide uppercase">
                  README
                </h3>
                <div
                  className="border-rule prose prose-sm max-w-none rounded border p-5"
                  dangerouslySetInnerHTML={{ __html: readmeHtml }}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </BaseLayout>
  )
}
