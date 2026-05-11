import { useEffect, useState, } from 'react'
import { Link, useParams, useSearchParams, } from 'react-router'
import BaseLayout from '~/components/BaseLayout'
import { useSSRData, } from '~/lib/ssr-data'
import { CollectionNav, formatBytes, } from '..'

export default function CollectionVersionPage() {
  const { owner, collection, n, } = useParams()
  const [searchParams, setSearchParams,] = useSearchParams()
  const currentUser = useSSRData<any>('currentUser',)

  const [version, setVersion,] = useState<any>(null,)
  const [collectionData, setCollectionData,] = useState<any>(null,)
  const [isOwner, setIsOwner,] = useState(false,)
  const [readmeHtml, setReadmeHtml,] = useState<string | null>(null,)
  const [loading, setLoading,] = useState(true,)

  // Tab state
  const tab = searchParams.get('tab',) ?? 'records'
  const selectedType = searchParams.get('type',) ?? null

  // Records state
  const [records, setRecords,] = useState<any[]>([],)
  const [totalRecords, setTotalRecords,] = useState(0,)

  // Files state
  const [files, setFiles,] = useState<any[]>([],)

  useEffect(() => {
    if (!owner || !collection || !n) return

    Promise.all([
      fetch(`/api/collections/${owner}/${collection}/versions/${n}`, {
        credentials: 'include',
      },).then((r,) => (r.ok ? r.json() : null)),
      fetch(`/api/collections/${owner}/${collection}`, { credentials: 'include', },).then((r,) =>
        r.ok ? r.json() : null
      ),
    ],).then(([ver, col,],) => {
      if (!ver) {
        window.location.href = '/404'
        return
      }
      setVersion(ver,)
      setCollectionData(col,)

      if (ver.readme) {
        import('marked').then(({ marked, },) => {
          setReadmeHtml(marked.parse(ver.readme,) as string,)
        },)
      }

      if (currentUser) {
        setIsOwner(
          currentUser.slug === owner
            || currentUser.orgs?.some((o: any,) => o.slug === owner),
        )
      }

      setLoading(false,)
    },)
  }, [owner, collection, n, currentUser,],)

  // Fetch records when tab/type/page changes
  const page = parseInt(searchParams.get('page',) ?? '1', 10,)
  const pageSize = 100

  useEffect(() => {
    if (!version || tab !== 'records') return

    const schemasMap = (version.schemas ?? {}) as Record<string, any>
    const allTypes = Object.keys(schemasMap,).sort()
    const currentType = selectedType || (allTypes.length > 0 ? allTypes[0] : null)

    if (!currentType) return

    const offset = (page - 1) * pageSize
    fetch(
      `/api/collections/${owner}/${collection}/versions/${n}/records?type=${currentType}&limit=${pageSize}&offset=${offset}`,
      { credentials: 'include', },
    )
      .then((r,) => (r.ok ? r.json() : { records: [], pagination: {}, }))
      .then((body,) => {
        setRecords(body.records ?? body,)
        setTotalRecords(body.pagination?.total ?? version.recordCount ?? 0,)
      },)
  }, [version, tab, selectedType, page, owner, collection, n,],)

  // Fetch files when files tab selected
  useEffect(() => {
    if (!version || tab !== 'files') return

    fetch(`/api/collections/${owner}/${collection}/versions/${n}/files`, {
      credentials: 'include',
    },)
      .then((r,) => (r.ok ? r.json() : []))
      .then(setFiles,)
  }, [version, tab, owner, collection, n,],)

  if (loading || !version) {
    return (
      <BaseLayout>
        <div className='max-w-5xl mx-auto px-4 py-8 text-sm text-ink-muted'>Loading…</div>
      </BaseLayout>
    )
  }

  const schemasMap = (version.schemas ?? {}) as Record<string, any>
  const allTypes = Object.keys(schemasMap,).sort()
  const currentType = selectedType || (allTypes.length > 0 ? allTypes[0] : null)

  const currentTypeFields: string[] = currentType
    ? schemasMap[currentType]?.properties
      ? Object.keys(schemasMap[currentType].properties,)
      : records.length > 0
      ? Object.keys(records[0].data ?? {},)
      : []
    : []

  const versionArkPath: string | null = version.ark ? new URL(version.ark,).pathname : null

  const offset = (page - 1) * pageSize
  const totalPages = Math.ceil(totalRecords / pageSize,) || 1

  const pageNumbers: number[] = []
  if (totalPages > 1) {
    const maxVisible = Math.min(totalPages, 7,)
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
      pageNumbers.push(p,)
    }
  }

  function setTab(t: string, extra?: Record<string, string>,) {
    const params = new URLSearchParams()
    if (t !== 'records') params.set('tab', t,)
    if (extra) {
      for (const [k, v,] of Object.entries(extra,)) params.set(k, v,)
    }
    setSearchParams(params,)
  }

  return (
    <BaseLayout>
      <div className='max-w-5xl mx-auto px-4 py-8'>
        <CollectionNav
          owner={owner!}
          collection={collection!}
          isPublic={collectionData?.public}
          isOwner={isOwner}
          active='versions'
          versionLabel={version.semver}
        />

        {version.message && <p className='text-sm text-ink-muted mb-4'>{version.message}</p>}
        {!version.message && <div className='mb-4' />}

        {/* Info bar */}
        <div className='flex items-center justify-between text-xs text-ink-muted py-2.5 px-4 border border-rule rounded bg-parchment-dark mb-6'>
          <div className='flex items-center gap-4'>
            <span>
              <strong className='text-ink'>{version.recordCount.toLocaleString()}</strong> records
            </span>
            <span>
              <strong className='text-ink'>{version.fileCount.toLocaleString()}</strong> files
            </span>
            <span>
              <strong className='text-ink'>{formatBytes(version.totalBytes,)}</strong> total
            </span>
            <span>
              <strong className='text-ink'>{allTypes.length}</strong> types
            </span>
          </div>
          <div className='flex items-center gap-4'>
            {version.appId && (
              <span>
                via <strong className='text-ink'>{version.appId}</strong>
              </span>
            )}
            <span>
              {new Date(version.createdAt,).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              },)}
            </span>
            <code className='font-mono text-[11px] text-ink-muted' title={version.hash}>
              sha256:{version.hash.slice(0, 12,)}…
            </code>
            {versionArkPath && (
              <Link
                to={versionArkPath}
                className='font-mono text-[11px] text-link hover:underline'
              >
                {versionArkPath.slice(1,)}
              </Link>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div className='flex items-center gap-0 border-b border-rule mb-6'>
          <button
            onClick={() => setTab('records', currentType ? { type: currentType, } : undefined,)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === 'records'
                ? 'border-ink text-ink'
                : 'border-transparent text-ink-muted hover:text-ink hover:border-rule'
            }`}
          >
            Records{' '}
            <span className='text-ink-muted font-normal'>
              ({version.recordCount.toLocaleString()})
            </span>
          </button>
          <button
            onClick={() => setTab('schema',)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === 'schema'
                ? 'border-ink text-ink'
                : 'border-transparent text-ink-muted hover:text-ink hover:border-rule'
            }`}
          >
            Schema
          </button>
          <button
            onClick={() => setTab('files',)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === 'files'
                ? 'border-ink text-ink'
                : 'border-transparent text-ink-muted hover:text-ink hover:border-rule'
            }`}
          >
            Files{' '}
            <span className='text-ink-muted font-normal'>
              ({version.fileCount.toLocaleString()})
            </span>
          </button>
          <button
            onClick={() => setTab('metadata',)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === 'metadata'
                ? 'border-ink text-ink'
                : 'border-transparent text-ink-muted hover:text-ink hover:border-rule'
            }`}
          >
            Metadata
          </button>
        </div>

        {/* Records tab */}
        {tab === 'records' && (
          <div className='grid grid-cols-[180px_1fr] gap-6'>
            {/* Type sidebar */}
            <nav className='space-y-0.5'>
              <h3 className='text-xs font-semibold uppercase tracking-wide text-ink-muted mb-2'>
                Types
              </h3>
              {allTypes.map((t,) => (
                <Link
                  key={t}
                  to={`/${owner}/${collection}/v/${n}?type=${t}`}
                  className={`block px-3 py-1.5 text-sm rounded transition-colors ${
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
            <div className='min-w-0'>
              {currentType && records.length > 0
                ? (
                  <div>
                    <div className='overflow-x-auto border border-rule rounded'>
                      <table className='w-full text-xs'>
                        <thead>
                          <tr className='bg-parchment-dark'>
                            <th className='text-left p-2 font-medium border-b border-rule'>
                              id
                            </th>
                            {currentTypeFields.map((f: string,) => (
                              <th
                                key={f}
                                className='text-left p-2 font-medium border-b border-rule'
                              >
                                {f}
                              </th>
                            ))}
                            {records[0]?.ark && (
                              <th className='text-left p-2 font-medium border-b border-rule'>
                                ARK
                              </th>
                            )}
                          </tr>
                        </thead>
                        <tbody>
                          {records.map((r: any,) => (
                            <tr
                              key={r.id}
                              className='border-t border-rule hover:bg-parchment-dark/50'
                            >
                              <td className='p-2 font-mono text-ink-muted'>{r.id}</td>
                              {currentTypeFields.map((f: string,) => {
                                const val = r.data?.[f]
                                if (val && typeof val === 'object' && '$file' in val) {
                                  const hash = (
                                    (val as any).$file as string
                                  ).replace('sha256:', '',)
                                  const fileUrl = `https://assets.underlay.org/files/${hash.slice(0, 2,)}/${
                                    hash.slice(2, 4,)
                                  }/${hash}`
                                  const label = f === 'pdf' ? 'PDF' : 'File'
                                  return (
                                    <td key={f} className='p-2'>
                                      <Link
                                        to={fileUrl}
                                        target='_blank'
                                        className='inline-flex items-center gap-1 text-link hover:underline'
                                      >
                                        <svg
                                          className='w-3.5 h-3.5'
                                          fill='none'
                                          stroke='currentColor'
                                          viewBox='0 0 24 24'
                                        >
                                          <path
                                            strokeLinecap='round'
                                            strokeLinejoin='round'
                                            strokeWidth={2}
                                            d='M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z'
                                          />
                                        </svg>
                                        {label}
                                      </Link>
                                    </td>
                                  )
                                }
                                if (
                                  typeof val === 'string'
                                  && val.match(/^https?:\/\//,)
                                ) {
                                  return (
                                    <td key={f} className='p-2 max-w-56 truncate'>
                                      <Link
                                        to={val}
                                        target='_blank'
                                        rel='noopener noreferrer'
                                        className='text-link hover:underline'
                                      >
                                        {val}
                                      </Link>
                                    </td>
                                  )
                                }
                                const display = val === null || val === undefined
                                  ? ''
                                  : typeof val === 'object'
                                  ? JSON.stringify(val,)
                                  : String(val,)
                                return (
                                  <td key={f} className='p-2 max-w-56 truncate'>
                                    {display}
                                  </td>
                                )
                              },)}
                              {r.ark && (
                                <td className='p-2'>
                                  <Link
                                    to={new URL(r.ark,).pathname}
                                    className='font-mono text-[11px] text-link hover:underline'
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
                      <nav className='flex items-center justify-between py-3 text-xs'>
                        <span className='text-ink-muted'>
                          Showing {offset + 1}–{Math.min(offset + pageSize, totalRecords,)} of{' '}
                          {totalRecords.toLocaleString()}
                        </span>
                        <div className='flex items-center gap-1'>
                          {page > 1 && (
                            <Link
                              to={`/${owner}/${collection}/v/${n}?type=${currentType}&page=${page - 1}`}
                              className='border border-rule px-2 py-1 rounded hover:bg-parchment-dark'
                            >
                              ← Prev
                            </Link>
                          )}
                          {pageNumbers.map((p,) => (
                            <Link
                              key={p}
                              to={`/${owner}/${collection}/v/${n}?type=${currentType}&page=${p}`}
                              className={p === page
                                ? 'border border-ink bg-ink text-parchment font-medium px-2 py-1 rounded'
                                : 'border border-rule px-2 py-1 rounded hover:bg-parchment-dark'}
                            >
                              {p}
                            </Link>
                          ))}
                          {page < totalPages && (
                            <Link
                              to={`/${owner}/${collection}/v/${n}?type=${currentType}&page=${page + 1}`}
                              className='border border-rule px-2 py-1 rounded hover:bg-parchment-dark'
                            >
                              Next →
                            </Link>
                          )}
                        </div>
                      </nav>
                    )}
                  </div>
                )
                : (
                  <p className='text-sm text-ink-muted py-8 text-center'>
                    Select a type to view records.
                  </p>
                )}
            </div>
          </div>
        )}

        {/* Schema tab */}
        {tab === 'schema' && (
          <div className='border border-rule rounded overflow-hidden'>
            <pre className='p-4 text-xs font-mono overflow-x-auto bg-ink text-parchment'>
              <code>{JSON.stringify(version.schemas, null, 2)}</code>
            </pre>
          </div>
        )}

        {/* Files tab */}
        {tab === 'files' && (
          <div>
            {files.length === 0
              ? (
                <p className='text-sm text-ink-muted py-8 text-center'>
                  No files in this version.
                </p>
              )
              : (
                <div>
                  <p className='text-xs text-ink-muted mb-3'>
                    {files.length} file{files.length !== 1 ? 's' : ''} · {formatBytes(
                      files.reduce((sum: number, f: any,) => sum + (f.size ?? 0), 0,),
                    )} total
                  </p>
                  <div className='border border-rule rounded overflow-hidden'>
                    <table className='w-full text-xs'>
                      <thead>
                        <tr className='bg-parchment-dark border-b border-rule'>
                          <th className='text-left p-2.5 font-medium'>File</th>
                          <th className='text-left p-2.5 font-medium'>Referenced by</th>
                          <th className='text-right p-2.5 font-medium'>Size</th>
                          <th className='text-right p-2.5 font-medium'></th>
                        </tr>
                      </thead>
                      <tbody>
                        {files.map((f: any,) => {
                          const refs: any[] = f.references ?? []
                          const isPdf = f.mimeType === 'application/pdf'
                          const isImage = f.mimeType?.startsWith('image/',)
                          return (
                            <tr
                              key={f.hash}
                              className='border-t border-rule hover:bg-parchment-dark/50'
                            >
                              <td className='p-2.5'>
                                <div className='flex items-center gap-2'>
                                  {isPdf
                                    ? (
                                      <svg
                                        className='w-4 h-4 text-red-600 shrink-0'
                                        fill='none'
                                        stroke='currentColor'
                                        viewBox='0 0 24 24'
                                      >
                                        <path
                                          strokeLinecap='round'
                                          strokeLinejoin='round'
                                          strokeWidth={2}
                                          d='M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z'
                                        />
                                      </svg>
                                    )
                                    : isImage
                                    ? (
                                      <svg
                                        className='w-4 h-4 text-blue-600 shrink-0'
                                        fill='none'
                                        stroke='currentColor'
                                        viewBox='0 0 24 24'
                                      >
                                        <path
                                          strokeLinecap='round'
                                          strokeLinejoin='round'
                                          strokeWidth={2}
                                          d='M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z'
                                        />
                                      </svg>
                                    )
                                    : (
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
                                          d='M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z'
                                        />
                                      </svg>
                                    )}
                                  <div>
                                    <code className='font-mono text-[11px] text-ink-muted'>
                                      {f.hash.slice(0, 12,)}…
                                    </code>
                                    <span className='ml-2 text-ink-muted'>{f.mimeType}</span>
                                  </div>
                                </div>
                              </td>
                              <td className='p-2.5'>
                                {refs.length > 0
                                  ? (
                                    <div className='flex flex-wrap gap-1'>
                                      {refs.slice(0, 3,).map((ref: any, idx: number,) => (
                                        <Link
                                          key={idx}
                                          to={`/${owner}/${collection}/v/${n}?type=${ref.type}`}
                                          className='inline-flex items-center gap-1 text-[11px] bg-parchment-dark border border-rule px-1.5 py-0.5 rounded hover:border-ink-muted transition-colors'
                                        >
                                          <span className='text-ink-muted'>{ref.type}</span>
                                          <span className='font-mono'>
                                            {ref.recordId.length > 20
                                              ? ref.recordId.slice(0, 20,) + '…'
                                              : ref.recordId}
                                          </span>
                                        </Link>
                                      ))}
                                      {refs.length > 3 && (
                                        <span className='text-[11px] text-ink-muted px-1.5 py-0.5'>
                                          +{refs.length - 3} more
                                        </span>
                                      )}
                                    </div>
                                  )
                                  : <span className='text-ink-muted'>—</span>}
                              </td>
                              <td className='p-2.5 text-right whitespace-nowrap'>
                                {formatBytes(f.size,)}
                              </td>
                              <td className='p-2.5 text-right'>
                                <a
                                  href={`https://assets.underlay.org/files/${f.hash.slice(0, 2,)}/${
                                    f.hash.slice(2, 4,)
                                  }/${f.hash}`}
                                  target='_blank'
                                  className='text-link hover:underline'
                                >
                                  <svg
                                    className='w-4 h-4 inline'
                                    fill='none'
                                    stroke='currentColor'
                                    viewBox='0 0 24 24'
                                  >
                                    <path
                                      strokeLinecap='round'
                                      strokeLinejoin='round'
                                      strokeWidth={2}
                                      d='M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z'
                                    />
                                  </svg>
                                </a>
                              </td>
                            </tr>
                          )
                        },)}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
          </div>
        )}

        {/* Metadata tab */}
        {tab === 'metadata' && (
          <div className='max-w-2xl'>
            {/* Collection-level metadata */}
            <h3 className='text-xs font-semibold uppercase tracking-wide text-ink-muted mb-3'>
              Collection
            </h3>
            <table className='w-full text-sm mb-8'>
              <tbody>
                {collectionData?.name && (
                  <tr className='border-b border-rule'>
                    <td className='py-3 pr-6 text-ink-muted font-medium w-40'>Name</td>
                    <td className='py-3'>{collectionData.name}</td>
                  </tr>
                )}
                {collectionData?.description && (
                  <tr className='border-b border-rule'>
                    <td className='py-3 pr-6 text-ink-muted font-medium'>Description</td>
                    <td className='py-3'>{collectionData.description}</td>
                  </tr>
                )}
                <tr className='border-b border-rule'>
                  <td className='py-3 pr-6 text-ink-muted font-medium'>Owner</td>
                  <td className='py-3'>
                    <Link to={`/${owner}`} className='text-link hover:underline'>
                      {collectionData?.ownerName ?? owner}
                    </Link>{' '}
                    <span className='text-ink-muted text-xs'>({owner})</span>
                  </td>
                </tr>
                <tr className='border-b border-rule'>
                  <td className='py-3 pr-6 text-ink-muted font-medium'>Visibility</td>
                  <td className='py-3'>{collectionData?.public ? 'Public' : 'Private'}</td>
                </tr>
              </tbody>
            </table>

            {/* Version-level metadata */}
            <h3 className='text-xs font-semibold uppercase tracking-wide text-ink-muted mb-3'>
              Version
            </h3>
            <table className='w-full text-sm mb-8'>
              <tbody>
                <tr className='border-b border-rule'>
                  <td className='py-3 pr-6 text-ink-muted font-medium w-40'>Version</td>
                  <td className='py-3'>
                    {version.number} ({version.semver})
                  </td>
                </tr>
                <tr className='border-b border-rule'>
                  <td className='py-3 pr-6 text-ink-muted font-medium'>Hash</td>
                  <td className='py-3 font-mono text-xs break-all'>sha256:{version.hash}</td>
                </tr>
                <tr className='border-b border-rule'>
                  <td className='py-3 pr-6 text-ink-muted font-medium'>Created</td>
                  <td className='py-3'>
                    {new Date(version.createdAt,).toLocaleDateString('en-US', {
                      year: 'numeric',
                      month: 'long',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    },)}
                  </td>
                </tr>
                {version.baseNumber !== null && version.baseNumber !== undefined && (
                  <tr className='border-b border-rule'>
                    <td className='py-3 pr-6 text-ink-muted font-medium'>Base version</td>
                    <td className='py-3'>
                      <Link
                        to={`/${owner}/${collection}/v/${version.baseNumber}`}
                        className='text-link hover:underline'
                      >
                        v{version.baseNumber}
                      </Link>
                    </td>
                  </tr>
                )}
                {version.message && (
                  <tr className='border-b border-rule'>
                    <td className='py-3 pr-6 text-ink-muted font-medium'>Message</td>
                    <td className='py-3'>{version.message}</td>
                  </tr>
                )}
                <tr className='border-b border-rule'>
                  <td className='py-3 pr-6 text-ink-muted font-medium'>Records</td>
                  <td className='py-3'>{version.recordCount.toLocaleString()}</td>
                </tr>
                <tr className='border-b border-rule'>
                  <td className='py-3 pr-6 text-ink-muted font-medium'>Files</td>
                  <td className='py-3'>{version.fileCount.toLocaleString()}</td>
                </tr>
                <tr className='border-b border-rule'>
                  <td className='py-3 pr-6 text-ink-muted font-medium'>Total size</td>
                  <td className='py-3'>{formatBytes(version.totalBytes,)}</td>
                </tr>
                <tr className='border-b border-rule'>
                  <td className='py-3 pr-6 text-ink-muted font-medium'>Types</td>
                  <td className='py-3'>{allTypes.join(', ',) || '—'}</td>
                </tr>
              </tbody>
            </table>

            {/* Provenance */}
            <h3 className='text-xs font-semibold uppercase tracking-wide text-ink-muted mb-3'>
              Provenance
            </h3>
            <table className='w-full text-sm mb-8'>
              <tbody>
                {version.appId && (
                  <tr className='border-b border-rule'>
                    <td className='py-3 pr-6 text-ink-muted font-medium w-40'>App ID</td>
                    <td className='py-3 font-mono text-xs'>{version.appId}</td>
                  </tr>
                )}
                {version.actorId && (
                  <tr className='border-b border-rule'>
                    <td className='py-3 pr-6 text-ink-muted font-medium'>Actor ID</td>
                    <td className='py-3 font-mono text-xs'>{version.actorId}</td>
                  </tr>
                )}
                {version.pushedBy && (
                  <tr className='border-b border-rule'>
                    <td className='py-3 pr-6 text-ink-muted font-medium'>Pushed by</td>
                    <td className='py-3 font-mono text-xs'>{version.pushedBy}</td>
                  </tr>
                )}
                {version.signature && (
                  <tr className='border-b border-rule'>
                    <td className='py-3 pr-6 text-ink-muted font-medium'>Signature</td>
                    <td className='py-3 font-mono text-xs break-all'>{version.signature}</td>
                  </tr>
                )}
              </tbody>
            </table>

            {/* README */}
            {version.readme && readmeHtml && (
              <div>
                <h3 className='text-xs font-semibold uppercase tracking-wide text-ink-muted mb-3'>
                  README
                </h3>
                <div
                  className='border border-rule rounded p-5 prose prose-sm max-w-none'
                  dangerouslySetInnerHTML={{ __html: readmeHtml, }}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </BaseLayout>
  )
}
