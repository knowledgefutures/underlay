import BaseLayout from '~/components/BaseLayout'
import ExploreTagsAdmin from '~/components/ExploreTagsAdmin'
import FeaturedCollectionsAdmin from '~/components/FeaturedCollectionsAdmin'
import { useAppContext } from '~/lib/app-context'

export default function AdminExploreTags() {
  const { currentUser } = useAppContext()

  if (currentUser?.kfRole !== 'admin') {
    if (typeof window !== 'undefined') {
      window.location.href = '/'
    }
    return null
  }

  return (
    <BaseLayout>
      <div className="mx-auto max-w-2xl px-4 py-8">
        <h1 className="mb-2 text-2xl font-semibold">Explore Page</h1>
        <p className="text-ink-muted mb-8 text-sm">
          Configure what appears on the explore page — featured collections and tag filters.
        </p>

        <div className="space-y-12">
          <FeaturedCollectionsAdmin />
          <ExploreTagsAdmin />
        </div>
      </div>
    </BaseLayout>
  )
}
