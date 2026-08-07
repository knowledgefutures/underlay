import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useLoaderData, useParams, useSearchParams } from 'react-router'

import BaseLayout from '~/components/BaseLayout'
import CollectionOverviewBody from '~/components/collection-overview'
import { Badge, Button } from '~/components/ui'
import { useAppContext } from '~/lib/app-context'
import { authClient } from '~/lib/auth-client'
import { bareSemver } from '~/lib/format'
import { TokenLink, useShareToken, withToken } from '~/lib/share-token'
import { useDismissable } from '~/lib/use-dismissable'
import { useIsOwner } from '~/lib/use-is-owner'

/**
 * Dropdown for switching between versions of a collection while staying on
 * the same kind of page. Fetches the version list lazily on first open.
 */
function VersionPicker({
  owner,
  collection,
  current,
  isLatest = false,
  to,
}: {
  owner: string
  collection: string
  current: string
  isLatest?: boolean
  /** Build the target URL for a version, preserving the current view. */
  to: (semver: string, targetIsLatest: boolean) => string
}) {
  const [open, setOpen] = useState(false)
  const [versions, setVersions] = useState<any[] | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const shareToken = useShareToken()

  useDismissable(
    open,
    useCallback(() => setOpen(false), []),
    ref,
  )

  useEffect(() => {
    if (!open || versions !== null) return
    fetch(withToken(`/api/collections/${owner}/${collection}/versions?limit=20`, shareToken), {
      credentials: 'include',
    })
      .then((r) => (r.ok ? r.json() : []))
      .then((body) => setVersions(Array.isArray(body) ? body : (body?.versions ?? [])))
  }, [open, versions, owner, collection, shareToken])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="border-rule bg-parchment-dark hover:bg-rule/30 rounded-control cursor-pointer border px-2 py-0.5 font-mono text-xs transition-colors"
        title="Switch version"
      >
        {current}
        {isLatest && <span className="text-ink-muted font-sans"> · latest</span>}{' '}
        <span className="text-ink-muted">▾</span>
      </button>
      {open && (
        <div className="bg-parchment border-rule rounded-control absolute top-full right-0 z-50 mt-1.5 max-h-72 min-w-[11rem] overflow-y-auto border shadow-sm">
          {versions === null ? (
            <p className="text-ink-muted px-3 py-2 text-xs">Loading…</p>
          ) : (
            <>
              {versions.map((v: any, i: number) => (
                <TokenLink
                  key={v.semver}
                  to={to(v.semver, i === 0)}
                  onClick={() => setOpen(false)}
                  className={`hover:bg-parchment-dark block px-3 py-1.5 font-mono text-xs transition-colors ${
                    v.semver === current ? 'text-ink font-semibold' : 'text-ink-light'
                  }`}
                >
                  {v.semver}
                  {i === 0 && <span className="text-ink-muted ml-1.5 font-sans">latest</span>}
                  {v.semver === current && <span className="text-ink-muted ml-1.5">✓</span>}
                </TokenLink>
              ))}
              <TokenLink
                to={`/${owner}/${collection}/versions`}
                onClick={() => setOpen(false)}
                className="text-link border-rule hover:bg-parchment-dark block border-t px-3 py-1.5 text-xs transition-colors"
              >
                All versions →
              </TokenLink>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Collection header, two rows:
 * - Top row is collection-wide: breadcrumb, visibility, Settings.
 * - Tab row is content: Overview / Records / Schemas / Files / Versions, with
 *   the version picker on its right edge scoping the version-aware tabs
 *   (Overview, Records, Schemas, Files). Versions is the full history.
 */
function CollectionNav({
  owner,
  collection,
  isPublic,
  isOwner = false,
  active,
  version,
  isLatest = true,
}: {
  owner: string
  collection: string
  isPublic?: boolean
  isOwner?: boolean
  active: 'overview' | 'records' | 'schemas' | 'files' | 'versions'
  /** The version currently in context (defaults to latest). Absent on empty collections. */
  version?: string
  /** Whether the version in context is the latest ready version. */
  isLatest?: boolean
}) {
  const linkClass = 'px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors'
  const activeClass = `${linkClass} border-ink text-ink`
  const inactiveClass = `${linkClass} border-transparent text-ink-muted hover:text-ink hover:border-rule`
  const shareToken = useShareToken()
  const [searchParams] = useSearchParams()

  // Version is a path prefix; views are path segments; latest is the default
  // when the prefix is absent. /acme/pubs/records vs /acme/pubs/v/1.0.0/records.
  const base = `/${owner}/${collection}`
  const prefix = isLatest || !version ? base : `${base}/v/${bareSemver(version)}`

  // Switching versions keeps you on the view you're looking at.
  function versionTo(semver: string, targetIsLatest: boolean): string {
    const target = targetIsLatest ? base : `${base}/v/${bareSemver(semver)}`
    switch (active) {
      case 'records': {
        const type = searchParams.get('type')
        return `${target}/records${type ? `?type=${encodeURIComponent(type)}` : ''}`
      }
      case 'schemas':
        return `${target}/schemas`
      case 'files':
        return `${target}/files`
      default:
        // overview, or a collection-level page like /versions
        return target
    }
  }

  return (
    <>
      <div className="mb-2 flex items-center justify-between gap-3">
        <nav className="flex min-w-0 items-center gap-1.5 text-lg">
          <Link to={`/${owner}`} className="text-link hover:underline">
            {owner}
          </Link>
          <span className="text-ink-muted">/</span>
          <TokenLink to={base} className="min-w-0 truncate font-semibold hover:underline">
            {collection}
          </TokenLink>
          {isPublic !== undefined && (
            <Badge className="ml-2">{isPublic ? 'public' : 'private'}</Badge>
          )}
          {shareToken && !isOwner && (
            <Badge
              className="bg-parchment-dark"
              title="You are viewing this collection through a read-only shared link"
            >
              shared link
            </Badge>
          )}
        </nav>
        <div className="flex shrink-0 items-center gap-4 text-sm">
          <TokenLink
            to={`${base}/versions`}
            className={
              active === 'versions'
                ? 'text-ink font-medium'
                : 'text-ink-muted hover:text-ink transition-colors'
            }
          >
            Versions
          </TokenLink>
          {isOwner && (
            <Link
              to={`${base}/settings`}
              className="text-ink-muted hover:text-ink transition-colors"
            >
              Settings
            </Link>
          )}
        </div>
      </div>
      <div className="border-rule mb-6 flex items-center gap-0 overflow-x-auto border-b">
        <TokenLink to={prefix} className={active === 'overview' ? activeClass : inactiveClass}>
          Overview
        </TokenLink>
        {version && (
          <TokenLink
            to={`${prefix}/records`}
            className={active === 'records' ? activeClass : inactiveClass}
          >
            Records
          </TokenLink>
        )}
        <TokenLink
          to={`${prefix}/schemas`}
          className={active === 'schemas' ? activeClass : inactiveClass}
        >
          Schemas
        </TokenLink>
        {version && (
          <TokenLink
            to={`${prefix}/files`}
            className={active === 'files' ? activeClass : inactiveClass}
          >
            Files
          </TokenLink>
        )}
        {version && (
          <div className="mb-1.5 ml-auto">
            <VersionPicker
              owner={owner}
              collection={collection}
              current={version}
              isLatest={isLatest}
              to={versionTo}
            />
          </div>
        )}
      </div>
    </>
  )
}

export default function CollectionPage() {
  const { owner, collection } = useParams()
  const { mirrorConfig } = useAppContext()
  const data = useLoaderData() as any

  const isOwner = useIsOwner(owner)

  return (
    <BaseLayout>
      <div className="mx-auto max-w-5xl px-4 py-8">
        <CollectionNav
          owner={owner!}
          collection={collection!}
          isPublic={data.public}
          isOwner={isOwner}
          active="overview"
          version={data.latestVersion?.semver}
          isLatest
        />

        {mirrorConfig?.enabled && (
          <div className="text-ink-muted bg-parchment-dark border-rule rounded-surface mb-4 flex items-center gap-2 border px-3 py-2 text-xs">
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
          <div className="border-rule rounded-surface mb-6 border px-6 py-10 text-center">
            <h2 className="mb-2 text-base font-semibold">Get started with {collection}</h2>
            <p className="text-ink-muted mx-auto mb-6 max-w-md text-sm leading-relaxed">
              This collection is empty. Push your first version using the CLI or API.
            </p>
            <div className="bg-ink text-parchment rounded-surface mx-auto max-w-md overflow-hidden text-left font-mono text-[13px] leading-relaxed">
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
                <code className="bg-parchment-dark rounded-control px-1.5 py-0.5 text-[11px]">
                  POST /api/collections/{owner}/{collection}/versions/negotiate
                </code>
              </span>
            </div>
          </div>
        )}

        <CollectionOverviewBody
          owner={owner!}
          collection={collection!}
          data={data}
          version={data.latestVersion}
          isLatest
          share={
            isOwner ? (
              <SharePanel
                owner={owner!}
                collection={collection!}
                collectionId={data.id}
                isPublic={!!data.public}
              />
            ) : undefined
          }
        />
      </div>
    </BaseLayout>
  )
}

const VIEW_LINK_EXPIRES_SECONDS = 30 * 24 * 3600

function SharePanel({
  owner,
  collection,
  collectionId,
  isPublic,
}: {
  owner: string
  collection: string
  collectionId: string
  isPublic: boolean
}) {
  const [modal, setModal] = useState<'view' | 'agent' | null>(null)
  const [viewUrl, setViewUrl] = useState<string | null>(null)
  const [agentUrl, setAgentUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState<'view' | 'agent' | null>(null)
  const [copied, setCopied] = useState<'link' | 'blurb' | null>(null)

  // Escape closes the share dialogs (backdrop click already does).
  useEffect(() => {
    if (!modal) return
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setModal(null)
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [modal])

  const generateView = useCallback(async () => {
    setLoading('view')
    setCopied(null)
    try {
      const { data: keyData } = await authClient.apiKey.create({
        name: `share-${collection}`,
        metadata: {
          scope: 'read',
          collectionIds: [collectionId],
          linkShare: true,
        },
        expiresIn: VIEW_LINK_EXPIRES_SECONDS,
        prefix: 'ul',
      } as any)
      if (keyData) {
        setViewUrl(
          withToken(`${window.location.origin}/${owner}/${collection}`, (keyData as any).key),
        )
        setModal('view')
      }
    } finally {
      setLoading(null)
    }
  }, [owner, collection, collectionId])

  const generateAgent = useCallback(async () => {
    setLoading('agent')
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
        setAgentUrl(`${window.location.origin}/agent/${(keyData as any).key}`)
        setModal('agent')
      }
    } finally {
      setLoading(null)
    }
  }, [collection, collectionId])

  const copy = useCallback((text: string, which: 'link' | 'blurb') => {
    navigator.clipboard.writeText(text)
    setCopied(which)
    setTimeout(() => setCopied(null), 2000)
  }, [])

  const agentBlurb = agentUrl
    ? `Will you create an update that captures this conversation. Here is a link with reference how to do that: ${agentUrl}`
    : ''

  return (
    <>
      <div className="mb-6">
        <h3 className="text-ink-muted mb-2 text-xs font-semibold tracking-wide uppercase">Share</h3>

        <div className="mb-3">
          <p className="text-ink-muted mb-1.5 text-xs leading-relaxed">
            {isPublic
              ? 'This collection is public — anyone with its URL can view it.'
              : 'Create a read-only link that lets anyone view this collection without signing in or becoming a member.'}
          </p>
          {isPublic ? (
            <Button
              variant="link"
              size="sm"
              className="font-medium"
              onClick={() => copy(`${window.location.origin}/${owner}/${collection}`, 'link')}
            >
              {copied === 'link' && modal === null ? 'Copied!' : 'Copy collection URL'}
            </Button>
          ) : (
            <Button
              variant="link"
              size="sm"
              className="font-medium"
              onClick={generateView}
              disabled={loading !== null}
            >
              {loading === 'view' ? 'Generating...' : 'Create view link →'}
            </Button>
          )}
        </div>

        <div>
          <p className="text-ink-muted mb-1.5 text-xs leading-relaxed">
            Or generate a temporary link that lets an AI agent push updates to this collection.
          </p>
          <Button
            variant="link"
            size="sm"
            className="font-medium"
            onClick={generateAgent}
            disabled={loading !== null}
          >
            {loading === 'agent' ? 'Generating...' : 'Generate agent link →'}
          </Button>
        </div>
      </div>

      {modal === 'view' && viewUrl && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={(e) => {
            if (e.target === e.currentTarget) setModal(null)
          }}
        >
          <div className="bg-parchment border-rule rounded-surface mx-4 w-full max-w-2xl border p-6 shadow-lg">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-semibold">View-only Link</h2>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setModal(null)}
                className="text-ink-muted hover:text-ink cursor-pointer text-lg leading-none"
              >
                &times;
              </button>
            </div>

            <p className="text-ink-muted mb-4 text-xs leading-relaxed">
              Anyone with this link can browse this collection — overview, versions, records,
              schemas, and exports — without signing in. They cannot make changes. The link stays
              attached as they click between pages.
            </p>

            <div className="mb-4">
              <label className="text-ink-muted mb-1 block text-[11px] font-medium tracking-wide uppercase">
                Link
              </label>
              <div className="bg-parchment-dark border-rule rounded-surface border px-3 py-2 font-mono text-[11px] break-all">
                {viewUrl}
              </div>
              <Button size="sm" className="mt-2" onClick={() => copy(viewUrl, 'link')}>
                {copied === 'link' ? 'Copied!' : 'Copy link'}
              </Button>
            </div>

            <div className="flex items-center justify-between">
              <p className="text-ink-muted text-[10px]">
                Expires in 30 days. Revoke it anytime from Settings &rarr; API Keys.
              </p>
              <button
                onClick={() => {
                  setModal(null)
                  generateView()
                }}
                className="text-ink-muted text-xs underline hover:no-underline"
              >
                Regenerate
              </button>
            </div>
          </div>
        </div>
      )}

      {modal === 'agent' && agentUrl && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={(e) => {
            if (e.target === e.currentTarget) setModal(null)
          }}
        >
          <div className="bg-parchment border-rule rounded-surface mx-4 w-full max-w-2xl border p-6 shadow-lg">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Agent Update Link</h2>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setModal(null)}
                className="text-ink-muted hover:text-ink cursor-pointer text-lg leading-none"
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
              <div className="bg-parchment-dark border-rule rounded-surface border px-3 py-2 font-mono text-[11px] break-all">
                {agentUrl}
              </div>
              <Button size="sm" className="mt-2" onClick={() => copy(agentUrl, 'link')}>
                {copied === 'link' ? 'Copied!' : 'Copy link'}
              </Button>
            </div>

            <div className="mb-4">
              <label className="text-ink-muted mb-1 block text-[11px] font-medium tracking-wide uppercase">
                Prompt
              </label>
              <div className="bg-parchment-dark border-rule rounded-surface overflow-hidden border px-3 py-2 text-xs leading-relaxed break-all">
                {agentBlurb}
              </div>
              <Button size="sm" className="mt-2" onClick={() => copy(agentBlurb, 'blurb')}>
                {copied === 'blurb' ? 'Copied!' : 'Copy prompt'}
              </Button>
            </div>

            <div className="flex items-center justify-between">
              <p className="text-ink-muted text-[10px]">Expires in 1 hour.</p>
              <button
                onClick={() => {
                  setModal(null)
                  generateAgent()
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

export { CollectionNav, SharePanel }
export { formatBytes } from '~/lib/format'
