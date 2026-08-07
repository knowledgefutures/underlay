import { useLoaderData, useParams } from 'react-router'

import BaseLayout from '~/components/BaseLayout'
import CollectionOverviewBody from '~/components/collection-overview'
import { useIsOwner } from '~/lib/use-is-owner'

import { CollectionNav, SharePanel } from '../..'

export default function VersionOverviewPage() {
  const { owner, collection } = useParams()
  const { version, collectionData } = useLoaderData() as { version: any; collectionData: any }
  const isOwner = useIsOwner(owner)
  const isLatest = collectionData?.latestVersion?.semver === version.semver

  return (
    <BaseLayout>
      <div className="mx-auto max-w-5xl px-4 py-8">
        <CollectionNav
          owner={owner!}
          collection={collection!}
          isPublic={collectionData?.public}
          isOwner={!!isOwner}
          active="overview"
          version={version.semver}
          isLatest={isLatest}
        />
        <CollectionOverviewBody
          owner={owner!}
          collection={collection!}
          data={collectionData}
          version={version}
          isLatest={isLatest}
          share={
            isOwner ? (
              <SharePanel
                owner={owner!}
                collection={collection!}
                collectionId={collectionData.id}
                isPublic={!!collectionData.public}
              />
            ) : undefined
          }
        />
      </div>
    </BaseLayout>
  )
}
