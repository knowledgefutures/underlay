import BaseLayout from '~/components/BaseLayout'
import { useSSRData } from '~/lib/ssr-data'
import MirrorAdmin from '~/components/MirrorAdmin'

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
      <div className="max-w-4xl mx-auto px-4 py-8">
        <h1 className="text-2xl font-semibold mb-2">Mirror Administration</h1>
        <p className="text-ink-muted text-sm mb-8">
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
