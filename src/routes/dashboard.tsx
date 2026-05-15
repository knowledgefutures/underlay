import { type FormEvent, useEffect, useState, } from 'react'
import { Link, } from 'react-router'
import BaseLayout from '~/components/BaseLayout'
import { useSSRData, } from '~/lib/ssr-data'

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

interface KfOrg {
  id: string
  name: string
  slug: string
  type: string
  role: string
}

export default function Dashboard() {
  const me = useSSRData<any>('currentUser',)
  const [collections, setCollections,] = useState<Collection[]>([],)
  const [orgs, setOrgs,] = useState<Org[]>([],)
  const [filter, setFilter,] = useState('',)

  // Org creation state
  const [orgSlug, setOrgSlug,] = useState('',)
  const [orgDisplayName, setOrgDisplayName,] = useState('',)
  const [orgKfOrgId, setOrgKfOrgId,] = useState('',)
  const [orgError, setOrgError,] = useState('',)
  const [submitting, setSubmitting,] = useState(false,)
  const [availableKfOrgs, setAvailableKfOrgs,] = useState<KfOrg[]>([],)

  // Collection creation state
  const [showCreateCollection, setShowCreateCollection,] = useState(false,)
  const [colSlug, setColSlug,] = useState('',)
  const [colName, setColName,] = useState('',)
  const [colDescription, setColDescription,] = useState('',)
  const [colPublic, setColPublic,] = useState(false,)
  const [colOwner, setColOwner,] = useState('',)
  const [colError, setColError,] = useState('',)
  const [colSubmitting, setColSubmitting,] = useState(false,)

  useEffect(() => {
    if (!me) return

    // Set default collection owner
    setColOwner(me.slug,)

    fetch(`/api/accounts/${me.slug}/collections`, { credentials: 'include', },)
      .then((r,) => (r.ok ? r.json() : []))
      .then(setCollections,)

    if (me.orgs?.length) {
      Promise.all(
        me.orgs.map(async (org: any,) => {
          const res = await fetch(`/api/accounts/${org.slug}/collections`, { credentials: 'include', },)
          return {
            slug: org.slug,
            displayName: org.displayName,
            role: org.role,
            collections: res.ok ? await res.json() : [],
          }
        },),
      ).then(setOrgs,)
    }

    // Fetch available KF orgs for the org creation dropdown
    fetch('/api/accounts/available-kf-orgs', { credentials: 'include', },)
      .then((r,) => (r.ok ? r.json() : []))
      .then((orgs: KfOrg[],) => {
        setAvailableKfOrgs(orgs,)
        // Auto-select if only one KF org available
        if (orgs.length === 1) {
          setOrgKfOrgId(orgs[0]!.id,)
        }
      },)
  }, [me,],)

  async function handleCreateOrg(e: FormEvent,) {
    e.preventDefault()
    setOrgError('',)
    setSubmitting(true,)
    try {
      const res = await fetch('/api/accounts/orgs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', },
        credentials: 'include',
        body: JSON.stringify({ slug: orgSlug, displayName: orgDisplayName, kfOrgId: orgKfOrgId, },),
      },)
      if (res.ok) {
        window.location.reload()
      } else {
        const err = await res.json()
        setOrgError(err.error ?? 'Failed to create organization',)
      }
    } finally {
      setSubmitting(false,)
    }
  }

  async function handleCreateCollection(e: FormEvent,) {
    e.preventDefault()
    setColError('',)
    setColSubmitting(true,)
    try {
      const res = await fetch(`/api/accounts/${colOwner}/collections`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', },
        credentials: 'include',
        body: JSON.stringify({
          slug: colSlug,
          name: colName,
          description: colDescription || undefined,
          public: colPublic,
        },),
      },)
      if (res.ok) {
        window.location.reload()
      } else {
        const err = await res.json()
        setColError(err.error ?? 'Failed to create collection',)
      }
    } finally {
      setColSubmitting(false,)
    }
  }

  // All accounts the user can create collections under
  const ownerOptions = [
    { slug: me?.slug, label: me?.displayName ?? me?.slug, },
    ...(orgs ?? []).map((o,) => ({ slug: o.slug, label: o.displayName, })),
  ]

  function matchesFilter(text: string,) {
    return text.toLowerCase().includes(filter.toLowerCase(),)
  }

  if (!me) return null

  return (
    <BaseLayout>
      <div className='max-w-5xl mx-auto px-4 py-10'>
        <div className='flex items-center justify-between mb-6'>
          <h1 className='text-xl font-semibold tracking-tight'>Dashboard</h1>
          <Link to='/settings' className='text-sm text-ink-muted hover:text-ink transition-colors'>Settings</Link>
        </div>

        <div className='flex flex-col lg:flex-row gap-8'>
          {/* Main content area */}
          <div className='flex-1 min-w-0'>
            {/* Search/filter */}
            <div className='mb-4'>
              <input
                type='text'
                placeholder='Filter collections…'
                value={filter}
                onChange={(e,) => setFilter(e.target.value,)}
                className='w-full bg-parchment border border-rule px-3 py-2 text-sm focus:outline-none focus:border-ink'
              />
            </div>

            {/* Personal collections */}
            <div className='mb-6'>
              <h2 className='text-xs font-semibold uppercase tracking-wide text-ink-muted mb-2'>
                Your Collections ({collections.length})
              </h2>

              {collections.length === 0
                ? (
                  <div className='border border-rule border-dashed p-4 text-center'>
                    <p className='text-sm text-ink-muted mb-1'>No collections yet.</p>
                    <p className='text-xs text-ink-muted'>Use the API to create your first collection.</p>
                  </div>
                )
                : (
                  <div className='space-y-1'>
                    {collections
                      .filter((c,) => matchesFilter(`${me.slug}/${c.slug} ${c.name} ${c.description ?? ''}`,))
                      .map((c,) => (
                        <Link
                          key={c.slug}
                          to={`/${me.slug}/${c.slug}`}
                          className='flex items-center justify-between border border-rule px-3 py-2 hover:bg-parchment-dark transition-colors'
                        >
                          <div className='min-w-0'>
                            <span className='font-medium text-sm'>{me.slug}/{c.slug}</span>
                            {c.description && <p className='text-xs text-ink-muted mt-0.5 truncate'>{c.description}</p>}
                          </div>
                          <span className='text-[10px] text-ink-muted border border-rule px-1.5 py-0.5 ml-2 flex-shrink-0'>
                            {c.public ? 'public' : 'private'}
                          </span>
                        </Link>
                      ))}
                  </div>
                )}
            </div>

            {/* Org collections */}
            {orgs.map((org,) => (
              <div key={org.slug} className='mb-6'>
                <div className='flex items-center justify-between mb-2'>
                  <h2 className='text-xs font-semibold uppercase tracking-wide text-ink-muted'>
                    <Link to={`/${org.slug}`} className='hover:text-ink transition-colors'>{org.displayName}</Link>
                    <span className='ml-1.5 text-[10px] font-normal border border-rule px-1 py-0.5 normal-case'>
                      {org.role}
                    </span>
                  </h2>
                  <Link to={`/${org.slug}/settings`} className='text-[10px] text-ink-muted hover:text-ink'>
                    settings
                  </Link>
                </div>

                {org.collections.length === 0
                  ? <p className='text-xs text-ink-muted pl-1'>No collections yet.</p>
                  : (
                    <div className='space-y-1'>
                      {org.collections
                        .filter((c,) => matchesFilter(`${org.slug}/${c.slug} ${c.name} ${c.description ?? ''}`,))
                        .map((c,) => (
                          <Link
                            key={c.slug}
                            to={`/${org.slug}/${c.slug}`}
                            className='flex items-center justify-between border border-rule px-3 py-2 hover:bg-parchment-dark transition-colors'
                          >
                            <div className='min-w-0'>
                              <span className='font-medium text-sm'>{org.slug}/{c.slug}</span>
                              {c.description && (
                                <p className='text-xs text-ink-muted mt-0.5 truncate'>{c.description}</p>
                              )}
                            </div>
                            <span className='text-[10px] text-ink-muted border border-rule px-1.5 py-0.5 ml-2 flex-shrink-0'>
                              {c.public ? 'public' : 'private'}
                            </span>
                          </Link>
                        ))}
                    </div>
                  )}
              </div>
            ))}
          </div>

          {/* Right sidebar */}
          <div className='lg:w-64 flex-shrink-0 space-y-6'>
            {/* Create collection */}
            <div className='border border-rule p-4'>
              <div className='flex items-center justify-between mb-2'>
                <h3 className='text-xs font-semibold uppercase tracking-wide text-ink-muted'>New Collection</h3>
                {!showCreateCollection && (
                  <button
                    type='button'
                    onClick={() => setShowCreateCollection(true,)}
                    className='text-xs text-link hover:underline bg-transparent border-none cursor-pointer'
                  >
                    + Create
                  </button>
                )}
              </div>

              {showCreateCollection
                ? (
                  <form onSubmit={handleCreateCollection} className='space-y-2'>
                    {colError && <p className='text-red-600 text-xs'>{colError}</p>}

                    {/* Owner picker — only show if user has orgs */}
                    {ownerOptions.length > 1 && (
                      <div>
                        <label className='block text-[10px] text-ink-muted mb-0.5'>Owner</label>
                        <select
                          value={colOwner}
                          onChange={(e,) => setColOwner(e.target.value,)}
                          className='w-full border border-rule px-2 py-1 text-xs bg-parchment focus:outline-none focus:border-ink'
                        >
                          {ownerOptions.map((o,) => <option key={o.slug} value={o.slug}>{o.label} ({o.slug})</option>)}
                        </select>
                      </div>
                    )}

                    <div>
                      <label className='block text-[10px] text-ink-muted mb-0.5'>Name</label>
                      <input
                        type='text'
                        required
                        placeholder='My Dataset'
                        value={colName}
                        onChange={(e,) => setColName(e.target.value,)}
                        className='w-full border border-rule px-2 py-1 text-xs bg-parchment focus:outline-none focus:border-ink'
                      />
                    </div>
                    <div>
                      <label className='block text-[10px] text-ink-muted mb-0.5'>Slug</label>
                      <input
                        type='text'
                        required
                        pattern='[a-z0-9][a-z0-9\-]*[a-z0-9]'
                        minLength={2}
                        placeholder='my-dataset'
                        value={colSlug}
                        onChange={(e,) => setColSlug(e.target.value,)}
                        className='w-full border border-rule px-2 py-1 text-xs bg-parchment focus:outline-none focus:border-ink'
                      />
                    </div>
                    <div>
                      <label className='block text-[10px] text-ink-muted mb-0.5'>Description</label>
                      <input
                        type='text'
                        placeholder='Optional'
                        value={colDescription}
                        onChange={(e,) => setColDescription(e.target.value,)}
                        className='w-full border border-rule px-2 py-1 text-xs bg-parchment focus:outline-none focus:border-ink'
                      />
                    </div>
                    <label className='flex items-center gap-1.5 text-xs text-ink-muted'>
                      <input
                        type='checkbox'
                        checked={colPublic}
                        onChange={(e,) => setColPublic(e.target.checked,)}
                      />
                      Public
                    </label>
                    <div className='flex gap-2'>
                      <button
                        type='submit'
                        disabled={colSubmitting}
                        className='flex-1 bg-ink text-parchment px-3 py-1 text-xs font-medium hover:opacity-90 transition-opacity'
                      >
                        {colSubmitting ? 'Creating…' : 'Create'}
                      </button>
                      <button
                        type='button'
                        onClick={() => setShowCreateCollection(false,)}
                        className='px-3 py-1 text-xs text-ink-muted border border-rule hover:text-ink bg-transparent cursor-pointer'
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                )
                : (
                  <div className='text-xs text-ink-muted space-y-2'>
                    <div>
                      <p className='font-medium text-ink text-[11px] mb-0.5'>Via API</p>
                      <code className='block bg-parchment-dark px-1.5 py-1 text-[10px] break-all'>
                        POST /api/accounts/{me.slug}/collections
                      </code>
                    </div>
                    <Link to='/docs/quickstart' className='block text-link text-[11px] hover:underline mt-2'>
                      Quickstart guide →
                    </Link>
                  </div>
                )}
            </div>

            {/* Create org — requires at least one available KF org */}
            {availableKfOrgs.length > 0 && (
              <div className='border border-rule p-4'>
                <h3 className='text-xs font-semibold uppercase tracking-wide text-ink-muted mb-2'>New Organization</h3>
                {orgError && <p className='text-red-600 text-xs mb-2'>{orgError}</p>}
                <form onSubmit={handleCreateOrg} className='space-y-2'>
                  {availableKfOrgs.length > 1
                    ? (
                      <div>
                        <label className='block text-[10px] text-ink-muted mb-0.5'>KF Organization</label>
                        <select
                          required
                          value={orgKfOrgId}
                          onChange={(e,) => {
                            setOrgKfOrgId(e.target.value,)
                            // Auto-fill display name from KF org
                            const kfOrg = availableKfOrgs.find((o,) => o.id === e.target.value)
                            if (kfOrg && !orgDisplayName) setOrgDisplayName(kfOrg.name,)
                          }}
                          className='w-full border border-rule px-2 py-1 text-xs bg-parchment focus:outline-none focus:border-ink'
                        >
                          <option value=''>Select…</option>
                          {availableKfOrgs.map((o,) => <option key={o.id} value={o.id}>{o.name}</option>)}
                        </select>
                      </div>
                    )
                    : (
                      <p className='text-[10px] text-ink-muted'>
                        Linked to: <span className='font-medium text-ink'>{availableKfOrgs[0]?.name}</span>
                      </p>
                    )}
                  <div>
                    <label className='block text-[10px] text-ink-muted mb-0.5'>Slug</label>
                    <input
                      type='text'
                      required
                      pattern='[a-z0-9][a-z0-9\-]*[a-z0-9]'
                      minLength={2}
                      placeholder='my-org'
                      value={orgSlug}
                      onChange={(e,) => setOrgSlug(e.target.value,)}
                      className='w-full border border-rule px-2 py-1 text-xs bg-parchment focus:outline-none focus:border-ink'
                    />
                  </div>
                  <div>
                    <label className='block text-[10px] text-ink-muted mb-0.5'>Display Name</label>
                    <input
                      type='text'
                      required
                      placeholder='My Organization'
                      value={orgDisplayName}
                      onChange={(e,) => setOrgDisplayName(e.target.value,)}
                      className='w-full border border-rule px-2 py-1 text-xs bg-parchment focus:outline-none focus:border-ink'
                    />
                  </div>
                  <button
                    type='submit'
                    disabled={submitting}
                    className='w-full bg-ink text-parchment px-3 py-1 text-xs font-medium hover:opacity-90 transition-opacity'
                  >
                    {submitting ? 'Creating…' : 'Create'}
                  </button>
                </form>
              </div>
            )}

            {/* Links */}
            <div className='text-xs space-y-1.5'>
              <Link to={`/${me.slug}`} className='block text-ink-muted hover:text-ink transition-colors'>
                Your profile →
              </Link>
              <Link to='/settings/keys' className='block text-ink-muted hover:text-ink transition-colors'>
                API keys →
              </Link>
              <Link to='/explore' className='block text-ink-muted hover:text-ink transition-colors'>
                Explore collections →
              </Link>
            </div>
          </div>
        </div>
      </div>
    </BaseLayout>
  )
}
