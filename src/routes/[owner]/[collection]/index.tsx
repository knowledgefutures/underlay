import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'

import BaseLayout from '~/components/BaseLayout'
import { NotFoundError } from '~/components/NotFound'
import { useAppContext } from '~/lib/app-context'

function CollectionNav({
  owner,
  collection,
  isPublic,
  isOwner = false,
  active,
  versionLabel,
}: {
  owner: string
  collection: string
  isPublic?: boolean
  isOwner?: boolean
  active: 'overview' | 'versions' | 'schemas' | 'settings'
  versionLabel?: string
}) {
  const linkClass = 'px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors'
  const activeClass = `${linkClass} border-ink text-ink`
  const inactiveClass = `${linkClass} border-transparent text-ink-muted hover:text-ink hover:border-rule`

  return (
    <>
      <div className="mb-2 flex items-center justify-between">
        <nav className="flex items-center gap-1.5 text-lg">
          <Link to={`/${owner}`} className="text-link hover:underline">
            {owner}
          </Link>
          <span className="text-ink-muted">/</span>
          <Link to={`/${owner}/${collection}`} className="font-semibold hover:underline">
            {collection}
          </Link>
          {isPublic !== undefined && (
            <span className="border-rule text-ink-muted ml-2 border px-1.5 py-0.5 text-xs">
              {isPublic ? 'public' : 'private'}
            </span>
          )}
        </nav>
      </div>
      <div className="border-rule mb-6 flex items-center gap-0 border-b">
        <Link
          to={`/${owner}/${collection}`}
          className={active === 'overview' ? activeClass : inactiveClass}
        >
          Overview
        </Link>
        <Link
          to={`/${owner}/${collection}/versions`}
          className={active === 'versions' && !versionLabel ? activeClass : inactiveClass}
        >
          Versions
        </Link>
        {versionLabel && <span className={activeClass}>{versionLabel}</span>}
        <Link
          to={`/${owner}/${collection}/schemas`}
          className={active === 'schemas' ? activeClass : inactiveClass}
        >
          Schemas
        </Link>
        {isOwner && (
          <Link
            to={`/${owner}/${collection}/settings`}
            className={`${active === 'settings' ? activeClass : inactiveClass} ml-auto`}
          >
            Settings
          </Link>
        )}
      </div>
    </>
  )
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1)
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

export const handle = {
  title: (params: Record<string, string>) => params.owner + '/' + params.collection + ' — Underlay',
}

export default function CollectionPage() {
  const { owner, collection } = useParams()
  const { currentUser, mirrorConfig } = useAppContext()

  const [data, setData] = useState<any>(null)
  const [totalVersions, setTotalVersions] = useState(0)
  const [isOwner, setIsOwner] = useState(false)
  const [readmeHtml, setReadmeHtml] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!owner || !collection) return

    fetch(`/api/collections/${owner}/${collection}`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((col) => {
        if (!col) {
          setLoading(false)
          return
        }
        setData(col)
        setTotalVersions(col.latestVersion?.number ?? 0)

        // Render readme
        const readmeSource = col.latestVersion?.readme || col.latestVersion?.message || null
        if (readmeSource) {
          import('marked').then(({ marked }) => {
            setReadmeHtml(marked.parse(readmeSource) as string)
          })
        }

        // Check ownership
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

  const typeCounts: { type: string; count: number }[] = data.latestVersion?.typeCounts ?? []
  const allTypes = typeCounts.sort((a: any, b: any) => a.type.localeCompare(b.type))
  const collectionArkPath: string | null = data.ark ? new URL(data.ark).pathname : null

  return (
    <BaseLayout>
      <div className="mx-auto max-w-5xl px-4 py-8">
        <CollectionNav
          owner={owner!}
          collection={collection!}
          isPublic={data.public}
          isOwner={isOwner}
          active="overview"
        />

        {mirrorConfig?.enabled && (
          <div className="text-ink-muted bg-parchment-dark border-rule mb-4 flex items-center gap-2 rounded border px-3 py-2 text-xs">
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"
              />
            </svg>
            <span>
              Mirrored from{' '}
              <Link
                to={`${mirrorConfig.upstream}/${owner}/${collection}`}
                className="hover:text-ink underline"
              >
                {mirrorConfig.upstream.replace(/^https?:\/\//, '')}
              </Link>
            </span>
          </div>
        )}

        {/* Two-column layout */}
        <div className="grid grid-cols-[1fr_260px] gap-8">
          {/* Main column */}
          <div className="min-w-0">
            {/* Latest version bar */}
            {data.latestVersion && (
              <div className="border-rule bg-parchment-dark mb-6 flex items-center justify-between rounded border px-4 py-2.5">
                <div className="flex items-center gap-3 text-sm">
                  <Link
                    to={`/${owner}/${collection}/v/${data.latestVersion.number}`}
                    className="text-link font-medium hover:underline"
                  >
                    {data.latestVersion.semver}
                  </Link>
                  <span className="text-ink-muted">·</span>
                  <span className="text-ink-muted">
                    {data.latestVersion.recordCount.toLocaleString()} records
                  </span>
                  <span className="text-ink-muted">·</span>
                  <span className="text-ink-muted">
                    {data.latestVersion.fileCount.toLocaleString()} files
                  </span>
                  <span className="text-ink-muted">·</span>
                  <span className="text-ink-muted">
                    {formatBytes(data.latestVersion.totalBytes)}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-ink-muted text-xs">
                    {new Date(data.latestVersion.createdAt).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </span>
                  <Link
                    to={`/${owner}/${collection}/versions`}
                    className="text-ink-muted hover:text-ink flex items-center gap-1 text-xs transition-colors"
                    title="Version history"
                  >
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                      />
                    </svg>
                    <span>{totalVersions}</span>
                  </Link>
                </div>
              </div>
            )}

            {/* Type TOC */}
            {allTypes.length > 0 && (
              <div className="border-rule mb-6 overflow-hidden rounded border">
                {allTypes.map((t: any, i: number) => (
                  <Link
                    key={t.type}
                    to={`/${owner}/${collection}/v/${data.latestVersion.number}?type=${t.type}`}
                    className={`hover:bg-parchment-dark/50 flex items-center justify-between px-4 py-2.5 text-sm transition-colors ${
                      i < allTypes.length - 1 ? 'border-rule border-b' : ''
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
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
                      <span className="font-medium">{t.type}</span>
                    </div>
                    <span className="text-ink-muted text-xs">
                      {t.count.toLocaleString()} records
                    </span>
                  </Link>
                ))}
              </div>
            )}

            {/* README */}
            {readmeHtml ? (
              <div className="border-rule mb-6 overflow-hidden rounded border">
                <div className="bg-parchment-dark border-rule text-ink-muted border-b px-4 py-2.5 text-xs font-medium">
                  README
                </div>
                <div
                  className="prose prose-sm max-w-none px-6 py-5"
                  dangerouslySetInnerHTML={{ __html: readmeHtml }}
                />
              </div>
            ) : (
              <div className="border-rule text-ink-muted mb-6 rounded border px-4 py-8 text-center text-sm">
                No README yet.
              </div>
            )}
          </div>

          {/* Sidebar */}
          <aside className="text-sm">
            {/* About */}
            <div className="mb-6">
              <h3 className="text-ink-muted mb-2 text-xs font-semibold tracking-wide uppercase">
                About
              </h3>
              <p className="text-ink text-sm leading-relaxed">
                {data.description || 'No description.'}
              </p>
              <div className="text-ink-muted mt-2 text-xs">
                by{' '}
                <Link to={`/${data.ownerSlug}`} className="text-link hover:underline">
                  {data.ownerName}
                </Link>
              </div>
            </div>

            {/* Stats */}
            {data.latestVersion && (
              <div className="mb-6">
                <h3 className="text-ink-muted mb-2 text-xs font-semibold tracking-wide uppercase">
                  Stats
                </h3>
                <div className="space-y-1.5 text-xs">
                  <div className="flex items-center gap-2">
                    <svg
                      className="text-ink-muted h-3.5 w-3.5"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                      />
                    </svg>
                    <span>
                      <strong className="text-ink">{totalVersions}</strong> versions
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <svg
                      className="text-ink-muted h-3.5 w-3.5"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M4 7v10c0 2 1 3 3 3h10c2 0 3-1 3-3V9c0-2-1-3-3-3h-4l-2-2H7c-2 0-3 1-3 3z"
                      />
                    </svg>
                    <span>
                      <strong className="text-ink">
                        {data.latestVersion.recordCount.toLocaleString()}
                      </strong>{' '}
                      records
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <svg
                      className="text-ink-muted h-3.5 w-3.5"
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
                    <span>
                      <strong className="text-ink">
                        {data.latestVersion.fileCount.toLocaleString()}
                      </strong>{' '}
                      files
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <svg
                      className="text-ink-muted h-3.5 w-3.5"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M4 7v10c0 2 1 3 3 3h10c2 0 3-1 3-3V9c0-2-1-3-3-3h-4l-2-2H7c-2 0-3 1-3 3z"
                      />
                    </svg>
                    <span>
                      <strong className="text-ink">
                        {formatBytes(data.latestVersion.totalBytes)}
                      </strong>{' '}
                      total
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* Subscribe / Export */}
            <div className="mb-6">
              <h3 className="text-ink-muted mb-2 text-xs font-semibold tracking-wide uppercase">
                Subscribe
              </h3>
              <div className="space-y-2 text-xs">
                <div>
                  <p className="mb-0.5 font-medium">AT Protocol</p>
                  <code className="text-ink-muted bg-parchment-dark block rounded px-2 py-1 text-[11px] break-all">
                    {`at://did:web:underlay.org:${owner}/org.underlay.collection.${collection}`}
                  </code>
                </div>
                <div>
                  <p className="mb-0.5 font-medium">API</p>
                  <code className="text-ink-muted bg-parchment-dark block rounded px-2 py-1 text-[11px] break-all">
                    {`GET /api/collections/${owner}/${collection}/versions`}
                  </code>
                </div>
                {data.latestVersion && (
                  <Link
                    to={`/api/collections/${owner}/${collection}/export`}
                    className="text-link inline-block hover:underline"
                  >
                    Download .tar.gz
                  </Link>
                )}
              </div>
            </div>

            {/* ARK */}
            {collectionArkPath && (
              <div className="mb-6">
                <h3 className="text-ink-muted mb-2 text-xs font-semibold tracking-wide uppercase">
                  ARK Identifier
                </h3>
                <Link
                  to={collectionArkPath}
                  className="text-link bg-parchment-dark block rounded px-2 py-1 font-mono text-[11px] break-all hover:underline"
                >
                  {collectionArkPath.slice(1)}
                </Link>
              </div>
            )}
          </aside>
        </div>
      </div>
    </BaseLayout>
  )
}

export { CollectionNav, formatBytes }
