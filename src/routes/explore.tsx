import BaseLayout from '~/components/BaseLayout'
import CollectionExplorer from '~/components/CollectionExplorer'

export default function ExplorePage() {
  return (
    <BaseLayout>
      <div className="max-w-5xl mx-auto px-4 py-10">
        <h1 className="text-xl font-semibold tracking-tight font-sans mb-2">Explore collections</h1>
        <p className="text-sm text-ink-muted mb-6">Browse public knowledge collections published to Underlay.</p>

        <CollectionExplorer />
      </div>
    </BaseLayout>
  )
}
