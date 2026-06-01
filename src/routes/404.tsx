import BaseLayout from '~/components/BaseLayout'
import NotFound from '~/components/NotFound'

export const handle = { title: 'Page not found — Underlay' }

export default function NotFoundPage() {
  return (
    <BaseLayout>
      <NotFound />
    </BaseLayout>
  )
}
