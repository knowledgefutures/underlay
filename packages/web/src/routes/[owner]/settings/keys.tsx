import { Link, useLoaderData, useParams } from 'react-router'

import ApiKeysPanel from '~/components/ApiKeysPanel'
import SettingsLayout, { orgSettingsRail } from '~/components/SettingsLayout'
import { useAppContext } from '~/lib/app-context'

export default function OwnerSettingsKeys() {
  const { owner } = useParams()
  const { currentUser } = useAppContext()
  const { collections } = useLoaderData() as { collections: any[] }

  const org = currentUser?.orgs?.find((o: any) => o.slug === owner)
  const isAdmin = org?.role === 'admin' || org?.role === 'owner'

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
      title="API keys"
      description="Keys for pushing and pulling this organization's collections. Keys belong to you, not the organization."
      groups={orgSettingsRail(owner!)}
    >
      <ApiKeysPanel owner={owner!} collections={collections} canManage={isAdmin} org />
    </SettingsLayout>
  )
}
