import BaseLayout from '~/components/BaseLayout'
import MirrorAdmin from '~/components/MirrorAdmin'
import { useSSRData } from '~/lib/ssr-data'

interface MirrorConfig {
  enabled: boolean
  nodeName: string
  upstream: string
  syncSchedule: string
}

export default function AdminMirror() {
  const me = useSSRData<any>('currentUser')
  const mirrorConfig = useSSRData<MirrorConfig>('mirrorConfig')

  if (!mirrorConfig?.enabled) {
    if (typeof window !== 'undefined') {
      window.location.href = '/'
    }
    return null
  }

  if (!me) return null

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
