import { useLoaderData, useParams } from 'react-router'

import BaseLayout from '~/components/BaseLayout'
import { CollectionNav } from '~/components/collection-nav'
import SchemaList from '~/components/SchemaList'
import { useAppContext } from '~/lib/app-context'
import { useIsOwner } from '~/lib/use-is-owner'

export default function CollectionSchemasPage() {
  const { owner, collection } = useParams()
  const { data, schemas: schemasData } = useLoaderData() as { data: any; schemas: any }
  const isOwner = useIsOwner(owner)
  const { currentUser } = useAppContext()
  const canEditArk = !!currentUser?.orgs?.some(
    (o: { slug: string; role: string }) =>
      o.slug === owner && (o.role === 'owner' || o.role === 'admin'),
  )

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
          canEditArk={canEditArk}
        />
      </div>
    </BaseLayout>
  )
}
