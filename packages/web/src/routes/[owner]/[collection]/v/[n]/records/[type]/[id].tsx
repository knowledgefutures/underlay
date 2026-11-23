import { Link, useLoaderData, useParams, useSearchParams } from 'react-router'

import BaseLayout from '~/components/BaseLayout'
import { CollectionNav } from '~/components/collection-nav'
import { CopyButton } from '~/components/copy-button'
import { Badge, SectionHeading } from '~/components/ui'
import { formatDate } from '~/lib/format'
import { linksIn, linkUrl, recordLinkObject, shortUlId, ulId } from '~/lib/links'
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
  // A link followed here names the version of the record it pins (/api/links/resolve).
  const [search] = useSearchParams()
  const pinned = search.get('hash')
  const pinnedElsewhere = pinned !== null && pinned !== record.hash
  const links = linksIn(record.data)
  const collectionId: string | undefined = collectionData?.id
  const linkObject = collectionId
    ? JSON.stringify(
        recordLinkObject(record.hash, {
          collection: collectionId,
          type: record.type,
          id: record.id,
        }),
      )
    : null

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
          {/* No link to where else the record appears, on any layout, until the reference
              index covers v3 collections (v3-deploy-plan.md, decision 6). */}
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <code className="text-ink-muted font-mono text-xs break-all">
              {ulId('rec', record.hash)}
            </code>
            <CopyButton text={ulId('rec', record.hash)} label="Copy id" />
            {linkObject && <CopyButton text={linkObject} label="Copy as $link" />}
          </div>
          {pinnedElsewhere && (
            <p className="text-ink-muted mt-2 text-xs">
              The link you followed names another version of this record (
              <code className="font-mono">{shortUlId('rec', pinned!)}</code>
              ). It is marked in the history below if this collection still has it.
            </p>
          )}
        </div>

        <SectionHeading>Data</SectionHeading>
        <pre className="border-rule bg-parchment-dark rounded-surface mb-8 overflow-x-auto border p-3 text-xs">
          {JSON.stringify(record.data, null, 2)}
        </pre>

        {links.length > 0 && (
          <>
            <SectionHeading>Links</SectionHeading>
            <div className="border-rule rounded-surface mb-8 overflow-x-auto border">
              <table className="w-full text-xs">
                <tbody>
                  {links.map((l) => (
                    <tr key={l.path} className="border-rule border-t first:border-t-0">
                      <td className="p-2 font-mono">{l.path || '/'}</td>
                      <td className="p-2 font-mono" title={ulId(l.kind, l.hash)}>
                        {shortUlId(l.kind, l.hash)}
                      </td>
                      <td className="text-ink-muted p-2">
                        {l.attached
                          ? 'asset in this collection'
                          : [l.type, l.id].filter(Boolean).join(' ') ||
                            (l.collection ? 'in another collection' : '')}
                      </td>
                      <td className="p-2 text-right">
                        <a href={linkUrl(l, collectionId)} className="text-link hover:underline">
                          Open
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

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
                <span className="text-ink-muted text-xs">{formatDate(x.createdAt)}</span>
                {x.hash === record.hash && (
                  <span className="text-ink-muted text-xs">this version</span>
                )}
                {pinnedElsewhere && x.hash === pinned && (
                  <span className="text-ink-muted text-xs">the version the link names</span>
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
