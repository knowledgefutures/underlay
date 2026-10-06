import { Link, useLoaderData } from 'react-router'

import {
  type Column,
  compact,
  day,
  plural,
  PeriodPicker,
  SortableTable,
  StatGrid,
  StatTile,
  type Usage,
  UsageChart,
} from '~/components/admin-stats'
import AdminLayout from '~/components/AdminLayout'
import { Badge, SectionHeading } from '~/components/ui'
import { formatBytes } from '~/lib/format'

interface Collection {
  id: string
  slug: string
  name: string
  public: boolean
  records: number
  publicRecords: number
  files: number
  latestBytes: number
  versions: number
  historyBytes: number
  refEvents: number
  lastPushAt: number | null
  reconciledAt: number | null
  corrections: number
  usage: Usage
}

interface OrgStats {
  since: string
  org: { slug: string; name: string; personal: boolean }
  totals: {
    records: number
    latestBytes: number
    historyBytes: number
    versions: number
    refEvents: number
  }
  usage: Usage
  daily: ({ day: string } & Usage)[]
  members: { name: string; email: string; role: string }[]
  collections: Collection[]
}

export default function AdminOrg() {
  const data = useLoaderData() as OrgStats | null
  if (!data) {
    return (
      <AdminLayout title="Organization">
        <p className="text-ink-muted text-sm">
          No such organization.{' '}
          <Link to="/admin/orgs" className="text-link hover:underline">
            All organizations
          </Link>
        </p>
      </AdminLayout>
    )
  }
  const { org, totals: t, usage: u } = data
  const owner = org.slug

  const columns: Column<Collection>[] = [
    {
      key: 'slug',
      label: 'Collection',
      sort: (c) => c.slug,
      render: (c) => (
        <span className="flex items-center gap-1.5">
          <Link to={`/${owner}/${c.slug}`} className="text-link hover:underline">
            {c.slug}
          </Link>
          {!c.public && <Badge>private</Badge>}
        </span>
      ),
    },
    {
      key: 'records',
      label: 'Records',
      numeric: true,
      sort: (c) => c.records,
      render: (c) => compact(c.records),
    },
    {
      key: 'files',
      label: 'Files',
      numeric: true,
      sort: (c) => c.files,
      render: (c) => compact(c.files),
    },
    {
      key: 'size',
      label: 'Latest',
      numeric: true,
      sort: (c) => c.latestBytes,
      render: (c) => formatBytes(c.latestBytes),
    },
    {
      key: 'history',
      label: 'All versions',
      numeric: true,
      sort: (c) => c.historyBytes,
      render: (c) => formatBytes(c.historyBytes),
    },
    {
      key: 'versions',
      label: 'Versions',
      numeric: true,
      sort: (c) => c.versions,
      render: (c) => c.versions,
    },
    {
      key: 'calls',
      label: 'API calls',
      numeric: true,
      sort: (c) => c.usage.api_calls,
      render: (c) => compact(c.usage.api_calls),
    },
    {
      key: 'egress',
      label: 'Egress',
      numeric: true,
      sort: (c) => c.usage.response_bytes + c.usage.file_bytes,
      render: (c) => formatBytes(c.usage.response_bytes + c.usage.file_bytes),
    },
    {
      key: 'push',
      label: 'Last push',
      numeric: true,
      sort: (c) => c.lastPushAt ?? 0,
      render: (c) => day(c.lastPushAt),
    },
    {
      key: 'reconciled',
      label: 'Reconciled',
      numeric: true,
      sort: (c) => c.reconciledAt ?? 0,
      render: (c) =>
        c.corrections > 0 ? (
          <span className="font-medium text-amber-800">{c.corrections} corrected</span>
        ) : (
          day(c.reconciledAt)
        ),
    },
  ]

  return (
    <AdminLayout
      title={org.name}
      {...(org.personal ? { description: 'A personal organization.' } : {})}
    >
      <p className="mb-6 text-sm">
        <Link to={`/${owner}`} className="text-link hover:underline">
          /{owner}
        </Link>{' '}
        ·{' '}
        <Link to={`/${owner}/settings`} className="text-link hover:underline">
          settings
        </Link>
      </p>

      <StatGrid>
        <StatTile label="Collections" value={compact(data.collections.length)} />
        <StatTile label="Records in latest versions" value={compact(t.records)} />
        <StatTile
          label="Size of latest versions"
          value={formatBytes(t.latestBytes)}
          detail={`${formatBytes(t.historyBytes)} over ${plural(t.versions, 'version')}`}
        />
        <StatTile label="Reference log events" value={compact(t.refEvents)} />
      </StatGrid>

      <SectionHeading>Collections</SectionHeading>
      {data.collections.length === 0 ? (
        <p className="text-ink-muted mb-8 text-sm">No collections.</p>
      ) : (
        <SortableTable
          rows={data.collections}
          columns={columns}
          rowKey={(c) => c.id}
          initialSort="size"
        />
      )}

      <SectionHeading>Usage</SectionHeading>
      <PeriodPicker since={data.since} />
      <StatGrid>
        <StatTile label="API calls" value={compact(u.api_calls)} />
        <StatTile label="Egress" value={formatBytes(u.response_bytes + u.file_bytes)} />
        <StatTile label="File downloads" value={compact(u.file_downloads)} />
      </StatGrid>
      <UsageChart daily={data.daily} />

      <SectionHeading>Members ({data.members.length})</SectionHeading>
      <ul className="space-y-1 text-sm">
        {data.members.map((m) => (
          <li key={m.email}>
            {m.name} <span className="text-ink-muted">{m.email}</span> <Badge>{m.role}</Badge>
          </li>
        ))}
      </ul>
    </AdminLayout>
  )
}
