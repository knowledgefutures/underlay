import { useLoaderData, useParams } from 'react-router'

import BaseLayout from '~/components/BaseLayout'
import { FilesView, VersionInfoBar } from '~/components/version-views'
import { useIsOwner } from '~/lib/use-is-owner'

import { CollectionNav } from '../..'

export default function VersionFilesPage() {
  const { owner, collection, n } = useParams()
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
          active="files"
          version={version.semver}
          isLatest={collectionData?.latestVersion?.semver === version.semver}
        />
        <VersionInfoBar version={version} typeCount={Object.keys(version.schemas ?? {}).length} />
        <FilesView
          owner={owner!}
          collection={collection!}
          version={version}
          recordsPath={`/${owner}/${collection}/v/${n}/records`}
        />
      </div>
    </BaseLayout>
  )
}
