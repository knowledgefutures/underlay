import BaseLayout from '~/components/BaseLayout'
import SchemaBrowser from '~/components/SchemaBrowser'

export default function SchemasPage() {
  return (
    <BaseLayout>
      <div className="mx-auto max-w-5xl px-4 py-10">
        <h1 className="mb-2 font-sans text-xl font-semibold tracking-tight">Schemas</h1>
        <p className="text-ink-muted mb-6 text-sm">
          Browse content-addressed schemas shared across collections. Same shape = same hash = same
          schema.
        </p>

        <SchemaBrowser />
      </div>
    </BaseLayout>
  )
}
