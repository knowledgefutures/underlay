import { useState, useEffect, useRef, type FormEvent } from 'react'
import BaseLayout from '~/components/BaseLayout'
import { useSSRData } from '~/lib/ssr-data'

interface Collection {
  id: string
  slug: string
  name: string
  description?: string
  public: boolean
}

interface Org {
  slug: string
  displayName: string
  role: string
  collections: Collection[]
}

export default function Dashboard() {
  const me = useSSRData<any>('currentUser')
  const [collections, setCollections] = useState<Collection[]>([])
  const [orgs, setOrgs] = useState<Org[]>([])
  const [filter, setFilter] = useState('')
  const [orgSlug, setOrgSlug] = useState('')
  const [orgDisplayName, setOrgDisplayName] = useState('')
  const [orgError, setOrgError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!me) return

    fetch(`/api/accounts/${me.slug}/collections`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : []))
      .then(setCollections)

    if (me.orgs?.length) {
      Promise.all(
        me.orgs.map(async (org: any) => {
          const res = await fetch(`/api/accounts/${org.slug}/collections`, { credentials: 'include' })
          return {
            slug: org.slug,
            displayName: org.displayName,
            role: org.role,
            collections: res.ok ? await res.json() : [],
          }
        }),
      ).then(setOrgs)
    }
  }, [me])

  async function handleCreateOrg(e: FormEvent) {
    e.preventDefault()
    setOrgError('')
    setSubmitting(true)
    try {
      const res = await fetch('/api/accounts/orgs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ slug: orgSlug, displayName: orgDisplayName }),
      })
      if (res.ok) {
        window.location.reload()
      } else {
        const err = await res.json()
        setOrgError(err.error ?? 'Failed to create organization')
      }
    } finally {
      setSubmitting(false)
    }
  }

  function matchesFilter(text: string) {
    return text.toLowerCase().includes(filter.toLowerCase())
  }

  if (!me) return null

  return (
    <BaseLayout>
      <div className="max-w-5xl mx-auto px-4 py-10">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
          <a href="/settings" className="text-sm text-ink-muted hover:text-ink transition-colors">Settings</a>
        </div>

        <div className="flex flex-col lg:flex-row gap-8">
          {/* Main content area */}
          <div className="flex-1 min-w-0">
            {/* Search/filter */}
            <div className="mb-4">
              <input
                type="text"
                placeholder="Filter collections…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="w-full bg-parchment border border-rule px-3 py-2 text-sm focus:outline-none focus:border-ink"
              />
            </div>

            {/* Personal collections */}
            <div className="mb-6">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-muted mb-2">
                Your Collections ({collections.length})
              </h2>

              {collections.length === 0 ? (
                <div className="border border-rule border-dashed p-4 text-center">
                  <p className="text-sm text-ink-muted mb-1">No collections yet.</p>
                  <p className="text-xs text-ink-muted">Use the API to create your first collection.</p>
                </div>
              ) : (
                <div className="space-y-1">
                  {collections
                    .filter((c) => matchesFilter(`${me.slug}/${c.slug} ${c.name} ${c.description ?? ''}`))
                    .map((c) => (
                      <a
                        key={c.slug}
                        href={`/${me.slug}/${c.slug}`}
                        className="flex items-center justify-between border border-rule px-3 py-2 hover:bg-parchment-dark transition-colors"
                      >
                        <div className="min-w-0">
                          <span className="font-medium text-sm">{me.slug}/{c.slug}</span>
                          {c.description && <p className="text-xs text-ink-muted mt-0.5 truncate">{c.description}</p>}
                        </div>
                        <span className="text-[10px] text-ink-muted border border-rule px-1.5 py-0.5 ml-2 flex-shrink-0">
                          {c.public ? 'public' : 'private'}
                        </span>
                      </a>
                    ))}
                </div>
              )}
            </div>

            {/* Org collections */}
            {orgs.map((org) => (
              <div key={org.slug} className="mb-6">
                <div className="flex items-center justify-between mb-2">
                  <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
                    <a href={`/${org.slug}`} className="hover:text-ink transition-colors">{org.displayName}</a>
                    <span className="ml-1.5 text-[10px] font-normal border border-rule px-1 py-0.5 normal-case">{org.role}</span>
                  </h2>
                  <a href={`/${org.slug}/settings`} className="text-[10px] text-ink-muted hover:text-ink">settings</a>
                </div>

                {org.collections.length === 0 ? (
                  <p className="text-xs text-ink-muted pl-1">No collections yet.</p>
                ) : (
                  <div className="space-y-1">
                    {org.collections
                      .filter((c) => matchesFilter(`${org.slug}/${c.slug} ${c.name} ${c.description ?? ''}`))
                      .map((c) => (
                        <a
                          key={c.slug}
                          href={`/${org.slug}/${c.slug}`}
                          className="flex items-center justify-between border border-rule px-3 py-2 hover:bg-parchment-dark transition-colors"
                        >
                          <div className="min-w-0">
                            <span className="font-medium text-sm">{org.slug}/{c.slug}</span>
                            {c.description && <p className="text-xs text-ink-muted mt-0.5 truncate">{c.description}</p>}
                          </div>
                          <span className="text-[10px] text-ink-muted border border-rule px-1.5 py-0.5 ml-2 flex-shrink-0">
                            {c.public ? 'public' : 'private'}
                          </span>
                        </a>
                      ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Right sidebar */}
          <div className="lg:w-64 flex-shrink-0 space-y-6">
            {/* Quick reference */}
            <div className="border border-rule p-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted mb-2">Quick Reference</h3>
              <div className="text-xs text-ink-muted space-y-2">
                <div>
                  <p className="font-medium text-ink text-[11px] mb-0.5">Create collection</p>
                  <code className="block bg-parchment-dark px-1.5 py-1 text-[10px] break-all">POST /api/accounts/{me.slug}/collections</code>
                </div>
                <div>
                  <p className="font-medium text-ink text-[11px] mb-0.5">Push version</p>
                  <code className="block bg-parchment-dark px-1.5 py-1 text-[10px] break-all">POST /api/collections/{me.slug}/&lt;slug&gt;/versions</code>
                </div>
                <a href="/docs/quickstart" className="block text-link text-[11px] hover:underline mt-2">Quickstart guide →</a>
              </div>
            </div>

            {/* Create org */}
            <div className="border border-rule p-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted mb-2">New Organization</h3>
              {orgError && <p className="text-red-600 text-xs mb-2">{orgError}</p>}
              <form onSubmit={handleCreateOrg} className="space-y-2">
                <div>
                  <label className="block text-[10px] text-ink-muted mb-0.5">Slug</label>
                  <input
                    type="text"
                    required
                    pattern="[a-z0-9][a-z0-9\-]*[a-z0-9]"
                    minLength={2}
                    placeholder="my-org"
                    value={orgSlug}
                    onChange={(e) => setOrgSlug(e.target.value)}
                    className="w-full border border-rule px-2 py-1 text-xs bg-parchment focus:outline-none focus:border-ink"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-ink-muted mb-0.5">Display Name</label>
                  <input
                    type="text"
                    required
                    placeholder="My Organization"
                    value={orgDisplayName}
                    onChange={(e) => setOrgDisplayName(e.target.value)}
                    className="w-full border border-rule px-2 py-1 text-xs bg-parchment focus:outline-none focus:border-ink"
                  />
                </div>
                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full bg-ink text-parchment px-3 py-1 text-xs font-medium hover:opacity-90 transition-opacity"
                >
                  {submitting ? 'Creating…' : 'Create'}
                </button>
              </form>
            </div>

            {/* Links */}
            <div className="text-xs space-y-1.5">
              <a href={`/${me.slug}`} className="block text-ink-muted hover:text-ink transition-colors">Your profile →</a>
              <a href="/settings/keys" className="block text-ink-muted hover:text-ink transition-colors">API keys →</a>
              <a href="/explore" className="block text-ink-muted hover:text-ink transition-colors">Explore collections →</a>
            </div>
          </div>
        </div>
      </div>
    </BaseLayout>
  )
}
