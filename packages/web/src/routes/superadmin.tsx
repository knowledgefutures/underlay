import { Link } from 'react-router'

import BaseLayout from '~/components/BaseLayout'
import { useAppContext } from '~/lib/app-context'
import { features } from '~/lib/features'

const tools = [
  {
    name: 'Explore Page',
    href: '/admin/explore-tags',
    description: 'Manage featured collections and tag filters on the explore page.',
    stewardOnly: true,
  },
  {
    name: 'Abuse Reports',
    href: '/admin/abuse',
    description: 'Review reports of harmful content, and block or unblock file and record hashes.',
    stewardOnly: true,
  },
  // Hidden until the discussion API exists (lib/features.ts).
  ...(!features.discussion
    ? []
    : [
        {
          name: 'Discussion Review',
          href: '/admin/discussion',
          description:
            'Moderate comments on the protocol specification. Approve, decline, and resolve threads.',
          stewardOnly: true,
        },
      ]),
]

export default function Superadmin() {
  const { currentUser } = useAppContext()

  const isSteward = currentUser?.kfRole === 'admin'

  if (!isSteward) {
    return (
      <BaseLayout>
        <div className="mx-auto max-w-2xl px-4 py-16 text-center">
          <p className="text-ink-muted text-sm">This page is only available to admins.</p>
        </div>
      </BaseLayout>
    )
  }

  return (
    <BaseLayout>
      <div className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="mb-2 text-2xl font-semibold">Admin</h1>
        <p className="text-ink-muted mb-8 text-sm">Steward tools for the Underlay instance.</p>

        <div className="space-y-3">
          {tools.map((tool) => (
            <Link
              key={tool.href}
              to={tool.href}
              className="border-rule hover:border-ink-muted/50 rounded-surface block border px-4 py-3 transition-all hover:shadow-sm"
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold">{tool.name}</span>
                <span className="text-ink-muted text-xs">&rarr;</span>
              </div>
              <p className="text-ink-muted mt-0.5 text-xs">{tool.description}</p>
            </Link>
          ))}
        </div>
      </div>
    </BaseLayout>
  )
}
