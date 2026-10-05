import { useState } from 'react'
import { Link, useLoaderData } from 'react-router'

import {
  type Column,
  ColumnChart,
  compact,
  num,
  plural,
  SortableTable,
  StatGrid,
  StatTile,
} from '~/components/admin-stats'
import AdminLayout from '~/components/AdminLayout'
import { Badge, SectionHeading } from '~/components/ui'
import { formatBytes, formatDate } from '~/lib/format'

interface Corpus {
  totals: {
    collections: number
    types: number
    records: number
    publicRecords: number
    versions: number
    latestBytes: number
    refEvents: number
  }
  types: { type: string; records: number; publicRecords: number; collections: number }[]
  sharedSchemas: { hash: string; type: string; collections: number }[]
  largest: {
    owner: string
    slug: string
    public: boolean
    records: number
    latestBytes: number
    versions: number
  }[]
  growth: { month: string; versions: number; added: number; removed: number; updated: number }[]
}

type GrowthMetric = 'added' | 'versions'

const monthLabel = (month: string) => formatDate(`${month}-01T00:00:00Z`, 'month')

export default function AdminCorpus() {
  const data = useLoaderData() as Corpus | null
  const [growth, setGrowth] = useState<GrowthMetric>('added')
  if (!data) {
    return (
      <AdminLayout title="Corpus">
        <p className="text-ink-muted text-sm">Couldn't load the figures.</p>
      </AdminLayout>
    )
  }
  const t = data.totals
  const publicShare = t.records ? Math.round((t.publicRecords / t.records) * 100) : 0

  const typeColumns: Column<Corpus['types'][number]>[] = [
    { key: 'type', label: 'Type', sort: (r) => r.type, render: (r) => <code>{r.type}</code> },
    {
      key: 'records',
      label: 'Records',
      numeric: true,
      sort: (r) => r.records,
      render: (r) => num(r.records),
    },
    {
      key: 'public',
      label: 'Public',
      numeric: true,
      sort: (r) => r.publicRecords,
      render: (r) => num(r.publicRecords),
    },
    {
      key: 'collections',
      label: 'Collections',
      numeric: true,
      sort: (r) => r.collections,
      render: (r) => r.collections,
    },
  ]

  return (
    <AdminLayout
      title="Corpus"
      description="What the instance holds: the latest version of every collection, and how it got there."
    >
      <StatGrid>
        <StatTile label="Records" value={compact(t.records)} detail={`${publicShare}% public`} />
        <StatTile
          label="Record types"
          value={compact(t.types)}
          detail={`in ${plural(t.collections, 'collection')}`}
        />
        <StatTile label="Size" value={formatBytes(t.latestBytes)} />
        <StatTile label="Versions published" value={compact(t.versions)} />
      </StatGrid>

      <SectionHeading>Growth by month</SectionHeading>
      <div className="mb-2 flex gap-1" role="radiogroup" aria-label="Growth measure">
        {(
          [
            ['added', 'Records added'],
            ['versions', 'Versions'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={growth === key}
            onClick={() => setGrowth(key)}
            className={`rounded-control cursor-pointer px-2 py-0.5 text-xs transition-colors ${
              growth === key
                ? 'bg-parchment-dark text-ink font-medium'
                : 'text-ink-muted hover:text-ink'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <ColumnChart
        label={growth === 'added' ? 'Records added per month' : 'Versions per month'}
        format={compact}
        points={data.growth.map((g) => ({ label: monthLabel(g.month), value: g[growth] }))}
      />

      <SectionHeading>Record types</SectionHeading>
      <SortableTable
        rows={data.types}
        columns={typeColumns}
        rowKey={(r) => r.type}
        initialSort="records"
      />

      <SectionHeading>Most shared schemas</SectionHeading>
      <p className="text-ink-muted mb-2 text-xs">
        Schemas in use by more than one collection are the same document, hash for hash.
      </p>
      <ul className="mb-8 space-y-1 text-sm">
        {data.sharedSchemas.map((s) => (
          <li key={s.hash} className="flex items-center gap-2">
            <code>{s.type}</code>
            <span className="text-ink-muted font-mono text-xs">{s.hash.slice(0, 12)}…</span>
            <span className="text-ink-muted text-xs">
              {s.collections} collection{s.collections === 1 ? '' : 's'}
            </span>
          </li>
        ))}
      </ul>

      <SectionHeading>Largest collections</SectionHeading>
      <ul className="space-y-1 text-sm">
        {data.largest.map((c) => (
          <li key={`${c.owner}/${c.slug}`} className="flex flex-wrap items-center gap-2">
            <Link to={`/${c.owner}/${c.slug}`} className="text-link hover:underline">
              {c.owner}/{c.slug}
            </Link>
            {!c.public && <Badge>private</Badge>}
            <span className="text-ink-muted text-xs">
              {plural(c.records, 'record')} · {formatBytes(c.latestBytes)} ·{' '}
              {plural(c.versions, 'version')}
            </span>
          </li>
        ))}
      </ul>
    </AdminLayout>
  )
}
