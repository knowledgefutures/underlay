import { Link, useLoaderData } from 'react-router'

import {
  compact,
  plural,
  PeriodPicker,
  StatGrid,
  StatTile,
  type Usage,
  UsageChart,
} from '~/components/admin-stats'
import AdminLayout from '~/components/AdminLayout'
import { SectionHeading } from '~/components/ui'
import { formatBytes } from '~/lib/format'

interface Overview {
  since: string
  totals: {
    users: number
    orgs: number
    personalOrgs: number
    collections: number
    publicCollections: number
    records: number
    publicRecords: number
    versions: number
    latestBytes: number
    historyBytes: number
    refEvents: number
    uniqueFiles: number
    uniqueFileBytes: number
    schemas: number
  }
  usage: Usage
  daily: ({ day: string } & Usage)[]
  attention: Record<string, number>
}

const ATTENTION: { key: string; label: string; to: string }[] = [
  { key: 'openReports', label: 'open abuse reports', to: '/admin/abuse' },
  { key: 'corrections', label: 'collections with reconcile corrections', to: '/admin/billing' },
  {
    key: 'locationProblems',
    label: 'storage locations broken or unverified',
    to: '/admin/operations',
  },
  { key: 'failedPushes', label: 'pushes failed in the last 24 hours', to: '/admin/operations' },
]

export default function AdminOverview() {
  const data = useLoaderData() as Overview | null
  return (
    <AdminLayout title="Overview" description="The instance at a glance.">
      {!data ? (
        <p className="text-ink-muted text-sm">Couldn't load the figures.</p>
      ) : (
        <Body data={data} />
      )}
    </AdminLayout>
  )
}

function Body({ data }: { data: Overview }) {
  const { totals: t, usage: u } = data
  const issues = ATTENTION.filter((a) => (data.attention[a.key] ?? 0) > 0)
  return (
    <>
      <SectionHeading>Needs attention</SectionHeading>
      {issues.length === 0 ? (
        <p className="text-ink-muted mb-8 text-sm">Nothing right now.</p>
      ) : (
        <ul className="mb-8 space-y-1 text-sm">
          {issues.map((a) => (
            <li key={a.key}>
              <Link to={a.to} className="text-link hover:underline">
                <strong>{compact(data.attention[a.key]!)}</strong> {a.label}
              </Link>
            </li>
          ))}
        </ul>
      )}

      <SectionHeading>Holdings</SectionHeading>
      <StatGrid>
        <StatTile
          label="Organizations"
          value={compact(t.orgs)}
          detail={`and ${compact(t.personalOrgs)} personal`}
          to="/admin/orgs"
        />
        <StatTile label="Users" value={compact(t.users)} />
        <StatTile
          label="Collections"
          value={compact(t.collections)}
          detail={`${compact(t.publicCollections)} public`}
        />
        <StatTile
          label="Records in latest versions"
          value={compact(t.records)}
          detail={`${compact(t.publicRecords)} public`}
          to="/admin/corpus"
        />
        <StatTile
          label="Size of latest versions"
          value={formatBytes(t.latestBytes)}
          detail={`${formatBytes(t.historyBytes)} over ${plural(t.versions, 'version')}`}
        />
        <StatTile
          label="Unique files stored"
          value={formatBytes(t.uniqueFileBytes)}
          detail={`${compact(t.uniqueFiles)} files`}
        />
        <StatTile label="Schemas" value={compact(t.schemas)} />
        <StatTile label="Reference log events" value={compact(t.refEvents)} />
      </StatGrid>

      <SectionHeading>Usage</SectionHeading>
      <PeriodPicker since={data.since} />
      <StatGrid>
        <StatTile label="API calls" value={compact(u.api_calls)} />
        <StatTile
          label="Egress"
          value={formatBytes(u.response_bytes + u.file_bytes)}
          detail={`${formatBytes(u.response_bytes)} API, ${formatBytes(u.file_bytes)} files`}
        />
        <StatTile label="File downloads" value={compact(u.file_downloads)} />
      </StatGrid>
      <UsageChart daily={data.daily} />
      <p className="text-ink-muted text-xs">
        Metered on collection routes and billed to the owning organization; page renders and
        non-collection routes aren&rsquo;t counted. Usage arrives within about a minute.
      </p>
    </>
  )
}
