import { useEffect, useState } from 'react'
import { Link, Navigate } from 'react-router'

import BaseLayout from '~/components/BaseLayout'
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

export const handle = { title: 'Sessions — Underlay', requireAuth: true }

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

  if (!currentUser) return <Navigate to="/login" replace />

  return (
    <BaseLayout>
      <div className="mx-auto max-w-4xl px-4 py-10">
        <h1 className="mb-6 text-xl font-semibold tracking-tight">Settings</h1>

        <nav className="border-rule mb-6 flex gap-4 border-b pb-2 text-sm">
          <Link to="/settings" className="text-ink-muted hover:text-ink">
            Account
          </Link>
          <Link to="/settings/keys" className="text-ink-muted hover:text-ink">
            API Keys
          </Link>
          <Link to="/settings/sessions" className="text-ink font-medium">
            Sessions
          </Link>
        </nav>

        {success && (
          <p className="mb-4 border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
            {success}
          </p>
        )}
        {error && (
          <p className="mb-4 border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}

        <h2 className="text-ink-muted mb-3 text-sm font-semibold tracking-wide uppercase">
          Active Sessions ({sessions.length})
        </h2>
        <p className="text-ink-muted mb-4 text-xs">
          These are the devices currently logged into your account. Revoke any session you don't
          recognize.
        </p>

        {sessions.length === 0 ? (
          <p className="text-ink-muted text-sm">No active sessions.</p>
        ) : (
          <div className="space-y-2">
            {sessions.map((s) => (
              <div key={s.id} className="border-rule flex items-center justify-between border p-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{parseUserAgent(s.userAgent)}</span>
                    {s.current && (
                      <span className="border border-green-200 bg-green-100 px-1.5 py-0.5 text-xs text-green-800">
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
                  <button
                    onClick={() => handleRevoke(s.id)}
                    className="text-xs text-red-700 hover:underline"
                  >
                    Revoke
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </BaseLayout>
  )
}
