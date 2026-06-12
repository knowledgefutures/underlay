import { Link } from 'react-router'

import BaseLayout from '~/components/BaseLayout'
import { useAppContext } from '~/lib/app-context'

const tools = [
  {
    name: 'Explore Page',
    href: '/admin/explore-tags',
    description: 'Manage featured collections and tag filters on the explore page.',
    stewardOnly: true,
  },
  {
    name: 'Discussion Review',
    href: '/admin/discussion',
    description:
      'Moderate comments on the protocol specification. Approve, decline, and resolve threads.',
    stewardOnly: true,
  },
  {
    name: 'Mirror Admin',
    href: '/admin/mirror',
    description: 'Configure and monitor mirror sync with an upstream Underlay server.',
    mirrorOnly: true,
  },
  {
    name: 'API Reference',
    href: '/api/reference',
    description: 'Interactive API documentation powered by Scalar.',
    stewardOnly: false,
  },
  {
    name: 'OpenAPI Spec',
    href: '/api/openapi.json',
    description: 'Raw OpenAPI JSON document for the Underlay API.',
    stewardOnly: false,
  },
]

export default function Superadmin() {
  const { currentUser, mirrorConfig } = useAppContext()

  const isSteward = currentUser?.kfRole === 'admin'

  if (!isSteward) {
    return (
      <BaseLayout>
        <div className="mx-auto max-w-2xl px-4 py-16 text-center">
          <p className="text-ink-muted text-sm">This page is only available to stewards.</p>
        </div>
      </BaseLayout>
    )
  }

  const visibleTools = tools.filter((t) => {
    if (t.mirrorOnly && !mirrorConfig?.enabled) return false
    return true
  })

  return (
    <BaseLayout>
      <div className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="mb-2 text-2xl font-semibold">Admin</h1>
        <p className="text-ink-muted mb-8 text-sm">Steward tools for the Underlay instance.</p>

        <div className="space-y-3">
          {visibleTools.map((tool) => (
            <Link
              key={tool.href}
              to={tool.href}
              className="border-rule hover:border-ink-muted/50 block rounded border px-4 py-3 transition-all hover:shadow-sm"
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
