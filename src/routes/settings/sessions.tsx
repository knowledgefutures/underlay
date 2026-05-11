import { useEffect, useState, } from 'react'
import { Link, } from 'react-router'
import BaseLayout from '~/components/BaseLayout'
import { useSSRData, } from '~/lib/ssr-data'

interface Session {
  id: string
  userAgent: string | null
  ipAddress: string | null
  createdAt: string
  expiresAt: string
  current: boolean
}

function parseUserAgent(ua: string | null,): string {
  if (!ua) return 'Unknown device'
  if (ua.includes('Firefox',)) return 'Firefox'
  if (ua.includes('Chrome',) && !ua.includes('Edg',)) return 'Chrome'
  if (ua.includes('Edg',)) return 'Edge'
  if (ua.includes('Safari',) && !ua.includes('Chrome',)) return 'Safari'
  if (ua.includes('curl',)) return 'curl'
  return 'Unknown browser'
}

export default function SettingsSessions() {
  const me = useSSRData<any>('currentUser',)

  const [sessions, setSessions,] = useState<Session[]>([],)
  const [success, setSuccess,] = useState('',)
  const [error, setError,] = useState('',)

  useEffect(() => {
    if (!me) return
    fetch('/api/accounts/me/sessions', { credentials: 'include', },)
      .then((r,) => (r.ok ? r.json() : []))
      .then(setSessions,)
  }, [me,],)

  async function handleRevoke(sessionId: string,) {
    setSuccess('',)
    setError('',)
    const res = await fetch(`/api/accounts/me/sessions/${sessionId}`, {
      method: 'DELETE',
      credentials: 'include',
    },)
    if (res.ok) {
      setSuccess('Session revoked.',)
      setSessions((prev,) => prev.filter((s,) => s.id !== sessionId))
    } else {
      setError('Failed to revoke session.',)
    }
  }

  if (!me) return null

  return (
    <BaseLayout>
      <div className='max-w-4xl mx-auto px-4 py-10'>
        <h1 className='text-xl font-semibold tracking-tight mb-6'>Settings</h1>

        <nav className='flex gap-4 text-sm border-b border-rule mb-6 pb-2'>
          <Link to='/settings' className='text-ink-muted hover:text-ink'>Account</Link>
          <Link to='/settings/keys' className='text-ink-muted hover:text-ink'>API Keys</Link>
          <Link to='/settings/sessions' className='text-ink font-medium'>Sessions</Link>
        </nav>

        {success && (
          <p className='text-sm text-green-800 bg-green-50 border border-green-200 px-3 py-2 mb-4'>{success}</p>
        )}
        {error && <p className='text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 mb-4'>{error}</p>}

        <h2 className='text-sm font-semibold uppercase tracking-wide text-ink-muted mb-3'>
          Active Sessions ({sessions.length})
        </h2>
        <p className='text-xs text-ink-muted mb-4'>
          These are the devices currently logged into your account. Revoke any session you don't recognize.
        </p>

        {sessions.length === 0
          ? <p className='text-sm text-ink-muted'>No active sessions.</p>
          : (
            <div className='space-y-2'>
              {sessions.map((s,) => (
                <div key={s.id} className='flex items-center justify-between border border-rule p-3'>
                  <div>
                    <div className='flex items-center gap-2'>
                      <span className='text-sm font-medium'>{parseUserAgent(s.userAgent,)}</span>
                      {s.current && (
                        <span className='text-xs bg-green-100 text-green-800 px-1.5 py-0.5 border border-green-200'>
                          Current
                        </span>
                      )}
                    </div>
                    <div className='flex items-center gap-2 mt-0.5 text-xs text-ink-muted'>
                      {s.ipAddress && <span>{s.ipAddress}</span>}
                      <span>Created {new Date(s.createdAt,).toLocaleDateString()}</span>
                      <span>· Expires {new Date(s.expiresAt,).toLocaleDateString()}</span>
                    </div>
                  </div>
                  {!s.current && (
                    <button
                      onClick={() => handleRevoke(s.id,)}
                      className='text-xs text-red-700 hover:underline'
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
