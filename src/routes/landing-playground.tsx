import { useState } from 'react'
import { Link } from 'react-router'

import BaseLayout from '~/components/BaseLayout'

/* ------------------------------------------------------------------ */
/*  Mock data — what Underlay looks like with hundreds of publishers   */
/* ------------------------------------------------------------------ */

const STATS = {
  collections: 1_247,
  records: 48_300_000,
  versions: 8_932,
  organizations: 214,
  schemas: 389,
  mirrors: 12,
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

interface MockCollection {
  slug: string
  org: string
  orgSlug: string
  title: string
  domain: string
  records: number
  versions: number
  lastPush: string
  description: string
  schemas: string[]
}

const COLLECTIONS: MockCollection[] = [
  {
    slug: 'crossref-metadata',
    org: 'Crossref',
    orgSlug: 'crossref',
    title: 'Crossref Metadata Registry',
    domain: 'Scholarly Publishing',
    records: 14_200_000,
    versions: 892,
    lastPush: '2 hours ago',
    description:
      'Complete DOI metadata for journal articles, conference papers, books, and preprints.',
    schemas: ['work', 'funder', 'member', 'license'],
  },
  {
    slug: 'openalex-works',
    org: 'OpenAlex',
    orgSlug: 'openalex',
    title: 'OpenAlex Works',
    domain: 'Scholarly Publishing',
    records: 9_800_000,
    versions: 1_204,
    lastPush: '45 minutes ago',
    description:
      'Scholarly works with citation graphs, author affiliations, and topic classifications.',
    schemas: ['work', 'author', 'institution', 'topic'],
  },
  {
    slug: 'gbif-occurrences',
    org: 'GBIF',
    orgSlug: 'gbif',
    title: 'GBIF Species Occurrences',
    domain: 'Biodiversity',
    records: 6_300_000,
    versions: 341,
    lastPush: '6 hours ago',
    description:
      'Georeferenced species occurrence records from natural history collections worldwide.',
    schemas: ['occurrence', 'taxon', 'dataset', 'institution'],
  },
  {
    slug: 'clinical-trials',
    org: 'NIH',
    orgSlug: 'nih',
    title: 'ClinicalTrials.gov',
    domain: 'Medicine',
    records: 4_100_000,
    versions: 2_178,
    lastPush: '1 hour ago',
    description:
      'Registry of clinical studies with protocols, outcomes, and adverse event reports.',
    schemas: ['study', 'intervention', 'outcome', 'sponsor'],
  },
  {
    slug: 'wikidata-entities',
    org: 'Wikimedia Foundation',
    orgSlug: 'wikimedia',
    title: 'Wikidata Entities',
    domain: 'General Knowledge',
    records: 5_700_000,
    versions: 3_412,
    lastPush: '12 minutes ago',
    description:
      'Structured knowledge base entries with multilingual labels, claims, and references.',
    schemas: ['entity', 'property', 'qualifier', 'reference'],
  },
  {
    slug: 'iucn-red-list',
    org: 'IUCN',
    orgSlug: 'iucn',
    title: 'IUCN Red List',
    domain: 'Biodiversity',
    records: 420_000,
    versions: 89,
    lastPush: '3 days ago',
    description: 'Conservation status assessments for animal, plant, and fungal species globally.',
    schemas: ['assessment', 'taxon', 'threat', 'habitat'],
  },
  {
    slug: 'usda-nutrient-db',
    org: 'USDA',
    orgSlug: 'usda',
    title: 'USDA Nutrient Database',
    domain: 'Agriculture & Food',
    records: 890_000,
    versions: 156,
    lastPush: '1 week ago',
    description:
      'Nutrient composition data for foods, including branded products and standard reference items.',
    schemas: ['food', 'nutrient', 'portion', 'source'],
  },
  {
    slug: 'noaa-ghcn',
    org: 'NOAA',
    orgSlug: 'noaa',
    title: 'Global Historical Climatology Network',
    domain: 'Climate & Environment',
    records: 2_100_000,
    versions: 412,
    lastPush: '4 hours ago',
    description:
      'Daily temperature, precipitation, and weather observations from land-based stations.',
    schemas: ['station', 'observation', 'quality-flag'],
  },
  {
    slug: 'european-medicines',
    org: 'EMA',
    orgSlug: 'ema',
    title: 'European Medicines Registry',
    domain: 'Medicine',
    records: 310_000,
    versions: 234,
    lastPush: '2 days ago',
    description:
      'Authorized medicines in the EU with safety profiles, indications, and regulatory history.',
    schemas: ['medicine', 'substance', 'indication', 'safety-report'],
  },
  {
    slug: 'arxiv-papers',
    org: 'arXiv',
    orgSlug: 'arxiv',
    title: 'arXiv Preprint Archive',
    domain: 'Scholarly Publishing',
    records: 3_200_000,
    versions: 567,
    lastPush: '30 minutes ago',
    description: 'Preprint metadata with abstracts, author lists, categories, and citation links.',
    schemas: ['paper', 'author', 'category'],
  },
  {
    slug: 'world-bank-indicators',
    org: 'World Bank',
    orgSlug: 'worldbank',
    title: 'World Development Indicators',
    domain: 'Economics',
    records: 1_450_000,
    versions: 198,
    lastPush: '5 days ago',
    description:
      'Time-series development indicators for 217 economies: GDP, poverty, education, health.',
    schemas: ['indicator', 'country', 'observation'],
  },
  {
    slug: 'museum-collections',
    org: 'Smithsonian',
    orgSlug: 'smithsonian',
    title: 'Smithsonian Open Access',
    domain: 'Cultural Heritage',
    records: 1_800_000,
    versions: 45,
    lastPush: '2 weeks ago',
    description:
      'Digitized museum objects across art, natural history, and cultural heritage collections.',
    schemas: ['object', 'media', 'place', 'person'],
  },
]

interface ActivityItem {
  type: 'push' | 'new-collection' | 'new-org' | 'fork' | 'schema'
  org: string
  orgSlug: string
  collection?: string
  collectionSlug?: string
  message?: string
  records?: number
  time: string
  version?: string
}

const ACTIVITY: ActivityItem[] = [
  {
    type: 'push',
    org: 'Wikidata',
    orgSlug: 'wikimedia',
    collection: 'Wikidata Entities',
    collectionSlug: 'wikidata-entities',
    message: 'Weekly entity sync — 12,847 new items, 34,201 updated claims',
    records: 47_048,
    time: '12 min ago',
    version: 'v3412',
  },
  {
    type: 'push',
    org: 'OpenAlex',
    orgSlug: 'openalex',
    collection: 'OpenAlex Works',
    collectionSlug: 'openalex-works',
    message: 'June 2026 snapshot — added 143K new works',
    records: 143_000,
    time: '45 min ago',
    version: 'v1204',
  },
  {
    type: 'new-collection',
    org: 'Max Planck Digital Library',
    orgSlug: 'mpdl',
    collection: 'PURE Publication Records',
    collectionSlug: 'pure-publications',
    time: '1 hour ago',
  },
  {
    type: 'push',
    org: 'NIH',
    orgSlug: 'nih',
    collection: 'ClinicalTrials.gov',
    collectionSlug: 'clinical-trials',
    message: 'Added 287 new study registrations',
    records: 287,
    time: '1 hour ago',
    version: 'v2178',
  },
  {
    type: 'fork',
    org: 'MIT Libraries',
    orgSlug: 'mit-libraries',
    collection: 'Crossref Metadata Registry',
    collectionSlug: 'crossref-metadata',
    time: '2 hours ago',
  },
  {
    type: 'push',
    org: 'Crossref',
    orgSlug: 'crossref',
    collection: 'Crossref Metadata Registry',
    collectionSlug: 'crossref-metadata',
    message: 'Daily DOI registration sync',
    records: 8_412,
    time: '2 hours ago',
    version: 'v892',
  },
  {
    type: 'schema',
    org: 'GBIF',
    orgSlug: 'gbif',
    collection: 'GBIF Species Occurrences',
    collectionSlug: 'gbif-occurrences',
    message: 'Updated occurrence schema — added coordinateUncertaintyInMeters field',
    time: '3 hours ago',
  },
  {
    type: 'new-org',
    org: 'Allen Institute for AI',
    orgSlug: 'allenai',
    time: '4 hours ago',
  },
  {
    type: 'push',
    org: 'NOAA',
    orgSlug: 'noaa',
    collection: 'Global Historical Climatology Network',
    collectionSlug: 'noaa-ghcn',
    message: 'Q2 2026 station observations',
    records: 24_000,
    time: '4 hours ago',
    version: 'v412',
  },
  {
    type: 'push',
    org: 'arXiv',
    orgSlug: 'arxiv',
    collection: 'arXiv Preprint Archive',
    collectionSlug: 'arxiv-papers',
    message: 'Daily submission batch — 1,204 new preprints',
    records: 1_204,
    time: '30 min ago',
    version: 'v567',
  },
]

interface Domain {
  name: string
  collections: number
  records: number
  color: string
}

const DOMAINS: Domain[] = [
  { name: 'Scholarly Publishing', collections: 312, records: 27_200_000, color: 'bg-blue-100' },
  { name: 'Biodiversity', collections: 187, records: 6_720_000, color: 'bg-green-100' },
  { name: 'Medicine', collections: 156, records: 4_410_000, color: 'bg-red-100' },
  { name: 'Climate & Environment', collections: 134, records: 3_800_000, color: 'bg-cyan-100' },
  { name: 'Economics', collections: 98, records: 2_100_000, color: 'bg-amber-100' },
  { name: 'Cultural Heritage', collections: 87, records: 1_950_000, color: 'bg-purple-100' },
  { name: 'Agriculture & Food', collections: 73, records: 1_200_000, color: 'bg-lime-100' },
  { name: 'General Knowledge', collections: 64, records: 5_700_000, color: 'bg-orange-100' },
  { name: 'Governance & Policy', collections: 52, records: 420_000, color: 'bg-slate-100' },
  { name: 'Education', collections: 41, records: 380_000, color: 'bg-pink-100' },
  { name: 'Transportation', collections: 28, records: 210_000, color: 'bg-teal-100' },
  { name: 'Energy', collections: 15, records: 160_000, color: 'bg-yellow-100' },
]

const TABS = ['Hybrid', 'Reading Room', 'Atlas', 'Activity Feed', 'Reference Desk'] as const
type Tab = (typeof TABS)[number]

/* ------------------------------------------------------------------ */
/*  Scale bar — shows global stats                                     */
/* ------------------------------------------------------------------ */

function ScaleBar() {
  return (
    <div className="border-rule flex flex-wrap items-baseline gap-x-8 gap-y-1 border-b py-3 font-mono text-xs">
      <span>
        <span className="text-ink font-semibold">{fmt(STATS.records)}</span>{' '}
        <span className="text-ink-muted">records</span>
      </span>
      <span>
        <span className="text-ink font-semibold">{fmt(STATS.collections)}</span>{' '}
        <span className="text-ink-muted">collections</span>
      </span>
      <span>
        <span className="text-ink font-semibold">{fmt(STATS.versions)}</span>{' '}
        <span className="text-ink-muted">versions</span>
      </span>
      <span>
        <span className="text-ink font-semibold">{STATS.organizations}</span>{' '}
        <span className="text-ink-muted">organizations</span>
      </span>
      <span>
        <span className="text-ink font-semibold">{STATS.schemas}</span>{' '}
        <span className="text-ink-muted">schemas</span>
      </span>
      <span>
        <span className="text-ink font-semibold">{STATS.mirrors}</span>{' '}
        <span className="text-ink-muted">mirrors</span>
      </span>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Concept 1: Reading Room — curated domain categories                */
/* ------------------------------------------------------------------ */

function ReadingRoom() {
  return (
    <div>
      {/* Hero */}
      <section className="py-12">
        <div className="max-w-2xl">
          <h1 className="mb-3 font-serif text-3xl font-normal tracking-tight italic">
            The world's structured knowledge,
            <br />
            open and preserved.
          </h1>
          <p className="text-ink-muted text-sm leading-relaxed">
            {fmt(STATS.records)} records across {fmt(STATS.collections)} collections — published by{' '}
            {STATS.organizations} organizations, verified by {STATS.mirrors} independent mirrors.
            Browse by domain or explore what's new.
          </p>
        </div>
      </section>

      <ScaleBar />

      {/* Domain cards — like museum wings */}
      <section className="py-8">
        <h2 className="text-ink-muted mb-5 text-xs font-semibold tracking-widest uppercase">
          Browse by Domain
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {DOMAINS.slice(0, 9).map((d) => (
            <Link
              key={d.name}
              to="/explore"
              className="border-rule group block border p-4 transition-colors hover:bg-stone-50"
            >
              <div className="mb-2 flex items-baseline justify-between">
                <h3 className="text-sm font-semibold">{d.name}</h3>
                <span className="text-ink-muted font-mono text-xs">{d.collections}</span>
              </div>
              <div className="text-ink-muted text-xs">
                {fmt(d.records)} records across {d.collections} collections
              </div>
              {/* Proportional bar */}
              <div className="mt-2 h-1 w-full overflow-hidden rounded bg-stone-100">
                <div
                  className={`h-full rounded ${d.color.replace('100', '300')}`}
                  style={{ width: `${Math.min(100, (d.records / 27_200_000) * 100)}%` }}
                />
              </div>
            </Link>
          ))}
        </div>
        <div className="mt-4 text-center">
          <Link to="/explore" className="text-ink-muted text-xs hover:underline">
            View all {DOMAINS.length} domains
          </Link>
        </div>
      </section>

      {/* Featured collections — the "exhibition hall" */}
      <section className="border-rule border-t py-8">
        <h2 className="text-ink-muted mb-5 text-xs font-semibold tracking-widest uppercase">
          Featured Collections
        </h2>
        <div className="space-y-3">
          {COLLECTIONS.slice(0, 5).map((c) => (
            <CollectionRow key={c.slug} collection={c} />
          ))}
        </div>
      </section>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Concept 2: Atlas — visual mosaic of scale                          */
/* ------------------------------------------------------------------ */

function Atlas() {
  const maxRecords = Math.max(...DOMAINS.map((d) => d.records))
  const totalRecords = DOMAINS.reduce((s, d) => s + d.records, 0)

  return (
    <div>
      <section className="py-12">
        <h1 className="mb-3 text-3xl font-semibold tracking-tight">Atlas of Open Knowledge</h1>
        <p className="text-ink-muted max-w-xl text-sm leading-relaxed">
          A map of every structured dataset in Underlay, sized by scale. Click any region to explore
          its collections.
        </p>
      </section>

      <ScaleBar />

      {/* Treemap-style mosaic */}
      <section className="py-8">
        <h2 className="text-ink-muted mb-5 text-xs font-semibold tracking-widest uppercase">
          Knowledge Mosaic
        </h2>
        <div className="grid auto-rows-[80px] grid-cols-6 gap-1.5">
          {DOMAINS.map((d) => {
            const fraction = d.records / totalRecords
            const span = Math.max(1, Math.round(fraction * 12))
            return (
              <Link
                key={d.name}
                to="/explore"
                className={`${d.color} group relative flex flex-col justify-end overflow-hidden rounded p-3 transition-all hover:brightness-95`}
                style={{ gridColumn: `span ${Math.min(span, 4)}` }}
              >
                <div className="text-xs font-semibold text-stone-700">{d.name}</div>
                <div className="font-mono text-xs text-stone-500">{fmt(d.records)} records</div>
              </Link>
            )
          })}
        </div>
      </section>

      {/* Top collections by size */}
      <section className="border-rule border-t py-8">
        <h2 className="text-ink-muted mb-5 text-xs font-semibold tracking-widest uppercase">
          Largest Collections
        </h2>
        <div className="space-y-2">
          {[...COLLECTIONS]
            .sort((a, b) => b.records - a.records)
            .slice(0, 8)
            .map((c) => (
              <Link
                key={c.slug}
                to={`/${c.orgSlug}/${c.slug}`}
                className="border-rule group flex items-center gap-4 border p-3 transition-colors hover:bg-stone-50"
              >
                <div className="flex-1">
                  <div className="text-sm font-semibold">{c.title}</div>
                  <div className="text-ink-muted text-xs">
                    {c.org} · {c.domain}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="h-2 w-24 overflow-hidden rounded bg-stone-100">
                    <div
                      className="h-full rounded bg-stone-400"
                      style={{ width: `${(c.records / maxRecords) * 100}%` }}
                    />
                  </div>
                  <span className="w-16 text-right font-mono text-xs">{fmt(c.records)}</span>
                </div>
              </Link>
            ))}
        </div>
      </section>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Concept 3: Activity Feed — living archive                          */
/* ------------------------------------------------------------------ */

function ActivityFeed() {
  return (
    <div>
      <section className="py-12">
        <h1 className="mb-3 text-3xl font-semibold tracking-tight">A Living Archive</h1>
        <p className="text-ink-muted max-w-xl text-sm leading-relaxed">
          Knowledge doesn't sit still. Watch as organizations around the world publish, update, and
          preserve structured data in real time.
        </p>
      </section>

      <ScaleBar />

      {/* Feed */}
      <section className="py-8">
        <h2 className="text-ink-muted mb-5 text-xs font-semibold tracking-widest uppercase">
          Recent Activity
        </h2>
        <div className="space-y-0">
          {ACTIVITY.map((a, i) => (
            <ActivityRow key={i} item={a} />
          ))}
        </div>
      </section>

      {/* Active publishers */}
      <section className="border-rule border-t py-8">
        <h2 className="text-ink-muted mb-5 text-xs font-semibold tracking-widest uppercase">
          Most Active This Week
        </h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {[
            { org: 'Wikidata', pushes: 47, records: '312K' },
            { org: 'OpenAlex', pushes: 31, records: '1.2M' },
            { org: 'Crossref', pushes: 28, records: '89K' },
            { org: 'arXiv', pushes: 21, records: '8.4K' },
            { org: 'NIH', pushes: 18, records: '4.2K' },
            { org: 'NOAA', pushes: 14, records: '67K' },
            { org: 'GBIF', pushes: 9, records: '240K' },
            { org: 'World Bank', pushes: 4, records: '12K' },
          ].map((p) => (
            <div key={p.org} className="border-rule border p-3">
              <div className="text-sm font-semibold">{p.org}</div>
              <div className="text-ink-muted mt-1 font-mono text-xs">
                {p.pushes} pushes · {p.records} records
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Concept 4: Reference Desk — guided entry by visitor type           */
/* ------------------------------------------------------------------ */

function ReferenceDesk() {
  return (
    <div>
      <section className="py-12">
        <h1 className="mb-3 text-3xl font-semibold tracking-tight">What are you looking for?</h1>
        <p className="text-ink-muted max-w-xl text-sm leading-relaxed">
          Underlay holds {fmt(STATS.records)} structured records from {STATS.organizations}{' '}
          organizations. Here are a few ways in.
        </p>
      </section>

      <ScaleBar />

      {/* Entry paths */}
      <section className="py-8">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Link
            to="/explore"
            className="border-rule group border p-6 transition-colors hover:bg-stone-50"
          >
            <div className="mb-1 font-mono text-xs text-stone-400">For researchers</div>
            <h3 className="mb-2 text-lg font-semibold">Find a dataset</h3>
            <p className="text-ink-muted text-sm leading-relaxed">
              Search across {fmt(STATS.collections)} collections by topic, schema type, or
              publisher. Every version is citable and hash-verified.
            </p>
            <div className="text-ink-muted mt-3 text-xs group-hover:underline">
              Browse collections
            </div>
          </Link>

          <Link
            to="/docs/quickstart"
            className="border-rule group border p-6 transition-colors hover:bg-stone-50"
          >
            <div className="mb-1 font-mono text-xs text-stone-400">For publishers</div>
            <h3 className="mb-2 text-lg font-semibold">Publish your data</h3>
            <p className="text-ink-muted text-sm leading-relaxed">
              Push versioned snapshots of structured data via API. Define schemas, add records, and
              create permanent, verifiable archives.
            </p>
            <div className="text-ink-muted mt-3 text-xs group-hover:underline">
              Read the quickstart
            </div>
          </Link>

          <Link
            to="/docs/integration"
            className="border-rule group border p-6 transition-colors hover:bg-stone-50"
          >
            <div className="mb-1 font-mono text-xs text-stone-400">For developers</div>
            <h3 className="mb-2 text-lg font-semibold">Build on open data</h3>
            <p className="text-ink-muted text-sm leading-relaxed">
              Pull snapshots via REST API, run SQL queries over any collection, fork and extend
              datasets. Content-addressed and diff-friendly.
            </p>
            <div className="text-ink-muted mt-3 text-xs group-hover:underline">API reference</div>
          </Link>

          <Link
            to="/docs/concepts"
            className="border-rule group border p-6 transition-colors hover:bg-stone-50"
          >
            <div className="mb-1 font-mono text-xs text-stone-400">For institutions</div>
            <h3 className="mb-2 text-lg font-semibold">Run a mirror</h3>
            <p className="text-ink-muted text-sm leading-relaxed">
              Deploy your own Underlay instance. Mirror collections for preservation, publish
              privately, or run an internal knowledge registry.
            </p>
            <div className="text-ink-muted mt-3 text-xs group-hover:underline">
              Learn about mirrors
            </div>
          </Link>
        </div>
      </section>

      {/* Example use cases */}
      <section className="border-rule border-t py-8">
        <h2 className="text-ink-muted mb-5 text-xs font-semibold tracking-widest uppercase">
          What People Are Doing
        </h2>
        <div className="space-y-4 text-sm">
          {[
            {
              quote:
                'We publish our entire metadata registry to Underlay weekly. 14 million DOI records, fully versioned — any researcher can verify the exact state at any point in time.',
              who: 'Crossref',
            },
            {
              quote:
                "Our lab pulls biodiversity occurrence data from GBIF's Underlay collection. The hash verification means we can cite the exact snapshot our analysis used, and anyone can reproduce it.",
              who: 'University of Oxford, Dept. of Zoology',
            },
            {
              quote:
                'We run a mirror in Singapore. All 48 million records, independently verified. If the primary goes down, the data persists.',
              who: 'NUS Libraries',
            },
          ].map((t, i) => (
            <blockquote key={i} className="border-rule border-l-2 pl-4">
              <p className="text-ink-muted leading-relaxed italic">"{t.quote}"</p>
              <cite className="text-ink mt-1 block text-xs font-semibold not-italic">
                — {t.who}
              </cite>
            </blockquote>
          ))}
        </div>
      </section>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Hybrid: Reading Room + Activity Feed (recommended)                 */
/* ------------------------------------------------------------------ */

function Hybrid() {
  return (
    <div>
      {/* Hero — warm, institutional, with scale */}
      <section className="py-12">
        <div className="max-w-2xl">
          <h1 className="mb-4 text-3xl font-semibold tracking-tight">
            The public registry for
            <br />
            structured knowledge.
          </h1>
          <p className="text-ink-muted mb-6 text-sm leading-relaxed">
            {fmt(STATS.records)} records across {fmt(STATS.collections)} collections — published by
            research institutions, government agencies, and open data organizations. Versioned,
            verified, and preserved indefinitely.
          </p>
          <div className="flex gap-3">
            <Link
              to="/explore"
              className="bg-ink text-parchment visited:text-parchment hover:bg-ink-light inline-block rounded px-5 py-2.5 text-sm font-medium transition-colors"
            >
              Explore collections
            </Link>
            <Link
              to="/docs/quickstart"
              className="border-ink hover:bg-parchment-dark visited:text-ink inline-block rounded border px-5 py-2.5 text-sm font-medium transition-colors"
            >
              Start publishing
            </Link>
          </div>
        </div>
      </section>

      <ScaleBar />

      {/* Two-column: domains + activity */}
      <section className="py-8">
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-5">
          {/* Left: domain browsing */}
          <div className="lg:col-span-3">
            <h2 className="text-ink-muted mb-4 text-xs font-semibold tracking-widest uppercase">
              Browse by Domain
            </h2>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {DOMAINS.slice(0, 8).map((d) => (
                <Link
                  key={d.name}
                  to="/explore"
                  className="border-rule group flex items-baseline justify-between border p-3 transition-colors hover:bg-stone-50"
                >
                  <div>
                    <div className="text-sm font-semibold">{d.name}</div>
                    <div className="text-ink-muted text-xs">
                      {d.collections} collections · {fmt(d.records)} records
                    </div>
                  </div>
                  <span className="text-ink-muted font-mono text-xs opacity-0 group-hover:opacity-100">
                    &rarr;
                  </span>
                </Link>
              ))}
            </div>
            <Link
              to="/explore"
              className="text-ink-muted mt-3 inline-block text-xs hover:underline"
            >
              All {DOMAINS.length} domains
            </Link>
          </div>

          {/* Right: live activity */}
          <div className="lg:col-span-2">
            <h2 className="text-ink-muted mb-4 text-xs font-semibold tracking-widest uppercase">
              Recent Activity
            </h2>
            <div className="space-y-0">
              {ACTIVITY.slice(0, 7).map((a, i) => (
                <ActivityRowCompact key={i} item={a} />
              ))}
            </div>
            <Link
              to="/explore"
              className="text-ink-muted mt-3 inline-block text-xs hover:underline"
            >
              View all activity
            </Link>
          </div>
        </div>
      </section>

      {/* Featured collections */}
      <section className="border-rule border-t py-8">
        <h2 className="text-ink-muted mb-4 text-xs font-semibold tracking-widest uppercase">
          Featured Collections
        </h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {COLLECTIONS.slice(0, 6).map((c) => (
            <Link
              key={c.slug}
              to={`/${c.orgSlug}/${c.slug}`}
              className="border-rule group border p-4 transition-colors hover:bg-stone-50"
            >
              <div className="mb-1 flex items-baseline justify-between">
                <h3 className="text-sm font-semibold group-hover:underline">{c.title}</h3>
                <span className="text-ink-muted font-mono text-xs">{fmt(c.records)}</span>
              </div>
              <div className="text-ink-muted mb-2 text-xs">
                {c.org} · {c.domain} · {c.versions} versions
              </div>
              <p className="text-ink-muted text-xs leading-relaxed">{c.description}</p>
              <div className="mt-2 flex gap-1">
                {c.schemas.map((s) => (
                  <span key={s} className="bg-parchment-dark rounded px-1.5 py-0.5 text-[10px]">
                    {s}
                  </span>
                ))}
              </div>
            </Link>
          ))}
        </div>
      </section>

      {/* Entry points by visitor type */}
      <section className="border-rule border-t py-8">
        <div className="grid grid-cols-1 gap-6 text-sm md:grid-cols-3">
          <div>
            <h3 className="mb-1 font-semibold">For researchers</h3>
            <p className="text-ink-muted text-xs leading-relaxed">
              Find and cite exact dataset versions. Every record is content-addressed and
              independently verifiable.
            </p>
            <Link
              to="/explore"
              className="text-ink-muted mt-2 inline-block text-xs hover:underline"
            >
              Search collections
            </Link>
          </div>
          <div>
            <h3 className="mb-1 font-semibold">For publishers</h3>
            <p className="text-ink-muted text-xs leading-relaxed">
              Push structured data via API. Automatic deduplication, versioning, and preservation —
              publish once, archived forever.
            </p>
            <Link
              to="/docs/quickstart"
              className="text-ink-muted mt-2 inline-block text-xs hover:underline"
            >
              Start publishing
            </Link>
          </div>
          <div>
            <h3 className="mb-1 font-semibold">For institutions</h3>
            <p className="text-ink-muted text-xs leading-relaxed">
              Run a mirror for independent preservation, or deploy your own instance for internal
              knowledge infrastructure.
            </p>
            <Link
              to="/docs/concepts"
              className="text-ink-muted mt-2 inline-block text-xs hover:underline"
            >
              Learn more
            </Link>
          </div>
        </div>
      </section>

      {/* Bottom: trust / infra */}
      <section className="border-rule border-t py-8">
        <div className="grid grid-cols-2 gap-4 font-mono text-xs md:grid-cols-4">
          <div className="border-rule border p-3">
            <div className="text-ink-muted mb-1">Content-addressed</div>
            <div className="font-sans text-sm font-semibold">SHA-256 verified</div>
          </div>
          <div className="border-rule border p-3">
            <div className="text-ink-muted mb-1">Independent mirrors</div>
            <div className="font-sans text-sm font-semibold">{STATS.mirrors} active</div>
          </div>
          <div className="border-rule border p-3">
            <div className="text-ink-muted mb-1">Open source</div>
            <div className="font-sans text-sm font-semibold">MIT licensed</div>
          </div>
          <div className="border-rule border p-3">
            <div className="text-ink-muted mb-1">Built by</div>
            <div className="font-sans text-sm font-semibold">Knowledge Futures</div>
          </div>
        </div>
      </section>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Shared components                                                  */
/* ------------------------------------------------------------------ */

function CollectionRow({ collection: c }: { collection: MockCollection }) {
  return (
    <Link
      to={`/${c.orgSlug}/${c.slug}`}
      className="border-rule group flex items-center justify-between border p-4 transition-colors hover:bg-stone-50"
    >
      <div className="flex-1">
        <div className="flex items-baseline gap-2">
          <h3 className="text-sm font-semibold group-hover:underline">{c.title}</h3>
          <span className="text-ink-muted font-mono text-xs">v{c.versions}</span>
        </div>
        <div className="text-ink-muted mt-0.5 text-xs">
          {c.org} · {c.domain} · updated {c.lastPush}
        </div>
        <p className="text-ink-muted mt-1 text-xs leading-relaxed">{c.description}</p>
      </div>
      <div className="ml-4 text-right">
        <div className="font-mono text-sm font-semibold">{fmt(c.records)}</div>
        <div className="text-ink-muted text-xs">records</div>
      </div>
    </Link>
  )
}

function ActivityRow({ item: a }: { item: ActivityItem }) {
  return (
    <div className="border-rule flex items-start gap-3 border-b py-3">
      <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-stone-100 text-[10px] font-semibold text-stone-500">
        {a.type === 'push'
          ? 'P'
          : a.type === 'new-collection'
            ? 'N'
            : a.type === 'fork'
              ? 'F'
              : a.type === 'schema'
                ? 'S'
                : 'O'}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5 text-sm">
          <span className="font-semibold">{a.org}</span>
          {a.type === 'push' && (
            <>
              <span className="text-ink-muted">pushed to</span>
              <Link
                to={`/${a.orgSlug}/${a.collectionSlug}`}
                className="font-medium hover:underline"
              >
                {a.collection}
              </Link>
            </>
          )}
          {a.type === 'new-collection' && (
            <>
              <span className="text-ink-muted">created</span>
              <Link
                to={`/${a.orgSlug}/${a.collectionSlug}`}
                className="font-medium hover:underline"
              >
                {a.collection}
              </Link>
            </>
          )}
          {a.type === 'fork' && (
            <>
              <span className="text-ink-muted">forked</span>
              <Link
                to={`/${a.orgSlug}/${a.collectionSlug}`}
                className="font-medium hover:underline"
              >
                {a.collection}
              </Link>
            </>
          )}
          {a.type === 'schema' && (
            <>
              <span className="text-ink-muted">updated schema in</span>
              <Link
                to={`/${a.orgSlug}/${a.collectionSlug}`}
                className="font-medium hover:underline"
              >
                {a.collection}
              </Link>
            </>
          )}
          {a.type === 'new-org' && <span className="text-ink-muted">joined Underlay</span>}
        </div>
        {a.message && <p className="text-ink-muted mt-0.5 text-xs">{a.message}</p>}
        <div className="text-ink-muted mt-1 flex gap-3 font-mono text-[10px]">
          <span>{a.time}</span>
          {a.version && <span>{a.version}</span>}
          {a.records && <span>+{fmt(a.records)} records</span>}
        </div>
      </div>
    </div>
  )
}

function ActivityRowCompact({ item: a }: { item: ActivityItem }) {
  return (
    <div className="border-rule border-b py-2">
      <div className="flex items-baseline gap-1.5 text-xs">
        <span className="font-semibold">{a.org}</span>
        {a.type === 'push' && (
          <>
            <span className="text-ink-muted">&rarr;</span>
            <span className="truncate">{a.collection}</span>
          </>
        )}
        {a.type === 'new-collection' && (
          <>
            <span className="text-ink-muted">created</span>
            <span className="truncate">{a.collection}</span>
          </>
        )}
        {a.type === 'fork' && (
          <>
            <span className="text-ink-muted">forked</span>
            <span className="truncate">{a.collection}</span>
          </>
        )}
        {a.type === 'schema' && <span className="text-ink-muted">schema update</span>}
        {a.type === 'new-org' && <span className="text-ink-muted">joined</span>}
      </div>
      <div className="text-ink-muted mt-0.5 flex gap-2 font-mono text-[10px]">
        <span>{a.time}</span>
        {a.records && <span>+{fmt(a.records)}</span>}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Main playground page                                               */
/* ------------------------------------------------------------------ */

export default function LandingPlayground() {
  const [tab, setTab] = useState<Tab>('Hybrid')

  return (
    <BaseLayout>
      <div className="mx-auto max-w-5xl px-4">
        {/* Playground header */}
        <div className="border-rule border-b py-4">
          <div className="mb-1 flex items-baseline gap-2">
            <span className="bg-ink text-parchment rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase">
              Dev
            </span>
            <h1 className="text-sm font-semibold">Landing Page Playground</h1>
          </div>
          <p className="text-ink-muted text-xs">
            Exploring what Underlay's landing page could look like at scale. All data is mock.
          </p>
        </div>

        {/* Concept tabs */}
        <div className="border-rule flex gap-1 overflow-x-auto border-b">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`shrink-0 px-3 py-2 text-xs font-medium transition-colors ${
                tab === t
                  ? 'text-ink border-ink border-b-2'
                  : 'text-ink-muted hover:text-ink border-b-2 border-transparent'
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {/* Render selected concept */}
        {tab === 'Hybrid' && <Hybrid />}
        {tab === 'Reading Room' && <ReadingRoom />}
        {tab === 'Atlas' && <Atlas />}
        {tab === 'Activity Feed' && <ActivityFeed />}
        {tab === 'Reference Desk' && <ReferenceDesk />}
      </div>
    </BaseLayout>
  )
}
