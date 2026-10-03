import BaseLayout from '~/components/BaseLayout'
import { EmptyState } from '~/components/ui'

/**
 * A page whose API this server doesn't have yet (see lib/features.ts). The page's
 * own code stays in place and renders once the API answers.
 */
export default function Unavailable({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <BaseLayout>
      <div className="mx-auto max-w-5xl px-4 py-10">
        <h1 className="mb-6 font-sans text-xl font-semibold tracking-tight">{title}</h1>
        <EmptyState>{children}</EmptyState>
      </div>
    </BaseLayout>
  )
}
