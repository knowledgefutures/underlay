import BaseLayout from '~/components/BaseLayout'
import CollectionExplorer from '~/components/CollectionExplorer'

export default function ExplorePage() {
  return (
    <BaseLayout>
      <div className="mx-auto max-w-5xl px-4 py-10">
        <h1 className="mb-2 font-sans text-xl font-semibold tracking-tight">Explore collections</h1>
        <p className="text-ink-muted mb-6 text-sm">
          Browse public knowledge collections published to Underlay.
        </p>

        <CollectionExplorer />
      </div>
    </BaseLayout>
  )
}
