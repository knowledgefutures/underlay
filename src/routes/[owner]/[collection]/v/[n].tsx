import { useEffect, useMemo, useState } from 'react'
import { Link, useLoaderData, useParams, useSearchParams } from 'react-router'

import BaseLayout from '~/components/BaseLayout'
import { TokenLink, useShareToken, withToken } from '~/lib/share-token'
import { useIsOwner } from '~/lib/use-is-owner'

import { CollectionNav, formatBytes } from '..'

export default function CollectionVersionPage() {
  const { owner, collection, n } = useParams()
  const [searchParams] = useSearchParams()
  const { version, collectionData } = useLoaderData() as { version: any; collectionData: any }

  const isOwner = useIsOwner(owner)
  const shareToken = useShareToken()

  const readmeSource = (version.metadata as Record<string, unknown> | null | undefined)?.readme as
    | string
    | null
  const [readmeHtml, setReadmeHtml] = useState<string | null>(null)

  useEffect(() => {
    if (!readmeSource) return
    Promise.all([import('marked'), import('isomorphic-dompurify')]).then(
      ([{ marked }, { default: DOMPurify }]) => {
        setReadmeHtml(DOMPurify.sanitize(marked.parse(readmeSource) as string))
      },
    )
  }, [readmeSource])

  // Tab state
  const tab = searchParams.get('tab') ?? 'records'
  const selectedType = searchParams.get('type') ?? null

  // Records state
  const [records, setRecords] = useState<any[]>([])
  const [totalRecords, setTotalRecords] = useState(0)
  const [recordsLoading, setRecordsLoading] = useState(false)

  // Files state
  const [files, setFiles] = useState<any[]>([])
  const [filesLoading, setFilesLoading] = useState(false)

  const schemasMap = useMemo(
    () => (version.schemas ?? {}) as Record<string, any>,
    [version.schemas],
  )
  const allTypes = useMemo(() => Object.keys(schemasMap).sort(), [schemasMap])
  const currentType = selectedType || (allTypes.length > 0 ? allTypes[0] : null)

  // Fetch records when tab/type/page changes
  const page = parseInt(searchParams.get('page') ?? '1', 10)
  const pageSize = 100

  useEffect(() => {
    if (!version || tab !== 'records') return
    if (!currentType) return

    const offset = (page - 1) * pageSize
    setRecordsLoading(true)
    fetch(
      withToken(
        `/api/collections/${owner}/${collection}/versions/${n}/records?type=${currentType}&limit=${pageSize}&offset=${offset}`,
        shareToken,
      ),
      { credentials: 'include' },
    )
      .then((r) => (r.ok ? r.json() : { records: [], pagination: {} }))
      .then((body) => {
        setRecords(body.records ?? body)
        setTotalRecords(body.pagination?.total ?? version.recordCount ?? 0)
      })
      .finally(() => setRecordsLoading(false))
  }, [version, tab, currentType, page, owner, collection, n, shareToken])

  // Fetch files when files tab selected
  useEffect(() => {
    if (!version || tab !== 'files') return

    setFilesLoading(true)
    fetch(withToken(`/api/collections/${owner}/${collection}/versions/${n}/files`, shareToken), {
      credentials: 'include',
    })
      .then((r) => (r.ok ? r.json() : []))
      .then(setFiles)
      .finally(() => setFilesLoading(false))
  }, [version, tab, owner, collection, n, shareToken])

  const currentTypeFields: string[] = currentType
    ? schemasMap[currentType]?.properties
      ? Object.keys(schemasMap[currentType].properties)
      : // No schema properties: derive columns from the whole page of records,
        // sorted, so column order doesn't change with whichever record is first.
        [...new Set(records.flatMap((r: any) => Object.keys(r.data ?? {})))].sort()
    : []

  const hasArkColumn = records.some((r: any) => r.ark)

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

  return (
    <BaseLayout>
      <div className="mx-auto max-w-5xl px-4 py-8">
        <CollectionNav
          owner={owner!}
          collection={collection!}
          isPublic={collectionData?.public}
          isOwner={!!isOwner}
          active={tab === 'files' ? 'files' : tab === 'metadata' ? 'overview' : 'records'}
          version={version.semver}
          isLatest={collectionData?.latestVersion?.semver === version.semver}
        />

        {/* The overview sidebar shows the message; other tabs get it as context. */}
        {version.message && tab !== 'metadata' ? (
          <p className="text-ink-muted mb-4 text-sm">{version.message}</p>
        ) : (
          <div className="mb-4" />
        )}

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

        {/* Records tab */}
        {tab === 'records' && (
          <div className="grid grid-cols-[180px_1fr] gap-6">
            {/* Type sidebar */}
            <nav className="space-y-0.5">
              <h3 className="text-ink-muted mb-2 text-xs font-semibold tracking-wide uppercase">
                Types
              </h3>
              {allTypes.map((t) => (
                <TokenLink
                  key={t}
                  to={`/${owner}/${collection}/v/${n}?type=${t}`}
                  className={`block rounded px-3 py-1.5 text-sm transition-colors ${
                    t === currentType
                      ? 'bg-ink text-parchment font-medium'
                      : 'text-ink-muted hover:bg-parchment-dark hover:text-ink'
                  }`}
                >
                  {t}
                </TokenLink>
              ))}
            </nav>

            {/* Table area */}
            <div className="min-w-0">
              {currentType && records.length > 0 ? (
                <div>
                  <div className="border-rule rounded-surface max-h-[75vh] overflow-auto border">
                    <table className="w-full text-xs">
                      <thead>
                        <tr>
                          <th className="border-rule bg-parchment-dark sticky top-0 z-10 border-b p-2 text-left font-medium">
                            id
                          </th>
                          {currentTypeFields.map((f: string) => (
                            <th
                              key={f}
                              className="border-rule bg-parchment-dark sticky top-0 z-10 border-b p-2 text-left font-medium"
                            >
                              {f}
                            </th>
                          ))}
                          {hasArkColumn && (
                            <th className="border-rule bg-parchment-dark sticky top-0 z-10 border-b p-2 text-left font-medium">
                              ARK
                            </th>
                          )}
                          <th className="border-rule bg-parchment-dark sticky top-0 right-0 z-20 w-8 border-b border-l" />
                        </tr>
                      </thead>
                      <tbody>
                        {records.map((r: any) => (
                          <tr
                            key={r.id}
                            className="border-rule group hover:bg-parchment-dark border-t transition-colors"
                          >
                            <td className="text-ink-muted p-2 font-mono">{r.id}</td>
                            {currentTypeFields.map((f: string) => {
                              const val = r.data?.[f]
                              if (val && typeof val === 'object' && '$file' in val) {
                                const hash = ((val as any).$file as string).replace('sha256:', '')
                                // Route through the API so access is checked and
                                // a presigned URL is minted (files are private).
                                const fileUrl = withToken(
                                  `/api/collections/${owner}/${collection}/files/${hash}`,
                                  shareToken,
                                )
                                const label = f === 'pdf' ? 'PDF' : 'File'
                                return (
                                  <td key={f} className="p-2">
                                    <a
                                      href={fileUrl}
                                      target="_blank"
                                      rel="noopener noreferrer"
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
                                    </a>
                                  </td>
                                )
                              }
                              if (typeof val === 'string' && val.match(/^https?:\/\//)) {
                                return (
                                  <td key={f} className="max-w-56 truncate p-2" title={val}>
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
                                <td
                                  key={f}
                                  className="max-w-56 truncate p-2"
                                  title={display || undefined}
                                >
                                  {display}
                                </td>
                              )
                            })}
                            {hasArkColumn && (
                              <td className="p-2">
                                {r.ark && (
                                  <Link
                                    to={new URL(r.ark).pathname}
                                    className="text-link font-mono text-[11px] hover:underline"
                                  >
                                    ark
                                  </Link>
                                )}
                              </td>
                            )}
                            <td className="border-rule bg-parchment group-hover:bg-parchment-dark sticky right-0 w-8 border-l p-2 transition-colors">
                              {r.hash && (
                                <TokenLink
                                  to={`/records/${r.hash}`}
                                  className="text-ink-muted hover:text-ink inline-flex items-center"
                                  title="View record provenance"
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
                                      d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
                                    />
                                  </svg>
                                </TokenLink>
                              )}
                            </td>
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
                          <TokenLink
                            to={`/${owner}/${collection}/v/${n}?type=${currentType}&page=${page - 1}`}
                            className="border-rule hover:bg-parchment-dark rounded border px-2 py-1"
                          >
                            ← Prev
                          </TokenLink>
                        )}
                        {pageNumbers.map((p) => (
                          <TokenLink
                            key={p}
                            to={`/${owner}/${collection}/v/${n}?type=${currentType}&page=${p}`}
                            className={
                              p === page
                                ? 'border-ink bg-ink text-parchment rounded border px-2 py-1 font-medium'
                                : 'border-rule hover:bg-parchment-dark rounded border px-2 py-1'
                            }
                          >
                            {p}
                          </TokenLink>
                        ))}
                        {page < totalPages && (
                          <TokenLink
                            to={`/${owner}/${collection}/v/${n}?type=${currentType}&page=${page + 1}`}
                            className="border-rule hover:bg-parchment-dark rounded border px-2 py-1"
                          >
                            Next →
                          </TokenLink>
                        )}
                      </div>
                    </nav>
                  )}
                </div>
              ) : (
                <p className="text-ink-muted py-8 text-center text-sm">
                  {!currentType
                    ? 'Select a type to view records.'
                    : recordsLoading
                      ? 'Loading records…'
                      : 'No records of this type in this version.'}
                </p>
              )}
            </div>
          </div>
        )}

        {/* Schema tab */}
        {tab === 'schema' && (
          <div className="border-rule rounded-surface overflow-hidden border">
            <pre className="bg-ink text-parchment overflow-x-auto p-4 font-mono text-xs">
              <code>{JSON.stringify(version.schemas, null, 2)}</code>
            </pre>
          </div>
        )}

        {/* Files tab */}
        {tab === 'files' && (
          <div>
            {files.length === 0 ? (
              <p className="text-ink-muted py-8 text-center text-sm">
                {filesLoading ? 'Loading files…' : 'No files in this version.'}
              </p>
            ) : (
              <div>
                <p className="text-ink-muted mb-3 text-xs">
                  {files.length} file{files.length !== 1 ? 's' : ''} ·{' '}
                  {formatBytes(files.reduce((sum: number, f: any) => sum + (f.size ?? 0), 0))} total
                </p>
                <div className="border-rule rounded-surface overflow-x-auto border">
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
                                    <TokenLink
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
                                    </TokenLink>
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
                                href={withToken(
                                  `/api/collections/${owner}/${collection}/files/${f.hash}`,
                                  shareToken,
                                )}
                                target="_blank"
                                rel="noopener noreferrer"
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
          <div className="grid grid-cols-1 gap-8 md:grid-cols-[1fr_260px]">
            {/* README — the main content, like the collection overview */}
            <div className="min-w-0">
              {readmeHtml ? (
                <div
                  className="prose prose-sm max-w-none"
                  dangerouslySetInnerHTML={{ __html: readmeHtml }}
                />
              ) : (
                <p className="text-ink-muted py-8 text-sm">No README in this version.</p>
              )}
            </div>

            {/* Version facts sidebar */}
            <aside className="space-y-6">
              <div>
                <h3 className="text-ink-muted mb-2 text-xs font-semibold tracking-wide uppercase">
                  Version
                </h3>
                <dl className="space-y-2 text-sm">
                  <div>
                    <dt className="text-ink-muted text-xs">Version</dt>
                    <dd className="font-mono">{version.semver}</dd>
                  </div>
                  <div>
                    <dt className="text-ink-muted text-xs">Created</dt>
                    <dd>
                      {new Date(version.createdAt).toLocaleDateString('en-US', {
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </dd>
                  </div>
                  {version.message && (
                    <div>
                      <dt className="text-ink-muted text-xs">Message</dt>
                      <dd>{version.message}</dd>
                    </div>
                  )}
                  {version.baseSemver && (
                    <div>
                      <dt className="text-ink-muted text-xs">Base version</dt>
                      <dd>
                        <TokenLink
                          to={`/${owner}/${collection}/v/${version.baseSemver}?tab=metadata`}
                          className="text-link font-mono hover:underline"
                        >
                          {version.baseSemver}
                        </TokenLink>
                      </dd>
                    </div>
                  )}
                </dl>
              </div>

              <div className="border-rule border-t pt-4">
                <h3 className="text-ink-muted mb-2 text-xs font-semibold tracking-wide uppercase">
                  Contents
                </h3>
                <dl className="space-y-1 text-sm">
                  <div className="flex justify-between gap-3">
                    <dt className="text-ink-muted">Records</dt>
                    <dd>{version.recordCount.toLocaleString()}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-ink-muted">Files</dt>
                    <dd>{version.fileCount.toLocaleString()}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-ink-muted">Total size</dt>
                    <dd>{formatBytes(version.totalBytes)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-ink-muted">Types</dt>
                    <dd className="text-right">{allTypes.length}</dd>
                  </div>
                </dl>
                {allTypes.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {allTypes.map((t) => (
                      <TokenLink
                        key={t}
                        to={`/${owner}/${collection}/v/${n}?type=${t}`}
                        className="border-rule text-ink-muted hover:text-ink rounded-control border px-1.5 py-0.5 font-mono text-[11px] transition-colors"
                      >
                        {t}
                      </TokenLink>
                    ))}
                  </div>
                )}
              </div>

              <div className="border-rule border-t pt-4">
                <h3 className="text-ink-muted mb-2 text-xs font-semibold tracking-wide uppercase">
                  Integrity
                </h3>
                <dl className="space-y-2 text-sm">
                  <div>
                    <dt className="text-ink-muted text-xs">Hash</dt>
                    <dd className="font-mono text-xs break-all" title={`sha256:${version.hash}`}>
                      sha256:{version.hash}
                    </dd>
                  </div>
                  {versionArkPath && (
                    <div>
                      <dt className="text-ink-muted text-xs">ARK</dt>
                      <dd>
                        <Link
                          to={versionArkPath}
                          className="text-link font-mono text-xs break-all hover:underline"
                        >
                          {versionArkPath.slice(1)}
                        </Link>
                      </dd>
                    </div>
                  )}
                </dl>
              </div>

              {(version.appId || version.actorId || version.pushedBy || version.signature) && (
                <div className="border-rule border-t pt-4">
                  <h3 className="text-ink-muted mb-2 text-xs font-semibold tracking-wide uppercase">
                    Provenance
                  </h3>
                  <dl className="space-y-2 text-sm">
                    {version.appId && (
                      <div>
                        <dt className="text-ink-muted text-xs">App ID</dt>
                        <dd className="font-mono text-xs">{version.appId}</dd>
                      </div>
                    )}
                    {version.actorId && (
                      <div>
                        <dt className="text-ink-muted text-xs">Actor ID</dt>
                        <dd className="font-mono text-xs break-all">{version.actorId}</dd>
                      </div>
                    )}
                    {version.pushedBy && (
                      <div>
                        <dt className="text-ink-muted text-xs">Pushed by</dt>
                        <dd className="font-mono text-xs">{version.pushedBy}</dd>
                      </div>
                    )}
                    {version.signature && (
                      <div>
                        <dt className="text-ink-muted text-xs">Signature</dt>
                        <dd className="font-mono text-xs break-all">{version.signature}</dd>
                      </div>
                    )}
                  </dl>
                </div>
              )}
            </aside>
          </div>
        )}
      </div>
    </BaseLayout>
  )
}
