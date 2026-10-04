import { useState } from 'react'
import { Link, useLoaderData, useSearchParams } from 'react-router'

import {
  type Column,
  compact,
  day,
  PeriodPicker,
  SortableTable,
  type Usage,
} from '~/components/admin-stats'
import AdminLayout from '~/components/AdminLayout'
import { Badge, Checkbox, Input } from '~/components/ui'
import { formatBytes } from '~/lib/format'

interface Org {
  slug: string
  name: string
  personal: boolean
  members: number
  collections: number
  publicCollections: number
  records: number
  latestBytes: number
  historyBytes: number
  versions: number
  refEvents: number
  lastPushAt: number | null
  usage: Usage
}

export default function AdminOrgs() {
  const data = useLoaderData() as { since: string; orgs: Org[] } | null
  const [params] = useSearchParams()
  const [q, setQ] = useState('')
  const [showEmpty, setShowEmpty] = useState(false)
  const days = params.get('days')

  const columns: Column<Org>[] = [
    {
      key: 'org',
      label: 'Organization',
      sort: (o) => o.slug,
      render: (o) => (
        <span className="flex items-center gap-1.5">
          <Link
            to={`/admin/orgs/${o.slug}${days ? `?days=${days}` : ''}`}
            className="text-link hover:underline"
          >
            {o.name}
          </Link>
          {o.personal && <Badge>personal</Badge>}
        </span>
      ),
    },
    {
      key: 'members',
      label: 'Members',
      numeric: true,
      sort: (o) => o.members,
      render: (o) => o.members,
    },
    {
      key: 'collections',
      label: 'Collections',
      numeric: true,
      sort: (o) => o.collections,
      render: (o) => o.collections,
    },
    {
      key: 'records',
      label: 'Records',
      numeric: true,
      sort: (o) => o.records,
      render: (o) => compact(o.records),
    },
    {
      key: 'size',
      label: 'Latest',
      numeric: true,
      sort: (o) => o.latestBytes,
      render: (o) => formatBytes(o.latestBytes),
    },
    {
      key: 'history',
      label: 'All versions',
      numeric: true,
      sort: (o) => o.historyBytes,
      render: (o) => formatBytes(o.historyBytes),
    },
    {
      key: 'calls',
      label: 'API calls',
      numeric: true,
      sort: (o) => o.usage.api_calls,
      render: (o) => compact(o.usage.api_calls),
    },
    {
      key: 'egress',
      label: 'Egress',
      numeric: true,
      sort: (o) => o.usage.response_bytes + o.usage.file_bytes,
      render: (o) => formatBytes(o.usage.response_bytes + o.usage.file_bytes),
    },
    {
      key: 'push',
      label: 'Last push',
      numeric: true,
      sort: (o) => o.lastPushAt ?? 0,
      render: (o) => day(o.lastPushAt),
    },
  ]

  const term = q.trim().toLowerCase()
  const rows = (data?.orgs ?? []).filter(
    (o) =>
      (showEmpty || o.collections > 0 || o.usage.api_calls > 0) &&
      (!term || o.slug.includes(term) || o.name.toLowerCase().includes(term)),
  )

  return (
    <AdminLayout
      title="Organizations"
      description="Every organization's holdings, and its usage in the period. Sizes are logical: what the versions hold."
    >
      {!data ? (
        <p className="text-ink-muted text-sm">Couldn't load the figures.</p>
      ) : (
        <>
          <PeriodPicker since={data.since} />
          <div className="mb-4 flex flex-wrap items-center gap-4">
            <Input
              type="search"
              placeholder="Filter by name or slug"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="max-w-64"
            />
            <label className="text-ink-muted flex items-center gap-1.5 text-sm">
              <Checkbox checked={showEmpty} onChange={(e) => setShowEmpty(e.target.checked)} />
              Include organizations with no collections or usage
            </label>
          </div>
          <SortableTable rows={rows} columns={columns} rowKey={(o) => o.slug} initialSort="size" />
          <p className="text-ink-muted text-xs">
            {rows.length} of {data.orgs.length} organizations.
          </p>
        </>
      )}
    </AdminLayout>
  )
}
