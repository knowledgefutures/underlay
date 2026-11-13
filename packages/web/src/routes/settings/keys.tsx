import { useEffect, useState } from 'react'

import ApiKeysPanel from '~/components/ApiKeysPanel'
import SettingsLayout, { accountCrumb, userSettingsRail } from '~/components/SettingsLayout'
import { useAppContext } from '~/lib/app-context'

export default function SettingsKeys() {
  const { currentUser } = useAppContext()
  // The playground and the collection picker use one org: the first by name.
  const owner: string =
    [...(currentUser?.orgs ?? [])].sort((a: any, b: any) =>
      a.displayName.localeCompare(b.displayName),
    )[0]?.slug ?? ''

  const [collections, setCollections] = useState<{ id: string; slug: string }[]>([])

  useEffect(() => {
    if (!owner) return
    fetch(`/api/accounts/${owner}/collections`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : []))
      .then(setCollections)
  }, [owner])

  return (
    <SettingsLayout
      crumb={accountCrumb}
      title="API keys"
      description="Keys for pushing and pulling data with the API or CLI. A key made here works in every organization you belong to; make one on an organization's settings page to limit it to that organization."
      groups={userSettingsRail}
    >
      <ApiKeysPanel owner={owner} collections={collections} />
    </SettingsLayout>
  )
}
