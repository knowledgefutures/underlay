import { Link, useLoaderData } from 'react-router'

import {
  type Column,
  compact,
  day,
  plural,
  SortableTable,
  StatGrid,
  StatTile,
  type Usage,
} from '~/components/admin-stats'
import AdminLayout from '~/components/AdminLayout'
import { Badge, SectionHeading } from '~/components/ui'
import { formatBytes } from '~/lib/format'

interface BillingOrg {
  slug: string
  name: string
  personal: boolean
  collections: number
  latestBytes: number
  historyBytes: number
  refEvents: number
  refBytes: number
  usage: Usage
}

interface Billing {
  month: string
  orgs: BillingOrg[]
  reconcile: {
    collections: number
    running: number
    never: number
    stale: number
    corrected: { owner: string; slug: string; corrections: number; reconciledAt: number | null }[]
  }
  deleted: {
    owner: string | null
    slug: string
    versions: number
    totalBytes: number
    refEvents: number
    deletedAt: number
  }[]
}

function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(y!, m! - 1 + by, 1))
  return d.toISOString().slice(0, 7)
}

const monthName = (month: string) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })

export default function AdminBilling() {
  const data = useLoaderData() as Billing | null
  if (!data) {
    return (
      <AdminLayout title="Billing">
        <p className="text-ink-muted text-sm">Couldn't load the figures.</p>
      </AdminLayout>
    )
  }
  const thisMonth = new Date().toISOString().slice(0, 7)
  const sum = (f: (o: BillingOrg) => number) => data.orgs.reduce((s, o) => s + f(o), 0)

  const columns: Column<BillingOrg>[] = [
    {
      key: 'org',
      label: 'Organization',
      sort: (o) => o.slug,
      render: (o) => (
        <span className="flex items-center gap-1.5">
          <Link to={`/admin/orgs/${o.slug}`} className="text-link hover:underline">
            {o.name}
          </Link>
          {o.personal && <Badge>personal</Badge>}
        </span>
      ),
    },
    {
      key: 'latest',
      label: 'Stored, latest',
      numeric: true,
      sort: (o) => o.latestBytes,
      render: (o) => formatBytes(o.latestBytes),
    },
    {
      key: 'history',
      label: 'Stored, all versions',
      numeric: true,
      sort: (o) => o.historyBytes,
      render: (o) => formatBytes(o.historyBytes),
    },
    {
      key: 'refs',
      label: 'Reference events',
      numeric: true,
      sort: (o) => o.refEvents,
      render: (o) => compact(o.refEvents),
    },
    {
      key: 'calls',
      label: 'API calls',
      numeric: true,
      sort: (o) => o.usage.api_calls,
      render: (o) => compact(o.usage.api_calls),
    },
    {
      key: 'response',
      label: 'API egress',
      numeric: true,
      sort: (o) => o.usage.response_bytes,
      render: (o) => formatBytes(o.usage.response_bytes),
    },
    {
      key: 'downloads',
      label: 'Downloads',
      numeric: true,
      sort: (o) => o.usage.file_downloads,
      render: (o) => compact(o.usage.file_downloads),
    },
    {
      key: 'filebytes',
      label: 'File egress',
      numeric: true,
      sort: (o) => o.usage.file_bytes,
      render: (o) => formatBytes(o.usage.file_bytes),
    },
  ]

  const totalCell = (v: string) => (
    <td className="px-2.5 py-1.5 text-right font-medium tabular-nums">{v}</td>
  )

  return (
    <AdminLayout
      title="Billing"
      description="Metered quantities per organization. There are no prices yet: these are the counters a bill would be made from."
    >
      <div className="mb-6 flex items-center gap-3 text-sm">
        <Link to={`?month=${shiftMonth(data.month, -1)}`} className="text-link hover:underline">
          ← {monthName(shiftMonth(data.month, -1))}
        </Link>
        <span className="font-semibold">{monthName(data.month)}</span>
        {data.month < thisMonth && (
          <Link to={`?month=${shiftMonth(data.month, 1)}`} className="text-link hover:underline">
            {monthName(shiftMonth(data.month, 1))} →
          </Link>
        )}
      </div>

      <SectionHeading>By organization</SectionHeading>
      <p className="text-ink-muted mb-2 text-xs">
        Storage and reference events are as they stand now; API calls and egress are{' '}
        {monthName(data.month)}&rsquo;s, from the usage log&rsquo;s daily rollups.
      </p>
      {data.orgs.length === 0 ? (
        <p className="text-ink-muted mb-8 text-sm">Nothing metered.</p>
      ) : (
        <SortableTable
          rows={data.orgs}
          columns={columns}
          rowKey={(o) => o.slug}
          initialSort="history"
          footer={
            <tr>
              <td className="px-2.5 py-1.5 font-medium">Total</td>
              {totalCell(formatBytes(sum((o) => o.latestBytes)))}
              {totalCell(formatBytes(sum((o) => o.historyBytes)))}
              {totalCell(compact(sum((o) => o.refEvents)))}
              {totalCell(compact(sum((o) => o.usage.api_calls)))}
              {totalCell(formatBytes(sum((o) => o.usage.response_bytes)))}
              {totalCell(compact(sum((o) => o.usage.file_downloads)))}
              {totalCell(formatBytes(sum((o) => o.usage.file_bytes)))}
            </tr>
          }
        />
      )}

      <SectionHeading>Counter health</SectionHeading>
      <p className="text-ink-muted mb-3 text-xs">
        Every counter is rebuilt from its source weekly; a correction means a counter had drifted
        and was overwritten. Rebuild a collection or a usage day from{' '}
        <Link to="/admin/operations" className="text-link hover:underline">
          Operations
        </Link>
        .
      </p>
      <StatGrid>
        <StatTile label="Collections" value={compact(data.reconcile.collections)} />
        <StatTile label="Reconciling now" value={compact(data.reconcile.running)} />
        <StatTile label="Never reconciled" value={compact(data.reconcile.never)} />
        <StatTile label="Not in the last 8 days" value={compact(data.reconcile.stale)} />
      </StatGrid>
      {data.reconcile.corrected.length > 0 && (
        <ul className="mb-8 space-y-1 text-sm">
          {data.reconcile.corrected.map((c) => (
            <li key={`${c.owner}/${c.slug}`}>
              <code>
                {c.owner}/{c.slug}
              </code>{' '}
              <span className="font-medium text-amber-800">
                {c.corrections} correction{c.corrections === 1 ? '' : 's'}
              </span>{' '}
              <span className="text-ink-muted text-xs">reconciled {day(c.reconciledAt)}</span>
            </li>
          ))}
        </ul>
      )}

      <SectionHeading>Deleted in {monthName(data.month)}</SectionHeading>
      {data.deleted.length === 0 ? (
        <p className="text-ink-muted text-sm">No collections deleted.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {data.deleted.map((d) => (
            <li key={`${d.owner}/${d.slug}/${d.deletedAt}`}>
              <code>
                {d.owner ?? '?'}/{d.slug}
              </code>{' '}
              <span className="text-ink-muted text-xs">
                {day(d.deletedAt)} · {plural(d.versions, 'version')} · {formatBytes(d.totalBytes)} ·{' '}
                {compact(d.refEvents)} reference events
              </span>
            </li>
          ))}
        </ul>
      )}
    </AdminLayout>
  )
}
