import { useEffect, useState } from 'react'

import ApiKeysPanel from '~/components/ApiKeysPanel'
import SettingsLayout, { userSettingsRail } from '~/components/SettingsLayout'
import { useAppContext } from '~/lib/app-context'

export default function SettingsKeys() {
  const { currentUser } = useAppContext()

  const [collections, setCollections] = useState<{ id: string; slug: string }[]>([])

  useEffect(() => {
    if (!currentUser) return
    fetch(`/api/accounts/${currentUser.slug}/collections`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : []))
      .then(setCollections)
  }, [currentUser])

  return (
    <SettingsLayout
      title="API keys"
      description="Keys for pushing and pulling data with the API or CLI."
      groups={userSettingsRail}
    >
      <ApiKeysPanel owner={currentUser.slug} collections={collections} />
    </SettingsLayout>
  )
}
