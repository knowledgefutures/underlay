import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'

import BaseLayout from '~/components/BaseLayout'
import { NotFoundError } from '~/components/NotFound'
import { useAppContext } from '~/lib/app-context'

import { CollectionNav, formatBytes } from '.'

export default function CollectionVersionsPage() {
  const { owner, collection } = useParams()
  const { currentUser } = useAppContext()

  const [data, setData] = useState<any>(null)
  const [versions, setVersions] = useState<any[]>([])
  const [isOwner, setIsOwner] = useState(false)
  const [loading, setLoading] = useState(true)

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

      setLoading(false)
    })
  }, [owner, collection, currentUser])

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
          active="versions"
        />

        <h2 className="text-ink-muted mb-4 text-sm font-semibold">
          {versions.length} version{versions.length !== 1 ? 's' : ''}
        </h2>

        {versions.length === 0 ? (
          <p className="text-ink-muted py-8 text-center text-sm">No versions yet.</p>
        ) : (
          <div className="border-rule overflow-hidden rounded border">
            {versions.map((v: any, i: number) => (
              <div
                key={v.number}
                className={`hover:bg-parchment-dark/50 flex items-center justify-between px-4 py-3 transition-colors ${
                  i < versions.length - 1 ? 'border-rule border-b' : ''
                }`}
              >
                <Link
                  to={`/${owner}/${collection}/v/${v.number}`}
                  className="flex min-w-0 items-center gap-4"
                >
                  <div className="flex items-center gap-2">
                    <span className="bg-parchment-dark border-rule rounded border px-1.5 py-0.5 font-mono text-xs">
                      v{v.number}
                    </span>
                    <span className="text-sm font-medium">{v.semver}</span>
                  </div>
                  {v.message && (
                    <span className="text-ink-muted truncate text-xs">{v.message}</span>
                  )}
                </Link>
                <div className="text-ink-muted ml-4 flex shrink-0 items-center gap-5 text-xs">
                  <span>{v.recordCount.toLocaleString()} records</span>
                  <span>{v.fileCount.toLocaleString()} files</span>
                  <span>{formatBytes(v.totalBytes)}</span>
                  <span className="w-20 text-right">
                    {new Date(v.createdAt).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </span>
                  <code
                    className="text-ink-muted w-24 text-right font-mono text-[11px]"
                    title={`sha256:${v.hash}`}
                  >
                    {v.hash.slice(0, 10)}…
                  </code>
                  {v.ark && (
                    <Link
                      to={new URL(v.ark).pathname}
                      className="text-link font-mono text-[11px] hover:underline"
                    >
                      ark
                    </Link>
                  )}
                  {v.number > 1 ? (
                    <Link
                      to={`/${owner}/${collection}/diff?from=${v.number - 1}&to=${v.number}`}
                      className="text-link w-8 text-right hover:underline"
                      title={`Diff v${v.number - 1} → v${v.number}`}
                    >
                      diff
                    </Link>
                  ) : (
                    <span className="w-8"></span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </BaseLayout>
  )
}
