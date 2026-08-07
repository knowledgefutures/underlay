import { useEffect, useState } from 'react'

import SettingsLayout, { userSettingsRail } from '~/components/SettingsLayout'
import { Alert, Button, SectionHeading } from '~/components/ui'
import { useAppContext } from '~/lib/app-context'

interface Session {
  id: string
  userAgent: string | null
  ipAddress: string | null
  createdAt: string
  expiresAt: string
  current: boolean
}

function parseUserAgent(ua: string | null): string {
  if (!ua) return 'Unknown device'
  if (ua.includes('Firefox')) return 'Firefox'
  if (ua.includes('Chrome') && !ua.includes('Edg')) return 'Chrome'
  if (ua.includes('Edg')) return 'Edge'
  if (ua.includes('Safari') && !ua.includes('Chrome')) return 'Safari'
  if (ua.includes('curl')) return 'curl'
  return 'Unknown browser'
}

export default function SettingsSessions() {
  const { currentUser } = useAppContext()

  const [sessions, setSessions] = useState<Session[]>([])
  const [success, setSuccess] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!currentUser) return
    fetch('/api/accounts/me/sessions', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : []))
      .then(setSessions)
  }, [currentUser])

  async function handleRevoke(sessionId: string) {
    setSuccess('')
    setError('')
    const res = await fetch(`/api/accounts/me/sessions/${sessionId}`, {
      method: 'DELETE',
      credentials: 'include',
    })
    if (res.ok) {
      setSuccess('Session revoked.')
      setSessions((prev) => prev.filter((s) => s.id !== sessionId))
    } else {
      setError('Failed to revoke session.')
    }
  }

  return (
    <SettingsLayout
      title="Sessions"
      description="Devices currently logged into your account. Revoke any session you don't recognize."
      groups={userSettingsRail}
    >
      {success && (
        <Alert variant="success" className="mb-4">
          {success}
        </Alert>
      )}
      {error && (
        <Alert variant="error" className="mb-4">
          {error}
        </Alert>
      )}

      <SectionHeading>Active sessions ({sessions.length})</SectionHeading>

      {sessions.length === 0 ? (
        <p className="text-ink-muted text-sm">No active sessions.</p>
      ) : (
        <div className="space-y-2">
          {sessions.map((s) => (
            <div
              key={s.id}
              className="border-rule rounded-surface flex items-center justify-between border p-3"
            >
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{parseUserAgent(s.userAgent)}</span>
                  {s.current && (
                    <span className="rounded-control border border-green-200 bg-green-100 px-1.5 py-0.5 text-xs text-green-800">
                      Current
                    </span>
                  )}
                </div>
                <div className="text-ink-muted mt-0.5 flex items-center gap-2 text-xs">
                  {s.ipAddress && <span>{s.ipAddress}</span>}
                  <span>Created {new Date(s.createdAt).toLocaleDateString()}</span>
                  <span>· Expires {new Date(s.expiresAt).toLocaleDateString()}</span>
                </div>
              </div>
              {!s.current && (
                <Button variant="dangerLink" size="sm" onClick={() => handleRevoke(s.id)}>
                  Revoke
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </SettingsLayout>
  )
}
