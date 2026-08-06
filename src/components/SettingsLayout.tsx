import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router'

import BaseLayout from '~/components/BaseLayout'

/**
 * Shared shell for every settings surface (user, org, collection): a sticky
 * left rail of sections, one title style, one content width.
 *
 * Rail items navigate routes (`to: '/settings/keys'`) or in-page anchors
 * (`to: '#webhooks'`). Anchor rails get scrollspy: wrap each section in an
 * element with `id` and `data-settings-section` and the rail tracks scroll.
 */

export interface SettingsRailItem {
  label: string
  to: string
  danger?: boolean
}

export interface SettingsRailGroup {
  heading?: string
  items: SettingsRailItem[]
}

export const userSettingsRail: SettingsRailGroup[] = [
  {
    heading: 'Account',
    items: [
      { label: 'Profile', to: '/settings' },
      { label: 'API keys', to: '/settings/keys' },
      { label: 'Sessions', to: '/settings/sessions' },
    ],
  },
]

export function orgSettingsRail(owner: string): SettingsRailGroup[] {
  return [
    {
      heading: 'Organization',
      items: [
        { label: 'Profile', to: `/${owner}/settings` },
        { label: 'Members', to: `/${owner}/settings/members` },
      ],
    },
    {
      heading: 'Access',
      items: [{ label: 'API keys', to: `/${owner}/settings/keys` }],
    },
  ]
}

export const collectionSettingsRail: SettingsRailGroup[] = [
  {
    heading: 'Collection',
    items: [
      { label: 'Basics', to: '#basics' },
      { label: 'Metadata', to: '#metadata' },
      { label: 'Export', to: '#export' },
    ],
  },
  {
    heading: 'Integrations',
    items: [
      { label: 'ARK identifiers', to: '#ark' },
      { label: 'Webhooks', to: '#webhooks' },
    ],
  },
  {
    heading: 'Advanced',
    items: [
      { label: 'Transfer', to: '#transfer' },
      { label: 'Danger zone', to: '#danger', danger: true },
    ],
  },
]

const itemBase = 'block border-l-2 px-2.5 py-1.5 text-sm transition-colors'
const itemActive = `${itemBase} border-ink bg-parchment-dark text-ink font-medium`
const itemInactive = `${itemBase} border-transparent text-ink-light hover:text-ink`
const itemDanger = `${itemBase} border-transparent text-red-700/80 hover:text-red-700`

function RailLink({ item, active }: { item: SettingsRailItem; active: boolean }) {
  const className = active ? itemActive : item.danger ? itemDanger : itemInactive
  if (item.to.startsWith('#')) {
    return (
      <a href={item.to} className={className}>
        {item.label}
      </a>
    )
  }
  return (
    <Link to={item.to} className={className}>
      {item.label}
    </Link>
  )
}

export default function SettingsLayout({
  crumb,
  title,
  description,
  groups,
  children,
}: {
  /** Breadcrumb above the rail+content area, e.g. owner / collection. */
  crumb?: React.ReactNode
  title: string
  description?: string
  groups: SettingsRailGroup[]
  children: React.ReactNode
}) {
  const location = useLocation()
  const anchorIds = groups.flatMap((g) =>
    g.items.filter((i) => i.to.startsWith('#')).map((i) => i.to.slice(1)),
  )
  const [activeAnchor, setActiveAnchor] = useState<string | null>(null)

  useEffect(() => {
    if (anchorIds.length === 0) return
    const sections = Array.from(document.querySelectorAll('[data-settings-section]'))
    if (sections.length === 0) return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActiveAnchor(entry.target.id)
        }
      },
      { rootMargin: '-10% 0px -70% 0px' },
    )
    sections.forEach((s) => observer.observe(s))
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorIds.length])

  function isActive(item: SettingsRailItem): boolean {
    if (item.to.startsWith('#')) {
      const id = item.to.slice(1)
      return activeAnchor ? activeAnchor === id : anchorIds[0] === id
    }
    return location.pathname === item.to
  }

  return (
    <BaseLayout>
      <div className="mx-auto max-w-5xl px-4 py-8">
        {crumb && <div className="mb-4 text-sm">{crumb}</div>}
        <div className="flex items-start gap-8">
          <nav className="sticky top-6 hidden w-44 shrink-0 md:block" aria-label="Settings">
            {groups.map((group, i) => (
              <div key={i} className="mb-5">
                {group.heading && (
                  <p className="text-ink-muted mb-1.5 px-2.5 font-mono text-[10px] tracking-widest uppercase">
                    {group.heading}
                  </p>
                )}
                <div className="space-y-0.5">
                  {group.items.map((item) => (
                    <RailLink key={item.to} item={item} active={isActive(item)} />
                  ))}
                </div>
              </div>
            ))}
          </nav>

          <div className="max-w-2xl min-w-0 flex-1">
            {/* Mobile: the rail collapses to a scrollable row above the content. */}
            <nav
              className="border-rule mb-6 flex gap-1 overflow-x-auto border-b pb-2 md:hidden"
              aria-label="Settings"
            >
              {groups
                .flatMap((g) => g.items)
                .map((item) => (
                  <RailLink key={item.to} item={item} active={isActive(item)} />
                ))}
            </nav>

            <h1 className="mb-1 text-xl font-semibold tracking-tight">{title}</h1>
            {description ? (
              <p className="text-ink-muted mb-6 text-sm">{description}</p>
            ) : (
              <div className="mb-6" />
            )}
            {children}
          </div>
        </div>
      </div>
    </BaseLayout>
  )
}
