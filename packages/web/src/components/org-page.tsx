/**
 * The pieces of an organization's page (`/:owner`): its header, the collection cards,
 * list and one-collection spotlight, and the sidebar. The route decides which show,
 * by how many collections the org has: one fills the page, two to four are cards, five
 * or more are pinned cards and a list with filters.
 */
import { useMemo, useState } from 'react'
import { Link } from 'react-router'

import { buttonClasses, ButtonLink, EmptyState, Input, Select } from '~/components/ui'
import { formatBytesFixed, formatDate, tagLabel } from '~/lib/format'
import { renderMarkdown } from '~/lib/markdown'

export interface OrgAccount {
  id: string
  slug: string
  displayName: string
  avatarUrl: string | null
  bio: string | null
  website: string | null
  tagline: string | null
  location: string | null
  coverColor: string | null
  provenanceNote: string | null
  pinned: string[]
  createdAt: string
}

export interface OrgCollection {
  id: string
  slug: string
  name: string
  public: boolean
  createdAt: string
  updatedAt: string
  description: string | null
  tags: string[]
  license: string | null
  latestVersion: string | null
  recordCount: number | null
  totalBytes: number | null
  typeCounts: Record<string, number> | null
  lastPushAt: string | null
  pinned: number | null
}

export interface OrgActivity {
  collectionSlug: string
  collectionName: string
  semver: string
  message: string | null
  recordCount: number
  createdAt: string
}

export interface OrgMember {
  displayName: string
  role?: string
  public?: boolean
  you?: boolean
}

/** Cover colors an org may pick; one is chosen from its slug until it does. */
export const COVER_COLORS = [
  '#22394f',
  '#3b5a40',
  '#1a4a6e',
  '#5b4f8a',
  '#8a3b12',
  '#6e5a3c',
  '#2d5a27',
  '#3d3d38',
]

function hashIndex(s: string, n: number) {
  let h = 0
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return h % n
}

export const coverColorFor = (a: Pick<OrgAccount, 'slug' | 'coverColor'>) =>
  a.coverColor ?? COVER_COLORS[hashIndex(a.slug, COVER_COLORS.length)]!

const n = (v: number) => v.toLocaleString('en-US')

/** A collection's record types, most records first. */
/** A collection's record types that hold records, most records first. */
export const typesOf = (c: Pick<OrgCollection, 'typeCounts'>) =>
  Object.entries(c.typeCounts ?? {})
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])

/** "NYC" for nyc, "NYC" for New York City, "WC" for Wren Creek Field Station. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) {
    const w = words[0]!
    return (w.length <= 4 ? w : w[0]!).toUpperCase()
  }
  return words
    .slice(0, words.length <= 3 ? 3 : 2)
    .map((w) => w[0]!.toUpperCase())
    .join('')
}

export function OrgLogo({
  account,
  className = '',
}: {
  account: Pick<OrgAccount, 'avatarUrl' | 'displayName'>
  className?: string
}) {
  if (account.avatarUrl)
    return (
      <img
        src={account.avatarUrl}
        alt={account.displayName}
        className={`bg-parchment object-cover ${className}`}
      />
    )
  return (
    <div
      aria-hidden="true"
      className={`bg-ink text-parchment flex items-center justify-center font-bold tracking-wide ${className}`}
    >
      {initials(account.displayName)}
    </div>
  )
}

// ---------------------------------------------------------------- Header

export type OrgTab = 'overview' | 'collections' | 'members' | 'activity'

export function OrgHeader({
  account,
  tabs,
  tab,
  canManage,
  summary,
}: {
  account: OrgAccount
  tabs: { id: OrgTab; label: string; count?: number }[]
  tab: OrgTab
  canManage: boolean
  /** What the org holds, in one line (orgSummary). */
  summary: string | null
}) {
  return (
    <section className="border-rule border-b">
      <div
        aria-hidden="true"
        className="h-24 sm:h-36"
        style={{ backgroundColor: coverColorFor(account) }}
      />
      <div className="mx-auto max-w-5xl px-4">
        <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
          <OrgLogo
            account={account}
            className="border-parchment -mt-12 h-24 w-24 shrink-0 rounded-[14px] border-4 text-2xl sm:-mt-14 sm:h-28 sm:w-28 sm:text-3xl"
          />
          <div className="min-w-0 flex-[999_1_18rem] sm:pt-3">
            <h1 className="text-3xl leading-tight font-bold tracking-tight">
              {account.displayName}
            </h1>
            <p className="text-ink-muted font-mono text-sm">@{account.slug}</p>
          </div>
          <div className="flex flex-auto flex-wrap justify-end gap-2 sm:pt-4">
            {canManage && (
              <ButtonLink to={`/${account.slug}/settings`} variant="secondary">
                Settings
              </ButtonLink>
            )}
            <a href="#use" className={buttonClasses('primary', 'md', 'visited:text-parchment')}>
              Use this data
            </a>
          </div>
        </div>

        {account.tagline && (
          <p className="mt-4 max-w-2xl text-lg leading-snug">{account.tagline}</p>
        )}

        <div className="text-ink-light mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
          {account.location && (
            <span className="inline-flex items-center gap-1.5">
              <Icon name="pin" />
              {account.location}
            </span>
          )}
          {account.website && (
            <span className="inline-flex items-center gap-1.5">
              <Icon name="link" />
              <a
                href={account.website}
                target="_blank"
                rel="noopener noreferrer"
                className="text-link hover:underline"
              >
                {account.website.replace(/^https?:\/\//, '').replace(/\/$/, '')}
              </a>
            </span>
          )}
          <span className="inline-flex items-center gap-1.5">
            <Icon name="calendar" />
            Joined {formatDate(account.createdAt, 'month')}
          </span>
          {summary && (
            <span className="inline-flex items-center gap-1.5">
              <Icon name="stack" />
              {summary}
            </span>
          )}
        </div>

        {account.provenanceNote && (
          <p className="text-ink-muted mt-2 text-xs">{account.provenanceNote}</p>
        )}

        <nav aria-label="Organization" className="mt-5 -mb-px flex gap-1 overflow-x-auto">
          {tabs.map((t) => (
            <Link
              key={t.id}
              to={t.id === 'overview' ? `/${account.slug}` : `/${account.slug}?tab=${t.id}`}
              preventScrollReset
              aria-current={t.id === tab ? 'page' : undefined}
              className={`inline-flex items-center gap-2 border-b-2 px-3 py-3 text-sm whitespace-nowrap no-underline ${
                t.id === tab
                  ? 'border-ink text-ink font-semibold'
                  : 'text-ink-light hover:text-ink border-transparent'
              }`}
            >
              {t.label}
              {t.count !== undefined && (
                <span className="bg-parchment-dark text-ink rounded-full px-2 text-xs font-normal">
                  {n(t.count)}
                </span>
              )}
            </Link>
          ))}
        </nav>
      </div>
    </section>
  )
}

function Icon({ name }: { name: 'pin' | 'link' | 'calendar' | 'stack' | 'copy' | 'check' }) {
  const paths = {
    pin: (
      <>
        <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
        <circle cx="12" cy="10" r="3" />
      </>
    ),
    link: (
      <>
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
      </>
    ),
    calendar: (
      <>
        <rect x="3" y="4" width="18" height="18" rx="2" />
        <path d="M16 2v4M8 2v4M3 10h18" />
      </>
    ),
    stack: (
      <>
        <ellipse cx="12" cy="5" rx="9" ry="3" />
        <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
        <path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3" />
      </>
    ),
    copy: (
      <>
        <rect x="9" y="9" width="13" height="13" rx="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </>
    ),
    check: <path d="M20 6 9 17l-5-5" />,
  }
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      {paths[name]}
    </svg>
  )
}

// ---------------------------------------------------------------- Summary

/** "7 collections · 2,038,025 records · 1.1 GiB · updated Oct 30, 2026", for two or more. */
export function orgSummary(collections: OrgCollection[]): string | null {
  if (collections.length < 2) return null
  const records = collections.reduce((s, c) => s + (c.recordCount ?? 0), 0)
  const bytes = collections.reduce((s, c) => s + (c.totalBytes ?? 0), 0)
  const last = collections
    .map((c) => c.lastPushAt)
    .filter((d): d is string => !!d)
    .sort()
    .at(-1)
  return [
    `${n(collections.length)} collections`,
    `${n(records)} ${records === 1 ? 'record' : 'records'}`,
    bytes ? formatBytesFixed(bytes) : null,
    last ? `updated ${formatDate(last)}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
}

// ---------------------------------------------------------------- Collections

function Tags({ tags }: { tags: string[] }) {
  if (!tags.length) return null
  return (
    <div className="flex flex-wrap gap-1.5">
      {tags.map((t) => (
        <span
          key={t}
          className="border-rule text-ink-light rounded-full border px-2 py-px text-[11px]"
        >
          {tagLabel(t)}
        </span>
      ))}
    </div>
  )
}

function Meta({ c }: { c: OrgCollection }) {
  const parts = [
    c.latestVersion,
    c.recordCount !== null ? `${n(c.recordCount)} records` : null,
    c.totalBytes ? formatBytesFixed(c.totalBytes) : null,
    c.license,
    c.lastPushAt ? `Published ${formatDate(c.lastPushAt)}` : null,
  ].filter(Boolean)
  if (!c.public) parts.unshift('Private')
  return (
    <div className="text-ink-muted flex flex-wrap gap-x-3.5 gap-y-1 text-xs">
      {parts.map((p) => (
        <span key={p}>{p}</span>
      ))}
    </div>
  )
}

/** A large card: pinned collections, and every collection of an org with two to four. */
export function CollectionCard({ owner, c }: { owner: string; c: OrgCollection }) {
  const types = typesOf(c)
  return (
    <article className="border-rule rounded-surface flex min-w-0 flex-col overflow-hidden border bg-white/40">
      <div className="flex flex-1 flex-col gap-3 px-5 pt-5 pb-4">
        <Tags tags={c.tags} />
        <div>
          <h3 className="text-xl leading-snug font-semibold">
            <Link to={`/${owner}/${c.slug}`} className="text-ink hover:underline">
              {c.name}
            </Link>
          </h3>
          <p className="text-ink-muted font-mono text-xs">
            {owner}/{c.slug}
          </p>
        </div>
        {c.description && <p className="text-ink-light text-sm">{c.description}</p>}
        {types.length > 0 && (
          <dl className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-x-5 gap-y-1.5 text-[13px]">
            {types.slice(0, 6).map(([t, count]) => (
              <div
                key={t}
                className="border-rule flex justify-between gap-2 border-b border-dotted"
              >
                <dt className="text-ink-light truncate font-mono text-xs leading-5">{t}</dt>
                <dd className="tabular-nums">{n(count)}</dd>
              </div>
            ))}
          </dl>
        )}
        {types.length > 6 && (
          <p className="text-ink-muted -mt-1 text-xs">and {types.length - 6} more types</p>
        )}
        <div className="mt-auto pt-1">
          <Meta c={c} />
        </div>
        <div className="flex flex-wrap gap-2">
          <ButtonLink to={`/${owner}/${c.slug}`} size="sm">
            Open
          </ButtonLink>
          {c.latestVersion && (
            <>
              <ButtonLink to={`/${owner}/${c.slug}/records`} size="sm" variant="secondary">
                Records
              </ButtonLink>
              <ButtonLink to={`/${owner}/${c.slug}/schemas`} size="sm" variant="secondary">
                Schemas
              </ButtonLink>
            </>
          )}
        </div>
      </div>
    </article>
  )
}

function CollectionRow({ owner, c }: { owner: string; c: OrgCollection }) {
  const types = typesOf(c)
  return (
    <article className="border-rule flex flex-wrap gap-x-7 gap-y-3 border-b py-5">
      <div className="min-w-0 flex-[999_1_22rem]">
        <div className="flex items-center gap-2.5">
          <h3 className="text-base leading-snug font-semibold">
            <Link to={`/${owner}/${c.slug}`} className="text-ink hover:underline">
              {c.name}
            </Link>
          </h3>
          {!c.public && (
            <span className="border-rule text-ink-muted rounded-full border px-2 text-[11px]">
              Private
            </span>
          )}
        </div>
        <p className="text-ink-muted font-mono text-xs">
          {owner}/{c.slug}
        </p>
        {c.description && <p className="text-ink-light mt-2 text-sm">{c.description}</p>}
        <div className="mt-3 flex flex-wrap gap-1.5">
          {types.slice(0, 3).map(([t, count]) => (
            <span
              key={t}
              className="bg-parchment-dark rounded-control px-2 py-px font-mono text-[11px]"
            >
              {t} <span className="text-ink-muted">{n(count)}</span>
            </span>
          ))}
          {types.length > 3 && (
            <span className="bg-parchment-dark rounded-control px-2 py-px font-mono text-[11px]">
              +{types.length - 3} more
            </span>
          )}
          {c.tags.map((t) => (
            <span
              key={t}
              className="border-rule text-ink-light rounded-full border px-2 py-px text-[11px]"
            >
              {tagLabel(t)}
            </span>
          ))}
        </div>
      </div>
      <div className="flex min-w-0 flex-[1_1_11rem] flex-col gap-0.5 text-sm sm:text-right">
        {c.recordCount !== null ? (
          <>
            <div className="font-medium tabular-nums">
              {n(c.recordCount)} {c.recordCount === 1 ? 'record' : 'records'}
            </div>
            <div className="text-ink-muted text-xs">
              {[
                c.totalBytes ? formatBytesFixed(c.totalBytes) : null,
                c.latestVersion,
                c.lastPushAt ? formatDate(c.lastPushAt) : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </div>
          </>
        ) : (
          <div className="text-ink-muted text-xs">No versions yet</div>
        )}
      </div>
    </article>
  )
}

type Sort = 'records' | 'recent' | 'name'

/** Every collection, with a search, topic filter and sort, for orgs with five or more. */
export function CollectionsBrowser({
  owner,
  collections,
  newCollection,
}: {
  owner: string
  collections: OrgCollection[]
  newCollection: boolean
}) {
  const [q, setQ] = useState('')
  const [topic, setTopic] = useState<string | null>(null)
  const [sort, setSort] = useState<Sort>('records')

  const topics = useMemo(() => {
    const counts = new Map<string, number>()
    for (const c of collections) for (const t of c.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
    // A tag every collection has filters nothing out.
    return [...counts.entries()]
      .filter(([, count]) => count < collections.length)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 8)
  }, [collections])

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return collections
      .filter((c) => !topic || c.tags.includes(topic))
      .filter(
        (c) =>
          !needle ||
          [c.name, c.slug, c.description ?? '', ...Object.keys(c.typeCounts ?? {})]
            .join(' ')
            .toLowerCase()
            .includes(needle),
      )
      .sort((a, b) =>
        sort === 'name'
          ? a.name.localeCompare(b.name)
          : sort === 'recent'
            ? (b.lastPushAt ?? '').localeCompare(a.lastPushAt ?? '')
            : (b.recordCount ?? -1) - (a.recordCount ?? -1),
      )
  }, [collections, q, topic, sort])

  const chip = (on: boolean) =>
    `inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] transition-colors ${
      on ? 'border-ink bg-ink text-parchment' : 'border-rule text-ink hover:bg-parchment-dark'
    }`

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-ink-muted text-xs font-semibold tracking-wide uppercase">
          All collections
        </h2>
        <div className="flex items-center gap-3">
          <span className="text-ink-muted text-xs">
            Showing {shown.length} of {collections.length}
          </span>
          {newCollection && (
            <ButtonLink to={`/new?owner=${owner}`} size="sm">
              New collection
            </ButtonLink>
          )}
        </div>
      </div>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div className="flex min-w-0 flex-[1_1_14rem] flex-col gap-1">
          <label htmlFor="org-search" className="text-ink-muted text-xs">
            Search
          </label>
          <Input
            id="org-search"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Name, description or record type"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="org-sort" className="text-ink-muted text-xs">
            Sort
          </label>
          <Select id="org-sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="records">Most records</option>
            <option value="recent">Recently published</option>
            <option value="name">Name</option>
          </Select>
        </div>
      </div>
      {topics.length > 0 && (
        <div role="group" aria-label="Topic" className="mb-2 flex flex-wrap gap-1.5">
          <button
            type="button"
            className={chip(topic === null)}
            aria-pressed={topic === null}
            onClick={() => setTopic(null)}
          >
            All <span className="opacity-70">{collections.length}</span>
          </button>
          {topics.map(([t, count]) => (
            <button
              key={t}
              type="button"
              className={chip(topic === t)}
              aria-pressed={topic === t}
              onClick={() => setTopic(topic === t ? null : t)}
            >
              {tagLabel(t)} <span className="opacity-70">{count}</span>
            </button>
          ))}
        </div>
      )}
      {shown.map((c) => (
        <CollectionRow key={c.id} owner={owner} c={c} />
      ))}
      {shown.length === 0 && (
        <p className="border-rule text-ink-muted border-b py-6 text-sm">
          No collections match. Clear the search or pick another topic.
        </p>
      )}
    </section>
  )
}

export function CardGrid({ owner, collections }: { owner: string; collections: OrgCollection[] }) {
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      {collections.map((c) => (
        <CollectionCard key={c.id} owner={owner} c={c} />
      ))}
    </div>
  )
}

/** The first paragraph of prose in a README: past its title and any lists or tables. */
export function readmeExcerpt(readme: string | null | undefined): string | null {
  if (!readme) return null
  for (const block of readme.split(/\n\s*\n/)) {
    const t = block.trim()
    if (!t || /^(#|\||[-*+] |\d+\. |>|```|\*\*[^*]+:\*\*|!\[)/.test(t)) continue
    return t
  }
  return null
}

/** An org with one collection: the collection is the page. */
export function CollectionSpotlight({
  owner,
  c,
  versionCount,
  readme,
  sample,
}: {
  owner: string
  c: OrgCollection
  versionCount: number | null
  readme: string | null
  sample: { type: string; data: unknown } | null
}) {
  const types = typesOf(c)
  const excerpt = readmeExcerpt(readme)
  const excerptHtml = useMemo(() => (excerpt ? renderMarkdown(excerpt) : null), [excerpt])
  const stats: [string, string][] = []
  if (c.recordCount !== null) stats.push([n(c.recordCount), 'records'])
  if (types.length)
    stats.push([n(types.length), types.length === 1 ? 'record type' : 'record types'])
  if (c.latestVersion)
    stats.push([
      c.latestVersion,
      versionCount ? `${n(versionCount)} version${versionCount === 1 ? '' : 's'}` : 'version',
    ])
  if (c.totalBytes) stats.push([formatBytesFixed(c.totalBytes), 'size'])
  if (c.license) stats.push([c.license, 'license'])

  return (
    <article className="border-rule rounded-surface overflow-hidden border bg-white/40">
      <div className="flex flex-col gap-3 px-5 pt-6 pb-5 sm:px-8">
        <Tags tags={c.tags} />
        <div>
          <h2 className="text-2xl leading-tight font-bold tracking-tight sm:text-[28px]">
            <Link to={`/${owner}/${c.slug}`} className="text-ink hover:underline">
              {c.name}
            </Link>
          </h2>
          <p className="text-ink-muted mt-1 font-mono text-sm">
            {owner}/{c.slug}
            {!c.public && ' · Private'}
          </p>
        </div>
        {c.description && (
          <p className="text-ink-light max-w-2xl text-base leading-relaxed">{c.description}</p>
        )}
      </div>

      {stats.length > 0 && (
        <dl className="border-rule flex flex-wrap border-y">
          {stats.map(([value, label]) => (
            <div
              key={label}
              className="border-rule flex flex-[1_1_8rem] flex-col-reverse border-r px-5 py-4 last:border-r-0 sm:px-8"
            >
              <dt className="text-ink-muted text-xs">{label}</dt>
              <dd className="text-xl font-bold tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      )}

      {(types.length > 0 || sample) && (
        <div className="flex flex-wrap gap-7 px-5 py-6 sm:px-8">
          {types.length > 0 && (
            <div className="min-w-0 flex-[1_1_16rem]">
              <h3 className="text-ink-muted mb-3 text-xs font-semibold tracking-wide uppercase">
                Record types
              </h3>
              <ul className="flex flex-col gap-1.5">
                {types.slice(0, 8).map(([t, count]) => (
                  <li key={t} className="border-rule border-b border-dotted pb-1">
                    <div className="flex justify-between gap-2 text-[13px]">
                      <Link
                        to={`/${owner}/${c.slug}/records?type=${encodeURIComponent(t)}`}
                        className="text-ink font-mono hover:underline"
                      >
                        {t}
                      </Link>
                      <span className="tabular-nums">{n(count)}</span>
                    </div>
                  </li>
                ))}
              </ul>
              {types.length > 8 && (
                <p className="text-ink-muted mt-2 text-xs">and {types.length - 8} more types</p>
              )}
            </div>
          )}
          {sample && (
            <div className="min-w-0 flex-[1_1_18rem]">
              <h3 className="text-ink-muted mb-3 text-xs font-semibold tracking-wide uppercase">
                A record
              </h3>
              <pre className="bg-ink text-parchment rounded-surface max-h-80 overflow-auto px-4 py-3 font-mono text-xs leading-relaxed">
                {JSON.stringify({ type: sample.type, ...(sample.data as object) }, null, 2)}
              </pre>
              <Link
                to={`/${owner}/${c.slug}/records?type=${encodeURIComponent(sample.type)}`}
                className="text-link mt-2 inline-block text-sm hover:underline"
              >
                Browse all {n(c.typeCounts?.[sample.type] ?? 0)} {sample.type} records
              </Link>
            </div>
          )}
        </div>
      )}

      {excerptHtml && (
        <div className="px-5 pb-6 sm:px-8">
          <h3 className="text-ink-muted mb-2 text-xs font-semibold tracking-wide uppercase">
            From the readme
          </h3>
          <div
            className="prose prose-sm text-ink-light max-w-2xl"
            dangerouslySetInnerHTML={{ __html: excerptHtml }}
          />
          <Link
            to={`/${owner}/${c.slug}`}
            className="text-link mt-1 inline-block text-sm hover:underline"
          >
            Read the full readme
          </Link>
        </div>
      )}

      <div className="border-rule flex flex-wrap items-center gap-2 border-t px-5 py-4 sm:px-8">
        <ButtonLink to={`/${owner}/${c.slug}`}>Open collection</ButtonLink>
        {c.latestVersion && (
          <>
            <ButtonLink to={`/${owner}/${c.slug}/schemas`} variant="secondary">
              Schemas
            </ButtonLink>
            <ButtonLink to={`/${owner}/${c.slug}/versions`} variant="secondary">
              Versions
            </ButtonLink>
          </>
        )}
        {c.lastPushAt && (
          <span className="text-ink-muted ml-auto text-xs">
            Published {formatDate(c.lastPushAt)}
          </span>
        )}
      </div>
    </article>
  )
}

// ---------------------------------------------------------------- Sidebar

function SideHeading({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="text-ink-muted mb-2.5 text-xs font-semibold tracking-wide uppercase">
      {children}
    </h2>
  )
}

export function AboutSection({ bio }: { bio: string }) {
  const html = useMemo(() => renderMarkdown(bio), [bio])
  return (
    <section>
      <SideHeading>About</SideHeading>
      <div className="prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: html }} />
    </section>
  )
}

function CopyLine({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div>
      <div className="text-ink-light mb-1 text-xs font-medium">{label}</div>
      <div className="bg-ink text-parchment rounded-control flex items-center gap-1.5 py-1 pr-1 pl-2.5">
        <code className="min-w-0 flex-1 bg-transparent p-0 font-mono text-[11px] break-all text-inherit">
          {text}
        </code>
        <button
          type="button"
          aria-label={copied ? `Copied ${label}` : `Copy ${label}`}
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })
          }}
          className="bg-ink-light rounded-control flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center"
        >
          <Icon name={copied ? 'check' : 'copy'} />
        </button>
      </div>
    </div>
  )
}

export function UseThisData({
  owner,
  example,
  origin,
}: {
  owner: string
  example: OrgCollection | null
  origin: string
}) {
  return (
    <section>
      <SideHeading id="use">Use this data</SideHeading>
      <div className="flex flex-col gap-3">
        {example && (
          <CopyLine
            label="Command line"
            text={`underlay clone ${origin} ${owner}/${example.slug}`}
          />
        )}
        <CopyLine label="API" text={`GET ${origin}/api/accounts/${owner}/collections`} />
        <CopyLine label="AT Protocol" text={`at://did:web:underlay.org:${owner}`} />
        <p className="text-ink-muted text-xs">
          Every version has a permanent ARK for citation.{' '}
          <Link to="/docs" className="text-link hover:underline">
            Docs
          </Link>
        </p>
      </div>
    </section>
  )
}

export function MembersSection({
  owner,
  members,
  limit,
}: {
  owner: string
  members: OrgMember[]
  limit?: number
}) {
  const shown = limit ? members.slice(0, limit) : members
  return (
    <section>
      <SideHeading>Members</SideHeading>
      <ul className="flex flex-col gap-2">
        {shown.map((m, i) => (
          <li key={`${m.displayName}-${i}`} className="flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className="bg-parchment-dark border-rule flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-xs font-semibold"
            >
              {initials(m.displayName).slice(0, 2)}
            </span>
            <span className="min-w-0 truncate text-sm font-medium">
              {m.displayName}
              {m.you && <span className="text-ink-muted font-normal"> (you)</span>}
            </span>
            {/* Roles, and who is hidden, are shown to the org's own members only. */}
            {m.role && <span className="text-ink-muted ml-auto text-[11px]">{m.role}</span>}
            {m.public === false && <span className="text-ink-muted text-[11px]">hidden</span>}
          </li>
        ))}
      </ul>
      {limit && members.length > limit && (
        <Link
          to={`/${owner}?tab=members`}
          preventScrollReset
          className="text-link mt-2 inline-block text-xs hover:underline"
        >
          All {members.length} members
        </Link>
      )}
    </section>
  )
}

export function ActivityList({
  owner,
  activity,
  limit,
  heading = true,
}: {
  owner: string
  activity: OrgActivity[]
  limit?: number
  heading?: boolean
}) {
  const shown = limit ? activity.slice(0, limit) : activity
  return (
    <section>
      {heading && <SideHeading>Activity</SideHeading>}
      <ol>
        {shown.map((a) => (
          <li
            key={`${a.collectionSlug}@${a.semver}`}
            className="border-rule/60 border-b py-2 text-[13px]"
          >
            <div className="min-w-0">
              <div>
                <Link
                  to={`/${owner}/${a.collectionSlug}`}
                  className="text-ink font-medium hover:underline"
                >
                  {a.collectionName}
                </Link>{' '}
                <span className="text-ink-muted">{a.semver}</span>
              </div>
              <div className="text-ink-muted line-clamp-2 text-xs" title={a.message ?? undefined}>
                {formatDate(a.createdAt)} · {activityLine(a)}
              </div>
            </div>
          </li>
        ))}
      </ol>
      {limit && activity.length > limit && (
        <Link
          to={`/${owner}?tab=activity`}
          preventScrollReset
          className="text-link mt-2 inline-block text-xs hover:underline"
        >
          All activity
        </Link>
      )}
    </section>
  )
}

/** A version's message, or its record count when the message is only the push's default. */
function activityLine(a: OrgActivity): string {
  const records = `${n(a.recordCount)} ${a.recordCount === 1 ? 'record' : 'records'}`
  const first = a.message?.trim().split('\n')[0]?.trim()
  if (!first || /^Push \d+ records?$/.test(first)) return records
  return first
}

export function NoCollections({ member, owner }: { member: boolean; owner: string }) {
  return (
    <EmptyState>
      {member ? (
        <>
          No collections yet.{' '}
          <Link to={`/new?owner=${owner}`} className="text-link hover:underline">
            Create the first one
          </Link>
          .
        </>
      ) : (
        'No public collections yet.'
      )}
    </EmptyState>
  )
}
