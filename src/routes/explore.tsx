import BaseLayout from '~/components/BaseLayout'
import CollectionExplorer from '~/components/CollectionExplorer'

export const handle = { title: 'Explore — Underlay' }

export default function ExplorePage() {
  return (
    <BaseLayout>
      <div className="mx-auto max-w-6xl px-4 py-10">
        <div className="mb-8">
          <h1 className="mb-1 font-sans text-xl font-semibold tracking-tight">Explore</h1>
          <p className="text-ink-muted text-sm">
            Browse public knowledge collections published to Underlay.
          </p>
        </div>

        <CollectionExplorer />
      </div>
    </BaseLayout>
  )
}
