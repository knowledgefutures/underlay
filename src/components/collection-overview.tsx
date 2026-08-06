import DOMPurify from 'isomorphic-dompurify'
import { marked } from 'marked'
import { useMemo } from 'react'
import { Link } from 'react-router'

import { bareSemver, formatBytes } from '~/lib/format'
import { TokenLink } from '~/lib/share-token'

/**
 * The one collection overview layout, shared by the latest page
 * (/:owner/:collection) and pinned versions (/:owner/:collection/v/:n).
 * Everything version-scoped (counts, types, README, description, tags) comes
 * from the `version` being shown; collection-wide blocks (subscribe, share,
 * collection ARK, version count) come from `data`.
 */

function normalizeTypeCounts(tc: unknown): { type: string; count: number }[] {
  if (!tc) return []
  const list = Array.isArray(tc)
    ? (tc as { type: string; count: number }[])
    : Object.entries(tc as Record<string, number>).map(([type, count]) => ({ type, count }))
  return [...list].sort((a, b) => a.type.localeCompare(b.type))
}

export default function CollectionOverviewBody({
  owner,
  collection,
  data,
  version,
  isLatest,
  /** Rendered SharePanel (owner-only), passed in to keep it beside its API calls. */
  share,
}: {
  owner: string
  collection: string
  data: any
  version: any | null
  isLatest: boolean
  share?: React.ReactNode
}) {
  const readmeHtml = useMemo(() => {
    const meta = version?.metadata as Record<string, unknown> | null | undefined
    const source = (meta?.readme as string) || version?.message || null
    return source ? DOMPurify.sanitize(marked.parse(source) as string) : null
  }, [version])

  const base = `/${owner}/${collection}`
  const recordsPath = isLatest
    ? `${base}/records`
    : `${base}/v/${bareSemver(version?.semver ?? '')}/records`

  const totalVersions = data.versionCount ?? 0
  const allTypes = normalizeTypeCounts(version?.typeCounts)
  const collectionArkPath: string | null = data.ark ? new URL(data.ark).pathname : null
  const versionArkPath: string | null = version?.ark ? new URL(version.ark).pathname : null

  const meta = version?.metadata as Record<string, unknown> | null | undefined
  const description = (meta?.description as string) || data.description
  const tags = Array.isArray(meta?.tags) ? (meta.tags as string[]) : []

  return (
    <div className="grid grid-cols-[1fr_260px] gap-8">
      {/* Main column */}
      <div className="min-w-0">
        {/* Version bar */}
        {version && (
          <div className="border-rule bg-parchment-dark rounded-surface mb-6 flex items-center justify-between border px-4 py-2.5">
            <div className="flex items-center gap-3 text-sm">
              <TokenLink
                to={`${base}/v/${bareSemver(version.semver)}`}
                className="text-link font-medium hover:underline"
              >
                {version.semver}
              </TokenLink>
              {isLatest && <span className="text-ink-muted text-xs">latest</span>}
              <span className="text-ink-muted">·</span>
              <span className="text-ink-muted">{version.recordCount.toLocaleString()} records</span>
              <span className="text-ink-muted">·</span>
              <span className="text-ink-muted">{version.fileCount.toLocaleString()} files</span>
              <span className="text-ink-muted">·</span>
              <span className="text-ink-muted">{formatBytes(version.totalBytes)}</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-ink-muted text-xs">
                {new Date(version.createdAt).toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                  timeZone: 'UTC',
                })}
              </span>
              <TokenLink
                to={`${base}/versions`}
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
              </TokenLink>
            </div>
          </div>
        )}

        {/* Type TOC */}
        {allTypes.length > 0 && (
          <div className="border-rule rounded-surface mb-6 overflow-hidden border">
            {allTypes.map((t, i) => (
              <TokenLink
                key={t.type}
                to={`${recordsPath}?type=${t.type}`}
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
                <span className="text-ink-muted text-xs">{t.count.toLocaleString()} records</span>
              </TokenLink>
            ))}
          </div>
        )}

        {/* README */}
        {readmeHtml ? (
          <div className="border-rule rounded-surface mb-6 overflow-hidden border">
            <div className="bg-parchment-dark border-rule text-ink-muted border-b px-4 py-2.5 text-xs font-medium">
              README
            </div>
            <div
              className="prose prose-sm max-w-none px-6 py-5"
              dangerouslySetInnerHTML={{ __html: readmeHtml }}
            />
          </div>
        ) : (
          <div className="border-rule text-ink-muted rounded-surface mb-6 border px-4 py-8 text-center text-sm">
            {isLatest ? 'No README yet.' : 'No README in this version.'}
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
          <p className="text-ink text-sm leading-relaxed">{description || 'No description.'}</p>
          <div className="text-ink-muted mt-2 text-xs">
            by{' '}
            <Link to={`/${data.ownerSlug}`} className="text-link hover:underline">
              {data.ownerName}
            </Link>
          </div>
          {tags.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {tags.map((tag: string) => (
                <Link
                  key={tag}
                  to={`/explore?tag=${encodeURIComponent(tag)}`}
                  className="bg-parchment-dark text-ink-muted hover:text-ink rounded-control px-2 py-0.5 text-xs transition-colors"
                >
                  {tag}
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* Stats */}
        {version && (
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
                  <strong className="text-ink">{version.recordCount.toLocaleString()}</strong>{' '}
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
                  <strong className="text-ink">{version.fileCount.toLocaleString()}</strong> files
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
                  <strong className="text-ink">{formatBytes(version.totalBytes)}</strong> total
                </span>
              </div>
            </div>
          </div>
        )}

        {/* This version: message, provenance, integrity */}
        {version && (
          <div className="mb-6">
            <h3 className="text-ink-muted mb-2 text-xs font-semibold tracking-wide uppercase">
              This version
            </h3>
            <dl className="space-y-2 text-xs">
              {version.message && (
                <div>
                  <dt className="text-ink-muted">Message</dt>
                  <dd className="text-ink">{version.message}</dd>
                </div>
              )}
              {version.baseSemver && (
                <div>
                  <dt className="text-ink-muted">Base version</dt>
                  <dd>
                    <TokenLink
                      to={`${base}/v/${bareSemver(version.baseSemver)}`}
                      className="text-link font-mono hover:underline"
                    >
                      {version.baseSemver}
                    </TokenLink>
                  </dd>
                </div>
              )}
              {(version.appId || version.pushedBy) && (
                <div>
                  <dt className="text-ink-muted">Pushed</dt>
                  <dd className="text-ink font-mono text-[11px]">
                    {[version.appId, version.pushedBy].filter(Boolean).join(' · ')}
                  </dd>
                </div>
              )}
              <div>
                <dt className="text-ink-muted">Hash</dt>
                <dd>
                  <code
                    className="text-ink-muted bg-parchment-dark rounded-control block px-2 py-1 font-mono text-[11px] break-all"
                    title={`sha256:${version.hash}`}
                  >
                    sha256:{version.hash.slice(0, 24)}…
                  </code>
                </dd>
              </div>
              {versionArkPath && (
                <div>
                  <dt className="text-ink-muted">ARK</dt>
                  <dd>
                    <Link
                      to={versionArkPath}
                      className="text-link bg-parchment-dark rounded-control block px-2 py-1 font-mono text-[11px] break-all hover:underline"
                    >
                      {versionArkPath.slice(1)}
                    </Link>
                  </dd>
                </div>
              )}
            </dl>
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
              <code className="text-ink-muted bg-parchment-dark rounded-control block px-2 py-1 text-[11px] break-all">
                {`at://did:web:underlay.org:${owner}/org.underlay.collection.${collection}`}
              </code>
            </div>
            <div>
              <p className="mb-0.5 font-medium">API</p>
              <code className="text-ink-muted bg-parchment-dark rounded-control block px-2 py-1 text-[11px] break-all">
                {`GET /api/collections/${owner}/${collection}/versions`}
              </code>
            </div>
            {version && (
              <TokenLink
                to={`/api/collections/${owner}/${collection}/export`}
                className="text-link inline-block hover:underline"
                reloadDocument
              >
                Download .tar.gz
              </TokenLink>
            )}
          </div>
        </div>

        {/* Share (owner only, passed in) */}
        {share}

        {/* Collection ARK */}
        {collectionArkPath && (
          <div className="mb-6">
            <h3 className="text-ink-muted mb-2 text-xs font-semibold tracking-wide uppercase">
              ARK Identifier
            </h3>
            <Link
              to={collectionArkPath}
              className="text-link bg-parchment-dark rounded-control block px-2 py-1 font-mono text-[11px] break-all hover:underline"
            >
              {collectionArkPath.slice(1)}
            </Link>
          </div>
        )}
      </aside>
    </div>
  )
}
