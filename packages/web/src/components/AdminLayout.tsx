import BaseLayout from '~/components/BaseLayout'
import SettingsLayout, { type SettingsRailGroup } from '~/components/SettingsLayout'
import { useAppContext } from '~/lib/app-context'

/** The steward pages, in rail order. */
export const adminRail: SettingsRailGroup[] = [
  {
    heading: 'Instance',
    items: [
      { label: 'Overview', to: '/admin' },
      { label: 'Organizations', to: '/admin/orgs', prefix: true },
      { label: 'Corpus', to: '/admin/corpus' },
    ],
  },
  {
    heading: 'Accounts',
    items: [
      { label: 'Billing', to: '/admin/billing' },
      { label: 'Operations', to: '/admin/operations' },
    ],
  },
  {
    heading: 'Content',
    items: [
      { label: 'Abuse reports', to: '/admin/abuse' },
      { label: 'Explore page', to: '/admin/explore' },
    ],
  },
]

/** The shell for every steward page: the admin rail, and a gate for everyone else. */
export default function AdminLayout({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: React.ReactNode
}) {
  const { currentUser } = useAppContext()
  if (currentUser?.kfRole !== 'admin') {
    return (
      <BaseLayout>
        <div className="mx-auto max-w-2xl px-4 py-16 text-center">
          <p className="text-ink-muted text-sm">This page is only available to admins.</p>
        </div>
      </BaseLayout>
    )
  }
  return (
    <SettingsLayout
      title={title}
      {...(description ? { description } : {})}
      groups={adminRail}
      label="Admin"
      wide
    >
      {children}
    </SettingsLayout>
  )
}
