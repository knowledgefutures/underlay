import { useLoaderData, useParams } from 'react-router'

import BaseLayout from '~/components/BaseLayout'
import SchemaList from '~/components/SchemaList'
import { useIsOwner } from '~/lib/use-is-owner'

import { CollectionNav } from '.'

export default function CollectionSchemasPage() {
  const { owner, collection } = useParams()
  const { data, schemas: schemasData } = useLoaderData() as { data: any; schemas: any }
  const isOwner = useIsOwner(owner)

  return (
    <BaseLayout>
      <div className="mx-auto max-w-5xl px-4 py-8">
        <CollectionNav
          owner={owner!}
          collection={collection!}
          isPublic={data.public}
          isOwner={!!isOwner}
          active="schemas"
          version={schemasData?.semver ?? data.latestVersion?.semver}
          isLatest
        />
        <SchemaList
          owner={owner!}
          collection={collection!}
          schemasData={schemasData}
          isOwner={!!isOwner}
        />
      </div>
    </BaseLayout>
  )
}
