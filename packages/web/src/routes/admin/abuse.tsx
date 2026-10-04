import { useCallback, useEffect, useState } from 'react'

import BaseLayout from '~/components/BaseLayout'
import { Alert, Badge, Button, SectionHeading, Select } from '~/components/ui'
import { useAppContext } from '~/lib/app-context'

/**
 * Stewards: open abuse reports, and the hash denylist. Blocking a hash stops
 * every file redirect and record read of it within a minute
 * (packages/server/src/lib/limits.ts); it changes no version.
 */

interface Report {
  id: string
  hash: string | null
  url: string | null
  reason: string
  contact: string | null
  createdAt: string
}

interface Entry {
  hash: string
  kind: 'file' | 'record'
  reason: string
  createdAt: string
}

export default function AdminAbuse() {
  const { currentUser } = useAppContext()
  const isSteward = currentUser?.kfRole === 'admin'
  const [reports, setReports] = useState<Report[]>([])
  const [entries, setEntries] = useState<Entry[]>([])
  const [kinds, setKinds] = useState<Record<string, Entry['kind']>>({})
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    const [r, d] = await Promise.all([
      fetch('/api/admin/abuse-reports', { credentials: 'include' }),
      fetch('/api/admin/denylist', { credentials: 'include' }),
    ])
    if (r.ok) setReports((await r.json()).reports ?? [])
    if (d.ok) setEntries((await d.json()).entries ?? [])
  }, [])

  useEffect(() => {
    if (isSteward) void load()
  }, [isSteward, load])

  async function send(url: string, method: string, body?: unknown) {
    setError('')
    const res = await fetch(url, {
      method,
      credentials: 'include',
      ...(body
        ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
        : {}),
    })
    if (!res.ok) setError((await res.json().catch(() => null))?.error ?? 'That failed.')
    await load()
  }

  if (!isSteward) {
    return (
      <BaseLayout>
        <div className="mx-auto max-w-2xl px-4 py-16 text-center">
          <p className="text-ink-muted text-sm">This page is only available to admins.</p>
        </div>
      </BaseLayout>
    )
  }

  return (
    <BaseLayout>
      <div className="mx-auto max-w-4xl px-4 py-10">
        <h1 className="mb-6 text-xl font-semibold tracking-tight">Abuse reports</h1>
        {error && (
          <Alert variant="error" className="mb-4">
            {error}
          </Alert>
        )}

        <SectionHeading>Open reports ({reports.length})</SectionHeading>
        {reports.length === 0 ? (
          <p className="text-ink-muted mb-8 text-sm">No open reports.</p>
        ) : (
          <div className="mb-8 space-y-3">
            {reports.map((r) => (
              <div key={r.id} className="border-rule rounded-surface border p-3 text-sm">
                <p className="mb-1 whitespace-pre-wrap">{r.reason}</p>
                <div className="text-ink-muted space-y-0.5 text-xs">
                  {r.url && <p className="break-all">{r.url}</p>}
                  {r.hash && <p className="font-mono break-all">{r.hash}</p>}
                  <p>
                    {new Date(r.createdAt).toLocaleString('en-US', { timeZone: 'UTC' })} UTC
                    {r.contact ? ` · ${r.contact}` : ''}
                  </p>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  {r.hash && (
                    <>
                      <Select
                        value={kinds[r.id] ?? 'file'}
                        onChange={(e) =>
                          setKinds((k) => ({ ...k, [r.id]: e.target.value as Entry['kind'] }))
                        }
                        className="w-auto"
                      >
                        <option value="file">File</option>
                        <option value="record">Record</option>
                      </Select>
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() =>
                          send('/api/admin/denylist', 'POST', {
                            hash: r.hash,
                            kind: kinds[r.id] ?? 'file',
                            reason: r.reason.slice(0, 500),
                            reportId: r.id,
                          })
                        }
                      >
                        Block hash
                      </Button>
                    </>
                  )}
                  <Button
                    variant="link"
                    size="sm"
                    onClick={() =>
                      send(`/api/admin/abuse-reports/${r.id}`, 'PATCH', { status: 'dismissed' })
                    }
                  >
                    Dismiss
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        <SectionHeading>Denylist ({entries.length})</SectionHeading>
        {entries.length === 0 ? (
          <p className="text-ink-muted text-sm">Nothing is blocked.</p>
        ) : (
          <div className="space-y-2">
            {entries.map((e) => (
              <div
                key={e.hash}
                className="border-rule rounded-surface flex items-start justify-between gap-3 border px-3 py-2 text-sm"
              >
                <div className="min-w-0">
                  <p className="font-mono text-xs break-all">{e.hash}</p>
                  <p className="text-ink-muted text-xs">
                    <Badge>{e.kind}</Badge> {e.reason}
                  </p>
                </div>
                <Button
                  variant="link"
                  size="sm"
                  onClick={() => send(`/api/admin/denylist/${e.hash}`, 'DELETE')}
                >
                  Unblock
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </BaseLayout>
  )
}
