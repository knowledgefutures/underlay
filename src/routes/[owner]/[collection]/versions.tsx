import { useEffect, useState, } from 'react'
import { Link, useParams, } from 'react-router'
import BaseLayout from '~/components/BaseLayout'
import { useSSRData, } from '~/lib/ssr-data'
import { CollectionNav, formatBytes, } from '.'

export default function CollectionVersionsPage() {
  const { owner, collection, } = useParams()
  const currentUser = useSSRData<any>('currentUser',)

  const [data, setData,] = useState<any>(null,)
  const [versions, setVersions,] = useState<any[]>([],)
  const [isOwner, setIsOwner,] = useState(false,)
  const [loading, setLoading,] = useState(true,)

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
        window.location.href = '/404'
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

      setLoading(false,)
    },)
  }, [owner, collection, currentUser,],)

  if (loading || !data) {
    return (
      <BaseLayout>
        <div className='max-w-5xl mx-auto px-4 py-8 text-sm text-ink-muted'>Loading…</div>
      </BaseLayout>
    )
  }

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

        <h2 className='text-sm font-semibold text-ink-muted mb-4'>
          {versions.length} version{versions.length !== 1 ? 's' : ''}
        </h2>

        {versions.length === 0
          ? <p className='text-sm text-ink-muted py-8 text-center'>No versions yet.</p>
          : (
            <div className='border border-rule rounded overflow-hidden'>
              {versions.map((v: any, i: number,) => (
                <div
                  key={v.number}
                  className={`flex items-center justify-between px-4 py-3 hover:bg-parchment-dark/50 transition-colors ${
                    i < versions.length - 1 ? 'border-b border-rule' : ''
                  }`}
                >
                  <Link
                    to={`/${owner}/${collection}/v/${v.number}`}
                    className='flex items-center gap-4 min-w-0'
                  >
                    <div className='flex items-center gap-2'>
                      <span className='font-mono text-xs bg-parchment-dark border border-rule px-1.5 py-0.5 rounded'>
                        v{v.number}
                      </span>
                      <span className='text-sm font-medium'>{v.semver}</span>
                    </div>
                    {v.message && <span className='text-xs text-ink-muted truncate'>{v.message}</span>}
                  </Link>
                  <div className='flex items-center gap-5 text-xs text-ink-muted shrink-0 ml-4'>
                    <span>{v.recordCount.toLocaleString()} records</span>
                    <span>{v.fileCount.toLocaleString()} files</span>
                    <span>{formatBytes(v.totalBytes,)}</span>
                    <span className='w-20 text-right'>
                      {new Date(v.createdAt,).toLocaleDateString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                      },)}
                    </span>
                    <code
                      className='font-mono text-[11px] text-ink-muted w-24 text-right'
                      title={`sha256:${v.hash}`}
                    >
                      {v.hash.slice(0, 10,)}…
                    </code>
                    {v.ark && (
                      <Link
                        to={new URL(v.ark,).pathname}
                        className='font-mono text-[11px] text-link hover:underline'
                      >
                        ark
                      </Link>
                    )}
                    {v.number > 1
                      ? (
                        <Link
                          to={`/${owner}/${collection}/diff?from=${v.number - 1}&to=${v.number}`}
                          className='text-link hover:underline w-8 text-right'
                          title={`Diff v${v.number - 1} → v${v.number}`}
                        >
                          diff
                        </Link>
                      )
                      : <span className='w-8'></span>}
                  </div>
                </div>
              ))}
            </div>
          )}
      </div>
    </BaseLayout>
  )
}
