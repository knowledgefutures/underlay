import BaseLayout from '~/components/BaseLayout'
import MirrorAdmin from '~/components/MirrorAdmin'
import { useAppContext } from '~/lib/app-context'

export const handle = { title: 'Mirror Admin — Underlay' }

export default function AdminMirror() {
  const { currentUser, mirrorConfig } = useAppContext()

  if (!mirrorConfig?.enabled) {
    if (typeof window !== 'undefined') {
      window.location.href = '/'
    }
    return null
  }

  if (!currentUser) return null

  return (
    <BaseLayout>
      <div className="mx-auto max-w-4xl px-4 py-8">
        <h1 className="mb-2 text-2xl font-semibold">Mirror Administration</h1>
        <p className="text-ink-muted mb-8 text-sm">
          Configure and monitor this node's sync with the upstream Underlay server.
        </p>
        <MirrorAdmin
          upstream={mirrorConfig.upstream}
          nodeName={mirrorConfig.nodeName}
          syncSchedule={mirrorConfig.syncSchedule}
        />
      </div>
    </BaseLayout>
  )
}
