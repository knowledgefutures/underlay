import DOMPurify from 'isomorphic-dompurify'
import { marked } from 'marked'
import { useCallback, useMemo, useState } from 'react'
import { Link, useLoaderData, useParams } from 'react-router'

import BaseLayout from '~/components/BaseLayout'
import { useAppContext } from '~/lib/app-context'
import { authClient } from '~/lib/auth-client'

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

export default function CollectionPage() {
  const { owner, collection } = useParams()
  const { currentUser, mirrorConfig } = useAppContext()
  const data = useLoaderData() as any

  const isOwner = useMemo(
    () =>
      !!currentUser &&
      (currentUser.kfRole === 'admin' ||
        currentUser.slug === owner ||
        currentUser.orgs?.some((o: any) => o.slug === owner)),
    [currentUser, owner],
  )

  const readmeHtml = useMemo(() => {
    const meta = data?.latestVersion?.metadata as Record<string, unknown> | null | undefined
    const source = (meta?.readme as string) || data?.latestVersion?.message || null
    return source ? DOMPurify.sanitize(marked.parse(source) as string) : null
  }, [data])

  const totalVersions = data.versionCount ?? 0
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

        {/* Empty state for new collections */}
        {!data.latestVersion && isOwner && (
          <div className="border-rule mb-6 rounded border px-6 py-10 text-center">
            <h2 className="mb-2 text-base font-semibold">Get started with {collection}</h2>
            <p className="text-ink-muted mx-auto mb-6 max-w-md text-sm leading-relaxed">
              This collection is empty. Push your first version using the CLI or API.
            </p>
            <div className="bg-ink text-parchment mx-auto max-w-md overflow-hidden rounded text-left font-mono text-[13px] leading-relaxed">
              <div className="p-4">
                <div className="text-ink-muted mb-1 text-[11px] select-none">
                  # initialize and push
                </div>
                <div>
                  <span className="text-parchment-dark">$</span> underlay init --remote {owner}/
                  {collection}
                </div>
                <div>
                  <span className="text-parchment-dark">$</span> underlay add --schema ./schema.json
                  ./records.jsonl
                </div>
                <div>
                  <span className="text-parchment-dark">$</span> underlay commit -m &quot;Initial
                  version&quot;
                </div>
                <div>
                  <span className="text-parchment-dark">$</span> underlay push
                </div>
              </div>
            </div>
            <div className="mt-4 flex items-center justify-center gap-4 text-xs">
              <Link to="/docs/quickstart" className="text-link hover:underline">
                Read the quickstart
              </Link>
              <span className="text-rule">&middot;</span>
              <span className="text-ink-muted">
                API:{' '}
                <code className="bg-parchment-dark rounded px-1.5 py-0.5 text-[11px]">
                  POST /api/collections/{owner}/{collection}/versions/negotiate
                </code>
              </span>
            </div>
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
                    to={`/${owner}/${collection}/v/${data.latestVersion.semver}`}
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
                      timeZone: 'UTC',
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
                    to={`/${owner}/${collection}/v/${data.latestVersion.semver}?type=${t.type}`}
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

            {/* Agent Share */}
            {isOwner && <AgentShareSection collection={collection!} collectionId={data.id} />}

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

function AgentShareSection({
  collection,
  collectionId,
}: {
  collection: string
  collectionId: string
}) {
  const [showModal, setShowModal] = useState(false)
  const [agentUrl, setAgentUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState<'link' | 'blurb' | null>(null)

  const generate = useCallback(async () => {
    setLoading(true)
    setCopied(null)
    try {
      const { data: keyData } = await authClient.apiKey.create({
        name: `agent-${collection}`,
        metadata: {
          scope: 'write',
          collectionIds: [collectionId],
          agentShare: true,
        },
        expiresIn: 3600,
        prefix: 'ul',
      } as any)
      if (keyData) {
        const url = `${window.location.origin}/agent/${(keyData as any).key}`
        setAgentUrl(url)
        setShowModal(true)
      }
    } finally {
      setLoading(false)
    }
  }, [collection, collectionId])

  const copyLink = useCallback(() => {
    if (!agentUrl) return
    navigator.clipboard.writeText(agentUrl)
    setCopied('link')
    setTimeout(() => setCopied(null), 2000)
  }, [agentUrl])

  const copyBlurb = useCallback(() => {
    if (!agentUrl) return
    const blurb = `Will you create an update that captures this conversation. Here is a link with reference how to do that: ${agentUrl}`
    navigator.clipboard.writeText(blurb)
    setCopied('blurb')
    setTimeout(() => setCopied(null), 2000)
  }, [agentUrl])

  return (
    <>
      <div className="mb-6">
        <h3 className="text-ink-muted mb-2 text-xs font-semibold tracking-wide uppercase">
          Update via Agent
        </h3>
        <p className="text-ink-muted mb-1.5 text-xs leading-relaxed">
          Generate a temporary link that lets an AI agent push updates to this collection.
        </p>
        <button
          onClick={generate}
          disabled={loading}
          className="text-link text-xs font-medium hover:underline"
        >
          {loading ? 'Generating...' : 'Generate agent link →'}
        </button>
      </div>

      {showModal && agentUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowModal(false)
          }}
        >
          <div className="bg-parchment border-rule mx-4 w-full max-w-2xl rounded border p-6 shadow-lg">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Agent Update Link</h2>
              <button
                onClick={() => setShowModal(false)}
                className="text-ink-muted hover:text-ink text-lg leading-none"
              >
                &times;
              </button>
            </div>

            <p className="text-ink-muted mb-4 text-xs leading-relaxed">
              This link gives an AI agent temporary write access to this collection (expires in 1
              hour). Paste the link or the prompt below into any AI chat. The agent will read the
              page to learn the collection&rsquo;s schema and push protocol, then write structured
              updates back.
            </p>

            <div className="mb-4">
              <label className="text-ink-muted mb-1 block text-[11px] font-medium tracking-wide uppercase">
                Link
              </label>
              <div className="bg-parchment-dark border-rule rounded border px-3 py-2 font-mono text-[11px] break-all">
                {agentUrl}
              </div>
              <button
                onClick={copyLink}
                className="bg-ink text-parchment mt-2 rounded px-3 py-1 text-xs font-medium transition-opacity hover:opacity-90"
              >
                {copied === 'link' ? 'Copied!' : 'Copy link'}
              </button>
            </div>

            <div className="mb-4">
              <label className="text-ink-muted mb-1 block text-[11px] font-medium tracking-wide uppercase">
                Prompt
              </label>
              <div className="bg-parchment-dark border-rule overflow-hidden rounded border px-3 py-2 text-xs leading-relaxed break-all">
                Will you create an update that captures this conversation. Here is a link with
                reference how to do that: {agentUrl}
              </div>
              <button
                onClick={copyBlurb}
                className="bg-ink text-parchment mt-2 rounded px-3 py-1 text-xs font-medium transition-opacity hover:opacity-90"
              >
                {copied === 'blurb' ? 'Copied!' : 'Copy prompt'}
              </button>
            </div>

            <div className="flex items-center justify-between">
              <p className="text-ink-muted text-[10px]">Expires in 1 hour.</p>
              <button
                onClick={() => {
                  setShowModal(false)
                  generate()
                }}
                className="text-ink-muted text-xs underline hover:no-underline"
              >
                Regenerate
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

export { CollectionNav, formatBytes }
