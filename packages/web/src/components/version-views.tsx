import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigation, useSearchParams } from 'react-router'

import { formatBytes, formatCount, formatDate, prefixedHash, shortHash } from '~/lib/format'
import { RECORDS_PAGE_SIZE, type RecordsPage } from '~/lib/records-page'
import { TokenLink, useShareToken, withToken } from '~/lib/share-token'

/**
 * The version-scoped content views (records, files, overview), shared by the
 * latest-context routes (/:owner/:collection/records, /files) and the pinned
 * routes (/:owner/:collection/v/:n/...). Each takes the loaded version object
 * plus the page's own path (`basePath`) so pagination and type links stay on
 * whichever route is rendering.
 */

export function VersionInfoBar({
  version,
  typeCount,
  showMessage = true,
}: {
  version: any
  typeCount: number
  showMessage?: boolean
}) {
  const versionArkPath: string | null = version.ark ? new URL(version.ark).pathname : null
  return (
    <>
      {showMessage && version.message ? (
        <p className="text-ink-muted mb-4 text-sm">{version.message}</p>
      ) : (
        <div className="mb-4" />
      )}
      <div className="text-ink-muted border-rule bg-parchment-dark rounded-surface mb-6 flex flex-wrap items-center justify-between gap-y-1 border px-4 py-2.5 text-xs">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span>
            <strong className="text-ink">{version.recordCount.toLocaleString('en-US')}</strong>{' '}
            {version.recordCount === 1 ? 'record' : 'records'}
          </span>
          <span>
            <strong className="text-ink">{version.fileCount.toLocaleString('en-US')}</strong>{' '}
            {version.fileCount === 1 ? 'file' : 'files'}
          </span>
          <span>
            <strong className="text-ink">{formatBytes(version.totalBytes)}</strong> total
          </span>
          <span>
            <strong className="text-ink">{typeCount}</strong> {typeCount === 1 ? 'type' : 'types'}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {version.pushedByName && (
            <span>
              by{' '}
              {version.pushedBySlug ? (
                <Link
                  to={`/${version.pushedBySlug}`}
                  className="text-link font-semibold hover:underline"
                >
                  {version.pushedByName}
                </Link>
              ) : (
                <strong className="text-ink">{version.pushedByName}</strong>
              )}
            </span>
          )}
          {version.appId && (
            <span>
              via <strong className="text-ink">{version.appId}</strong>
            </span>
          )}
          <span>{formatDate(version.createdAt)}</span>
          <code className="text-ink-muted font-mono text-[11px]" title={prefixedHash(version.hash)}>
            {shortHash(version.hash, 12)}
          </code>
          {versionArkPath && (
            <Link to={versionArkPath} className="text-link font-mono text-[11px] hover:underline">
              {versionArkPath.slice(1)}
            </Link>
          )}
        </div>
      </div>
    </>
  )
}

export function RecordsView({
  owner,
  collection,
  version,
  basePath,
  page: loaded,
}: {
  owner: string
  collection: string
  version: any
  /** The page's own path, e.g. `/acme/pubs/records` or `/acme/pubs/v/1.0.0/records`. */
  basePath: string
  /**
   * The page of records the route's loader fetched (lib/records-page.ts). The
   * loader re-runs when ?type= or ?page= changes, so it's always the current one.
   */
  page: RecordsPage | null
}) {
  const shareToken = useShareToken()
  const navigation = useNavigation()
  const [searchParams] = useSearchParams()
  // Showing the previous page while the next one loads.
  const recordsLoading = navigation.state === 'loading' && navigation.location.pathname === basePath

  const schemasMap = useMemo(
    () => (version.schemas ?? {}) as Record<string, any>,
    [version.schemas],
  )
  // Every type, from the counts: a records page's version carries only the shown type's schema.
  const allTypes = useMemo(
    () => Object.keys(version.typeCounts ?? schemasMap).sort(),
    [version.typeCounts, schemasMap],
  )
  const currentType = loaded?.type ?? null
  const records = loaded?.records ?? []
  const totalRecords = loaded?.total ?? 0

  const page = loaded?.page ?? 1
  const pageSize = RECORDS_PAGE_SIZE

  const currentTypeFields: string[] = currentType
    ? schemasMap[currentType]?.properties
      ? schemaColumns(schemasMap[currentType])
      : // No schema properties: derive columns from the whole page of records,
        // sorted, so column order doesn't change with whichever record is first.
        [...new Set(records.flatMap((r: any) => Object.keys(r.data ?? {})))].sort()
    : []
  // ?type= naming a type this version doesn't have.
  const askedType = searchParams.get('type')
  const unknownType = !!askedType && !allTypes.includes(askedType)

  const hasArkColumn = records.some((r: any) => r.ark)

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
        // Includes a page past the end: the last seven.
        p = totalPages - 6 + i
      } else {
        p = page - 3 + i
      }
      pageNumbers.push(p)
    }
  }

  const pastEnd = !!currentType && records.length === 0 && totalRecords > 0 && !recordsLoading
  const pageHref = (p: number) => `${basePath}?type=${currentType}&page=${p}`
  const step = 'border-rule hover:bg-parchment-dark rounded-control border px-2 py-1'
  const pager = totalPages > 1 && (
    <nav className="flex flex-wrap items-center justify-between gap-2 py-3 text-xs">
      <span className="text-ink-muted">
        {pastEnd
          ? `${totalRecords.toLocaleString('en-US')} records`
          : `Showing ${(offset + 1).toLocaleString('en-US')}–${Math.min(offset + pageSize, totalRecords).toLocaleString('en-US')} of ${totalRecords.toLocaleString('en-US')}`}
      </span>
      <div className="flex flex-wrap items-center gap-1">
        {page > 1 && (
          <>
            <TokenLink to={pageHref(1)} className={step}>
              « First
            </TokenLink>
            <TokenLink to={pageHref(Math.min(page - 1, totalPages))} className={step}>
              ← Prev
            </TokenLink>
          </>
        )}
        {pageNumbers.map((p) => (
          <TokenLink
            key={p}
            to={pageHref(p)}
            className={
              p === page
                ? 'border-ink bg-ink text-parchment visited:text-parchment rounded-control border px-2 py-1 font-medium'
                : step
            }
          >
            {p.toLocaleString('en-US')}
          </TokenLink>
        ))}
        {page < totalPages && (
          <>
            <TokenLink to={pageHref(page + 1)} className={step}>
              Next →
            </TokenLink>
            <TokenLink to={pageHref(totalPages)} className={step}>
              Last »
            </TokenLink>
          </>
        )}
      </div>
    </nav>
  )

  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-[180px_1fr]">
      {/* Type nav: a scrolling row on small screens, a sidebar from md up */}
      <nav className="min-w-0">
        <h3 className="text-ink-muted mb-2 text-xs font-semibold tracking-wide uppercase">Types</h3>
        <div className="flex gap-1 overflow-x-auto pb-1 md:block md:space-y-0.5 md:overflow-x-visible md:pb-0">
          {allTypes.map((t) => (
            <TokenLink
              key={t}
              to={`${basePath}?type=${t}`}
              className={`rounded-control block shrink-0 px-3 py-1.5 text-sm whitespace-nowrap transition-colors ${
                t === currentType
                  ? 'bg-ink text-parchment visited:text-parchment font-medium'
                  : 'text-ink-muted hover:bg-parchment-dark hover:text-ink'
              }`}
            >
              {t}
              {version.typeCounts?.[t] !== undefined && (
                <span
                  className={`ml-2 text-xs ${t === currentType ? 'text-parchment/70' : 'text-ink-muted'}`}
                >
                  {formatCount(version.typeCounts[t])}
                </span>
              )}
            </TokenLink>
          ))}
        </div>
      </nav>

      {/* Table area */}
      <div className="min-w-0">
        {currentType && records.length > 0 ? (
          <div>
            <div className="border-rule rounded-surface max-h-[75vh] overflow-auto border">
              {/* border-separate: collapsed borders don't travel with sticky cells,
                  so all row/column rules live on the cells themselves. */}
              <table className="w-full border-separate border-spacing-0 text-xs">
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
                    {/* after: covers the subpixel gap sticky right-0 can leave at the scrollport edge */}
                    <th className="border-rule bg-parchment-dark sticky top-0 right-0 z-20 w-8 border-b border-l after:absolute after:inset-y-0 after:left-full after:w-0.5 after:bg-inherit" />
                  </tr>
                </thead>
                <tbody>
                  {records.map((r: any) => (
                    <tr key={r.id} className="group hover:bg-parchment-dark transition-colors">
                      <td
                        className="text-ink-muted border-rule max-w-56 truncate border-b p-2 font-mono"
                        title={r.private ? `${r.id} (private)` : r.id}
                      >
                        {r.id}
                        {r.private && (
                          <span className="border-rule text-ink-muted rounded-control ml-1.5 border px-1 py-px font-sans text-[10px]">
                            private
                          </span>
                        )}
                      </td>
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
                            <td key={f} className="border-rule border-b p-2">
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
                            <td
                              key={f}
                              className="border-rule max-w-56 truncate border-b p-2"
                              title={val}
                            >
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
                          val === null || val === undefined || val === ''
                            ? ''
                            : typeof val === 'object'
                              ? JSON.stringify(val)
                              : String(val)
                        return (
                          <td
                            key={f}
                            className="border-rule max-w-56 truncate border-b p-2"
                            title={display || undefined}
                          >
                            {display || <span className="text-ink-muted/60">—</span>}
                          </td>
                        )
                      })}
                      {hasArkColumn && (
                        <td className="border-rule border-b p-2">
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
                      <td className="border-rule bg-parchment group-hover:bg-parchment-dark sticky right-0 w-8 border-b border-l p-2 transition-colors after:absolute after:inset-y-0 after:left-full after:w-0.5 after:bg-inherit">
                        {r.hash && currentType && (
                          <TokenLink
                            to={`/${owner}/${collection}/v/${String(version.semver).replace(/^v/, '')}/records/${encodeURIComponent(currentType)}/${encodeURIComponent(r.id)}`}
                            className="text-ink-muted hover:text-ink inline-flex items-center"
                            title="View this record"
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

            {pager}
          </div>
        ) : pastEnd ? (
          <div>
            <p className="text-ink-muted py-8 text-center text-sm">
              Page {page.toLocaleString('en-US')} is past the end (
              {totalPages.toLocaleString('en-US')} page{totalPages === 1 ? '' : 's'}).{' '}
              <TokenLink to={pageHref(totalPages)} className="text-link hover:underline">
                Go to the last page
              </TokenLink>
            </p>
            {pager}
          </div>
        ) : (
          <p className="text-ink-muted py-8 text-center text-sm">
            {unknownType
              ? `This version has no type named “${askedType}”.`
              : !currentType
                ? 'Select a type to view records.'
                : recordsLoading
                  ? 'Loading records…'
                  : 'No records of this type in this version.'}
          </p>
        )}
      </div>
    </div>
  )
}

/**
 * A schema's columns. Stored schemas are canonical JSON, so `properties` comes
 * back alphabetical: an explicit `propertyOrder` list goes first, then the
 * `required` list (arrays keep their order), then the rest alphabetically.
 */
function schemaColumns(schema: any): string[] {
  const props = Object.keys(schema.properties ?? {})
  const listed = [
    ...(Array.isArray(schema.propertyOrder) ? schema.propertyOrder : []),
    ...(Array.isArray(schema.required) ? schema.required : []),
  ].filter((k): k is string => typeof k === 'string' && props.includes(k))
  return [...new Set([...listed, ...props.sort()])]
}

export function FilesView({
  owner,
  collection,
  version,
  recordsPath,
}: {
  owner: string
  collection: string
  version: any
  /** The sibling records page path, for "referenced by" links. */
  recordsPath: string
}) {
  const shareToken = useShareToken()
  const [files, setFiles] = useState<any[]>([])
  const [filesLoading, setFilesLoading] = useState(false)
  const semver = version.semver as string

  useEffect(() => {
    setFilesLoading(true)
    fetch(
      withToken(`/api/collections/${owner}/${collection}/versions/${semver}/files`, shareToken),
      { credentials: 'include' },
    )
      .then((r) => (r.ok ? r.json() : []))
      .then(setFiles)
      .finally(() => setFilesLoading(false))
  }, [owner, collection, semver, shareToken])

  if (files.length === 0) {
    return (
      <p className="text-ink-muted py-8 text-center text-sm">
        {filesLoading ? 'Loading files…' : 'No files in this version.'}
      </p>
    )
  }

  return (
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
                <tr key={f.hash} className="border-rule hover:bg-parchment-dark/50 border-t">
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
                            to={`${recordsPath}?type=${ref.type}`}
                            className="bg-parchment-dark border-rule hover:border-ink-muted rounded-control inline-flex items-center gap-1 border px-1.5 py-0.5 text-[11px] transition-colors"
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
                    ) : f.referenceCount > 0 ? (
                      // v2 counts a file's references but doesn't list the records.
                      <span className="text-ink-muted">
                        {f.referenceCount.toLocaleString('en-US')} record
                        {f.referenceCount === 1 ? '' : 's'}
                      </span>
                    ) : (
                      <span className="text-ink-muted">—</span>
                    )}
                  </td>
                  <td className="p-2.5 text-right whitespace-nowrap">{formatBytes(f.size)}</td>
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
  )
}
