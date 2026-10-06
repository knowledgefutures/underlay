import { useLoaderData } from 'react-router'

import BaseLayout from '~/components/BaseLayout'
import CollectionExplorer, { type ExploreData } from '~/components/CollectionExplorer'

export default function ExplorePage() {
  const initial = useLoaderData() as ExploreData | null
  return (
    <BaseLayout>
      <div className="mx-auto max-w-5xl px-4 py-10">
        <div className="mb-8">
          <h1 className="mb-1 font-sans text-xl font-semibold tracking-tight">Explore</h1>
          <p className="text-ink-muted text-sm">
            Browse public knowledge collections published to Underlay.
          </p>
        </div>

        <CollectionExplorer initial={initial} />
      </div>
    </BaseLayout>
  )
}
