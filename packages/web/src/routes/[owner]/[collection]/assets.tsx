import { useLoaderData, useParams } from 'react-router'

import BaseLayout from '~/components/BaseLayout'
import { CollectionNav } from '~/components/collection-nav'
import { EmptyState } from '~/components/ui'
import { AssetsView, VersionInfoBar } from '~/components/version-views'
import { useIsOwner } from '~/lib/use-is-owner'

export default function CollectionAssetsPage() {
  const { owner, collection } = useParams()
  const { version, collectionData } = useLoaderData() as { version: any; collectionData: any }
  const isOwner = useIsOwner(owner)

  return (
    <BaseLayout>
      <div className="mx-auto max-w-5xl px-4 py-8">
        <CollectionNav
          owner={owner!}
          collection={collection!}
          isPublic={collectionData?.public}
          isOwner={!!isOwner}
          active="assets"
          version={version?.semver}
          isLatest
        />
        {version ? (
          <>
            <VersionInfoBar
              version={version}
              typeCount={Object.keys(version.schemas ?? {}).length}
            />
            <AssetsView
              owner={owner!}
              collection={collection!}
              version={version}
              recordsPath={`/${owner}/${collection}/records`}
            />
          </>
        ) : (
          <EmptyState>No versions yet — push data to browse assets.</EmptyState>
        )}
      </div>
    </BaseLayout>
  )
}
