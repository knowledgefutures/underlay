import AdminLayout from '~/components/AdminLayout'
import ExploreTagsAdmin from '~/components/ExploreTagsAdmin'
import FeaturedCollectionsAdmin from '~/components/FeaturedCollectionsAdmin'

export default function AdminExplore() {
  return (
    <AdminLayout
      title="Explore page"
      description="What the explore page features: collections and tag filters."
    >
      <div className="max-w-2xl space-y-12">
        <FeaturedCollectionsAdmin />
        <ExploreTagsAdmin />
      </div>
    </AdminLayout>
  )
}
