import BaseLayout from '~/components/BaseLayout'
import SchemaBrowser from '~/components/SchemaBrowser'

export default function SchemasPage() {
  return (
    <BaseLayout>
      <div className="max-w-5xl mx-auto px-4 py-10">
        <h1 className="text-xl font-semibold tracking-tight font-sans mb-2">Schemas</h1>
        <p className="text-sm text-ink-muted mb-6">Browse content-addressed schemas shared across collections. Same shape = same hash = same schema.</p>

        <SchemaBrowser />
      </div>
    </BaseLayout>
  )
}
