/**
 * The pieces of an organization's page (`/:owner`): its header, the collections it pinned,
 * the list of all its collections, and the sidebar. Every org's page has that same shape;
 * only search, sort and topic filters wait until there are enough collections to need them.
 */
import { useMemo, useState } from 'react'
import { Link } from 'react-router'

import { ButtonLink, EmptyState, Input, Select } from '~/components/ui'
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
  coverImageUrl: string | null
  coverTint: boolean
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

/**
 * An org's logo, the same tile everywhere it shows: a white rounded square with a thin
 * rule, holding the uploaded image or, without one, the org's initials in its cover
 * color. `size` sets the box and the initials' type; the corners scale with it.
 */
export function OrgLogo({
  account,
  size,
  className = '',
}: {
  account: Pick<OrgAccount, 'avatarUrl' | 'displayName' | 'slug' | 'coverColor'>
  size: 'xs' | 'sm' | 'md' | 'lg'
  className?: string
}) {
  const box = {
    xs: 'h-5 w-5 rounded-[4px] text-[8px]',
    sm: 'h-10 w-10 rounded-[8px] text-xs',
    md: 'h-16 w-16 rounded-[12px] text-lg',
    lg: 'h-24 w-24 rounded-[16px] text-2xl sm:h-28 sm:w-28 sm:text-3xl',
  }[size]
  const tile = `border-rule shrink-0 overflow-hidden border bg-white ${box} ${className}`
  if (account.avatarUrl)
    return (
      <img src={account.avatarUrl} alt={account.displayName} className={`${tile} object-cover`} />
    )
  return (
    <div
      aria-hidden="true"
      className={`${tile} flex items-center justify-center font-bold tracking-wide`}
      style={{ color: coverColorFor(account) }}
    >
      {initials(account.displayName)}
    </div>
  )
}

// ---------------------------------------------------------------- Header

/**
 * The band across the top of the page: the cover color, with the org's image over it.
 * Tinted, the image takes the color's hue and keeps its own light and dark (a duotone),
 * so any photo sits with the page and the logo stays readable over it.
 */
export function Cover({
  account,
  className = '',
}: {
  account: Pick<OrgAccount, 'slug' | 'coverColor' | 'coverImageUrl' | 'coverTint'>
  className?: string
}) {
  return (
    <div
      aria-hidden="true"
      className={`relative overflow-hidden ${className}`}
      style={{ backgroundColor: coverColorFor(account) }}
    >
      {account.coverImageUrl && (
        <img
          src={account.coverImageUrl}
          alt=""
          className={`absolute inset-0 h-full w-full object-cover ${
            account.coverTint ? 'opacity-80 mix-blend-luminosity' : ''
          }`}
        />
      )}
    </div>
  )
}

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
  /** What the org holds (orgSummary): records and size. */
  summary: string[]
}) {
  return (
    <section className="border-rule border-b">
      <Cover account={account} className="h-28 sm:h-40" />
      <div className="mx-auto max-w-5xl px-4">
        {/* The logo straddles the cover's edge; the name sits on the logo's baseline, so the
            two read as one block, and everything below shares the logo's left edge. */}
        <div className="-mt-6 flex items-end gap-4 sm:-mt-8 sm:gap-5">
          <OrgLogo account={account} size="lg" className="ring-parchment relative z-10 ring-4" />
          <div className="min-w-0 flex-1 pb-1">
            <h1 className="truncate text-2xl leading-tight font-bold tracking-tight sm:text-3xl">
              {account.displayName}
            </h1>
            <p className="text-ink-muted font-mono text-sm leading-6">@{account.slug}</p>
          </div>
          {canManage && (
            <ButtonLink to={`/${account.slug}/settings`} variant="secondary" className="mb-2">
              Settings
            </ButtonLink>
          )}
        </div>

        {account.tagline && (
          <p className="mt-5 max-w-2xl text-lg leading-snug">{account.tagline}</p>
        )}

        {/* One line of plain facts, one separator, no icons. */}
        <p
          className={`text-ink-light flex flex-wrap items-center gap-x-2 gap-y-1 text-sm ${account.tagline ? 'mt-2' : 'mt-5'}`}
        >
          {[
            account.location,
            account.website ? (
              <a
                key="website"
                href={account.website}
                target="_blank"
                rel="noopener noreferrer"
                className="text-link hover:underline"
              >
                {account.website.replace(/^https?:\/\//, '').replace(/\/$/, '')}
              </a>
            ) : null,
            `Joined ${formatDate(account.createdAt, 'month')}`,
            ...summary,
          ]
            .filter(Boolean)
            .map((item, i, all) => (
              // The dot follows its item, so a wrapped line starts with a fact, not a dot.
              <span key={i} className="inline-flex items-center gap-x-2">
                {item}
                {i < all.length - 1 && (
                  <span aria-hidden="true" className="text-ink-muted">
                    ·
                  </span>
                )}
              </span>
            ))}
        </p>

        {account.provenanceNote && (
          <p className="text-ink-muted mt-1.5 text-xs">{account.provenanceNote}</p>
        )}

        <nav aria-label="Organization" className="-mx-3 mt-6 -mb-px flex gap-1 overflow-x-auto">
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

function Icon({ name }: { name: 'copy' | 'check' }) {
  const paths = {
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

/** "2,038,025 records", "1.1 GiB": what the org holds. The collection count is on its tab. */
export function orgSummary(collections: OrgCollection[]): string[] {
  const records = collections.reduce((s, c) => s + (c.recordCount ?? 0), 0)
  const bytes = collections.reduce((s, c) => s + (c.totalBytes ?? 0), 0)
  if (!records) return []
  return [`${n(records)} ${records === 1 ? 'record' : 'records'}`, formatBytesFixed(bytes)]
}

// ---------------------------------------------------------------- Collections

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
        {/* Its record types, on one line; topics are the filters above. */}
        {types.length > 0 && (
          <p className="text-ink-muted mt-2 truncate font-mono text-[11px]">
            {types
              .slice(0, 4)
              .map(([t, count]) => `${t} ${n(count)}`)
              .join(' · ')}
            {types.length > 4 ? ` · +${types.length - 4} more` : ''}
          </p>
        )}
      </div>
      <div className="flex min-w-0 flex-[1_1_14rem] flex-col gap-0.5 text-sm sm:text-right">
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

/** Every collection, as a list; with search, sort and topic filters when `controls`. */
export function CollectionsBrowser({
  owner,
  collections,
  newCollection,
  controls,
}: {
  owner: string
  collections: OrgCollection[]
  newCollection: boolean
  /** Search, sort and topic filters: for an org with enough collections to need them. */
  controls: boolean
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
    `inline-flex h-7 shrink-0 items-center gap-1 rounded-full border px-2.5 text-xs transition-colors ${
      on
        ? 'border-ink bg-ink text-parchment'
        : 'border-rule text-ink-light hover:text-ink hover:bg-parchment-dark'
    }`
  const filtered = shown.length !== collections.length

  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-ink-muted text-xs font-semibold tracking-wide uppercase">
          All collections
        </h2>
        {newCollection && (
          <ButtonLink to={`/new?owner=${owner}`} size="sm" variant="secondary">
            New collection
          </ButtonLink>
        )}
      </div>
      {/* Search and sort on one line; the topics one row under them, scrolling sideways
          when there are many, so the controls never outgrow the list. */}
      {controls && (
        <div className="flex gap-2">
          <label htmlFor="org-search" className="sr-only">
            Search collections
          </label>
          <Input
            id="org-search"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search collections"
            className="min-w-0 flex-1"
          />
          <div className="w-40 shrink-0">
            <label htmlFor="org-sort" className="sr-only">
              Sort
            </label>
            <Select id="org-sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
              <option value="records">Most records</option>
              <option value="recent">Recently published</option>
              <option value="name">Name</option>
            </Select>
          </div>
        </div>
      )}
      {controls && topics.length > 0 && (
        <div
          role="group"
          aria-label="Topic"
          className="mt-3 flex [scrollbar-width:none] gap-1.5 overflow-x-auto [mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)] pr-8 [&::-webkit-scrollbar]:hidden"
        >
          <button
            type="button"
            className={chip(topic === null)}
            aria-pressed={topic === null}
            onClick={() => setTopic(null)}
          >
            All
          </button>
          {topics.map(([t, count]) => (
            <button
              key={t}
              type="button"
              className={chip(topic === t)}
              aria-pressed={topic === t}
              onClick={() => setTopic(topic === t ? null : t)}
            >
              {tagLabel(t)} <span className="opacity-60">{count}</span>
            </button>
          ))}
        </div>
      )}
      <div className={`border-rule border-t ${controls ? 'mt-4' : ''}`}>
        {filtered && (
          <p className="text-ink-muted border-rule border-b py-2 text-xs">
            Showing {shown.length} of {collections.length}
          </p>
        )}
        {shown.map((c) => (
          <CollectionRow key={c.id} owner={owner} c={c} />
        ))}
        {shown.length === 0 && (
          <p className="border-rule text-ink-muted border-b py-6 text-sm">
            No collections match. Clear the search or pick another topic.
          </p>
        )}
      </div>
    </section>
  )
}

/**
 * The collections an org pinned, as small cards above its list: a name, a line of
 * description, and what it holds. The whole card is the link.
 */
export function PinnedCards({
  owner,
  collections,
}: {
  owner: string
  collections: OrgCollection[]
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {collections.map((c) => (
        <Link
          key={c.id}
          to={`/${owner}/${c.slug}`}
          className="border-rule rounded-surface hover:border-ink-muted/60 flex min-w-0 flex-col gap-1 border bg-white/40 px-4 py-3 no-underline transition-colors"
        >
          <span className="text-ink truncate text-[15px] leading-snug font-semibold">{c.name}</span>
          {c.description && (
            <span className="text-ink-light line-clamp-2 text-[13px] leading-snug">
              {c.description}
            </span>
          )}
          {c.recordCount !== null && (
            <span className="text-ink-muted mt-auto pt-1 text-xs">
              {n(c.recordCount)} {c.recordCount === 1 ? 'record' : 'records'}
              {c.totalBytes ? ` · ${formatBytesFixed(c.totalBytes)}` : ''}
            </span>
          )}
        </Link>
      ))}
    </div>
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
      <div className="bg-parchment-dark/60 border-rule rounded-control flex items-center gap-1.5 border py-1 pr-1 pl-2.5">
        <code className="text-ink min-w-0 flex-1 bg-transparent p-0 font-mono text-[11px] break-all">
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
          className="text-ink-muted hover:text-ink hover:bg-parchment rounded-control flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center transition-colors"
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
