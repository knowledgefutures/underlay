import { useEffect } from 'react'
import { Link, useLoaderData, useParams } from 'react-router'

import type { OrgCollection } from '~/components/org-page'
import OrgPageSettings from '~/components/org-page-settings'
import SettingsLayout, { orgSettingsRail } from '~/components/SettingsLayout'
import { useAppContext } from '~/lib/app-context'

/** How the organization's public page looks: cover, pinned collections, provenance note. */
export default function OwnerPageSettings() {
  const { owner } = useParams()
  const { currentUser } = useAppContext()
  const { orgData, collections } = useLoaderData() as {
    orgData: any
    collections: OrgCollection[]
  }

  const org = currentUser?.orgs?.find((o: any) => o.slug === owner)
  const isOwner = org?.role === 'owner'

  // Not a member: send them to the public page. In an effect, not during render.
  const notMember = !!currentUser && !org
  useEffect(() => {
    if (notMember) window.location.href = `/${owner}`
  }, [notMember, owner])
  if (notMember) return null

  return (
    <SettingsLayout
      crumb={
        <nav>
          <Link to={`/${owner}`} className="text-link hover:underline">
            {owner}
          </Link>{' '}
          <span className="text-ink-muted">/</span> <span className="text-ink-muted">settings</span>
        </nav>
      }
      title="Page"
      description="How the organization's public page looks."
      groups={orgSettingsRail(owner!)}
    >
      {isOwner ? (
        <OrgPageSettings
          owner={owner!}
          org={{ displayName: orgData.displayName ?? owner!, avatarUrl: orgData.avatarUrl ?? null }}
          initial={{
            coverColor: orgData.coverColor ?? null,
            coverImageUrl: orgData.coverImageUrl ?? null,
            coverTint: orgData.coverTint ?? true,
            pinned: orgData.pinned ?? [],
            provenanceNote: orgData.provenanceNote ?? null,
          }}
          collections={collections}
        />
      ) : (
        <p className="text-ink-muted text-sm">Only organization owners can change the page.</p>
      )}
    </SettingsLayout>
  )
}
