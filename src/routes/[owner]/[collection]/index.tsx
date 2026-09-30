import { Link, useLoaderData, useParams } from 'react-router'

import BaseLayout from '~/components/BaseLayout'
import { CollectionNav } from '~/components/collection-nav'
import CollectionOverviewBody from '~/components/collection-overview'
import { SharePanel } from '~/components/share-panel'
import { useAppContext } from '~/lib/app-context'
import { useIsOwner } from '~/lib/use-is-owner'

export default function CollectionPage() {
  const { owner, collection } = useParams()
  const { mirrorConfig } = useAppContext()
  const data = useLoaderData() as any

  const isOwner = useIsOwner(owner)

  return (
    <BaseLayout>
      <div className="mx-auto max-w-5xl px-4 py-8">
        <CollectionNav
          owner={owner!}
          collection={collection!}
          isPublic={data.public}
          isOwner={isOwner}
          active="overview"
          version={data.latestVersion?.semver}
          isLatest
        />

        {mirrorConfig?.enabled && (
          <div className="text-ink-muted bg-parchment-dark border-rule rounded-surface mb-4 flex items-center gap-2 border px-3 py-2 text-xs">
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"
              />
            </svg>
            <span>
              Mirrored from{' '}
              <Link
                to={`${mirrorConfig.upstream}/${owner}/${collection}`}
                className="hover:text-ink underline"
              >
                {mirrorConfig.upstream.replace(/^https?:\/\//, '')}
              </Link>
            </span>
          </div>
        )}

        {/* Empty state for new collections */}
        {!data.latestVersion && isOwner && (
          <div className="border-rule rounded-surface mb-6 border px-6 py-10 text-center">
            <h2 className="mb-2 text-base font-semibold">Get started with {collection}</h2>
            <p className="text-ink-muted mx-auto mb-6 max-w-md text-sm leading-relaxed">
              This collection is empty. Push your first version using the CLI or API.
            </p>
            <div className="bg-ink text-parchment rounded-surface mx-auto max-w-md overflow-hidden text-left font-mono text-[13px] leading-relaxed">
              <div className="p-4">
                <div className="text-ink-muted mb-1 text-[11px] select-none">
                  # initialize and push
                </div>
                <div>
                  <span className="text-parchment-dark">$</span> underlay init --remote {owner}/
                  {collection}
                </div>
                <div>
                  <span className="text-parchment-dark">$</span> underlay add --schema ./schema.json
                  ./records.jsonl
                </div>
                <div>
                  <span className="text-parchment-dark">$</span> underlay commit -m &quot;Initial
                  version&quot;
                </div>
                <div>
                  <span className="text-parchment-dark">$</span> underlay push
                </div>
              </div>
            </div>
            <div className="mt-4 flex items-center justify-center gap-4 text-xs">
              <Link to="/docs/quickstart" className="text-link hover:underline">
                Read the quickstart
              </Link>
              <span className="text-rule">&middot;</span>
              <span className="text-ink-muted">
                API:{' '}
                <code className="bg-parchment-dark rounded-control px-1.5 py-0.5 text-[11px]">
                  POST /api/collections/{owner}/{collection}/versions/negotiate
                </code>
              </span>
            </div>
          </div>
        )}

        <CollectionOverviewBody
          owner={owner!}
          collection={collection!}
          data={data}
          version={data.latestVersion}
          isLatest
          share={
            isOwner ? (
              <SharePanel
                owner={owner!}
                collection={collection!}
                collectionId={data.id}
                isPublic={!!data.public}
              />
            ) : undefined
          }
        />
      </div>
    </BaseLayout>
  )
}
