import { Link, useLoaderData, useParams } from 'react-router'

import BaseLayout from '~/components/BaseLayout'
import { CollectionNav } from '~/components/collection-nav'
import { Badge, SectionHeading } from '~/components/ui'
import { useIsOwner } from '~/lib/use-is-owner'

interface Change {
  seq: number
  semver: string
  createdAt: string
  change: 'added' | 'updated' | 'removed'
  hash: string | null
}

const bare = (semver: string) => semver.replace(/^v/, '')

/** One record at a version: its data, and every version of the collection that changed it. */
export default function RecordPage() {
  const { owner, collection } = useParams()
  const { record, history, collectionData } = useLoaderData() as {
    record: { id: string; type: string; data: unknown; hash: string; semver: string }
    history: { changes: Change[]; truncated: boolean } | null
    collectionData: any
  }
  const isOwner = useIsOwner(owner)
  const base = `/${owner}/${collection}`
  const changes = [...(history?.changes ?? [])].reverse()

  return (
    <BaseLayout>
      <div className="mx-auto max-w-5xl px-4 py-8">
        <CollectionNav
          owner={owner!}
          collection={collection!}
          isPublic={collectionData?.public}
          isOwner={!!isOwner}
          active="records"
          version={record.semver}
          isLatest={collectionData?.latestVersion?.semver === record.semver}
        />
        <div className="mb-6">
          <p className="text-ink-muted mb-1 text-xs">
            <Link
              to={`${base}/v/${bare(record.semver)}/records?type=${encodeURIComponent(record.type)}`}
              className="text-link hover:underline"
            >
              {record.type}
            </Link>{' '}
            at {record.semver}
          </p>
          <h1 className="font-mono text-lg font-semibold break-all">{record.id}</h1>
          <p className="text-ink-muted mt-1 font-mono text-xs break-all">
            {record.hash} ·{' '}
            <Link to={`/records/${record.hash}`} className="text-link hover:underline">
              where else it appears
            </Link>
          </p>
        </div>

        <SectionHeading>Data</SectionHeading>
        <pre className="border-rule bg-parchment-dark rounded-surface mb-8 overflow-x-auto border p-3 text-xs">
          {JSON.stringify(record.data, null, 2)}
        </pre>

        <SectionHeading>History in this collection</SectionHeading>
        {changes.length === 0 ? (
          <p className="text-ink-muted text-sm">No history.</p>
        ) : (
          <ol className="space-y-1 text-sm">
            {changes.map((x) => (
              <li key={x.seq} className="flex flex-wrap items-center gap-2">
                <Badge>{x.change}</Badge>
                {x.change === 'removed' ? (
                  <span>{x.semver}</span>
                ) : (
                  <Link
                    to={`${base}/v/${bare(x.semver)}/records/${encodeURIComponent(record.type)}/${encodeURIComponent(record.id)}`}
                    className="text-link hover:underline"
                  >
                    {x.semver}
                  </Link>
                )}
                <span className="text-ink-muted text-xs">
                  {new Date(x.createdAt).toLocaleDateString('en-US', { timeZone: 'UTC' })}
                </span>
                {x.hash === record.hash && (
                  <span className="text-ink-muted text-xs">this version</span>
                )}
              </li>
            ))}
            {history?.truncated && (
              <li className="text-ink-muted text-xs">
                Only the most recent 500 versions are checked.
              </li>
            )}
          </ol>
        )}
      </div>
    </BaseLayout>
  )
}
