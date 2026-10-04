import { type FormEvent, useEffect, useState } from 'react'
import { Link } from 'react-router'

import { Alert, Badge, Button, Select, Table, Td, Th } from '~/components/ui'
import { timeAgo } from '~/lib/format'

/**
 * Where a collection is stored: its primary and any mirrors to the org's
 * storage locations, with how far each mirror has copied (packages/server
 * src/api/locations.ts). Members see the status; org owners and admins can add
 * a mirror, sync one now, or remove one. Mirrors from an org default are
 * managed in the org's storage settings.
 */

export interface Placement {
  id: string
  role: 'primary' | 'mirror'
  sets: 'public' | 'public+private'
  inherited: boolean
  state: 'active' | 'backfilling' | 'lagging' | 'error' | 'paused'
  syncedSeq: number
  lag: number
  lastError: string | null
  updatedAt: string
  location: {
    id: string
    name: string
    kind: 'platform' | 's3'
    bucket: string | null
    prefix: string
    status: string
  }
}

export interface PlacementStatus {
  headSeq: number
  placements: Placement[]
}

export interface LocationOption {
  id: string
  name: string
  status: string
}

const STATE_STYLES: Record<Placement['state'], string> = {
  active: 'text-green-700',
  backfilling: 'text-amber-700',
  lagging: 'text-amber-700',
  error: 'text-red-700',
  paused: 'text-ink-muted',
}

/** States a sync job is working through; the panel polls while any mirror is in one. */
const MOVING = new Set<Placement['state']>(['backfilling', 'lagging'])
const POLL_MS = 4000

export const SETS_LABELS: Record<Placement['sets'], string> = {
  public: 'Public records',
  'public+private': 'Public and private records',
}

function where(l: Placement['location']): string {
  if (l.kind === 'platform') return 'Underlay storage'
  return [l.bucket, l.prefix].filter(Boolean).join('/')
}

export default function MirrorsSettings({
  owner,
  collection,
  initial,
  locations,
  canManage,
}: {
  owner: string
  collection: string
  initial: PlacementStatus
  /** The org's storage locations; empty when the viewer can't manage them. */
  locations: LocationOption[]
  canManage: boolean
}) {
  const base = `/api/collections/${owner}/${collection}/placements`

  const [status, setStatus] = useState<PlacementStatus>(initial)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState('')
  const [locationId, setLocationId] = useState('')
  const [sets, setSets] = useState<Placement['sets']>('public')

  async function refresh() {
    const res = await fetch(base, { credentials: 'include' })
    if (res.ok) setStatus(await res.json())
  }

  const moving = status.placements.some((p) => p.role === 'mirror' && MOVING.has(p.state))
  useEffect(() => {
    if (!moving) return
    const timer = setInterval(refresh, POLL_MS)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moving])

  /** Run one request, report it, refresh the table; true when it succeeded. */
  async function act(key: string, run: () => Promise<Response>, done: string) {
    setError('')
    setNotice('')
    setBusy(key)
    try {
      const res = await run()
      if (res.ok) {
        setNotice(done)
        await refresh()
        return true
      }
      const body = await res.json().catch(() => ({}))
      setError(body.error ?? 'Request failed.')
      return false
    } finally {
      setBusy('')
    }
  }

  async function handleAdd(e: FormEvent) {
    e.preventDefault()
    if (!locationId) return
    const added = await act(
      'add',
      () =>
        fetch(base, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ locationId, sets }),
        }),
      'Mirror added. Copying existing versions has started.',
    )
    if (added) setLocationId('')
  }

  const mirrored = new Set(status.placements.map((p) => p.location.id))
  const available = locations.filter((l) => !mirrored.has(l.id))

  return (
    <div>
      <p className="text-ink-muted mb-3 text-sm">
        Every version is stored in the primary location. Mirrors copy each version, its files and
        its signed version log into a bucket your organization controls, as a complete repository
        anyone with access to the bucket can read without Underlay.
      </p>

      {error && (
        <Alert variant="error" className="mb-4">
          {error}
        </Alert>
      )}
      {notice && (
        <Alert variant="success" className="mb-4">
          {notice}
        </Alert>
      )}

      <Table className="mb-4">
        <thead>
          <tr>
            <Th>Location</Th>
            <Th>Copies</Th>
            <Th>State</Th>
            <Th>Synced</Th>
            {canManage && <Th></Th>}
          </tr>
        </thead>
        <tbody>
          {status.placements.map((p) => (
            <tr key={p.id} className="align-top" data-placement={p.role}>
              <Td>
                <span className="font-medium">{p.location.name}</span> <Badge>{p.role}</Badge>
                {p.inherited && (
                  <Badge className="ml-1" title="Set for every collection in the organization">
                    org default
                  </Badge>
                )}
                <span className="text-ink-muted block font-mono text-xs break-all">
                  {where(p.location)}
                </span>
              </Td>
              <Td className="text-ink-muted text-xs">{SETS_LABELS[p.sets]}</Td>
              <Td>
                <span className={`font-medium ${STATE_STYLES[p.state]}`}>{p.state}</span>
                {p.lastError && (
                  <span className="text-ink-muted block text-xs break-words">{p.lastError}</span>
                )}
              </Td>
              <Td className="text-xs whitespace-nowrap">
                {p.role === 'primary' ? (
                  <span className="text-ink-muted">—</span>
                ) : (
                  <>
                    {p.syncedSeq} of {status.headSeq}
                    {p.lag > 0 && (
                      <span className="block text-amber-700">
                        {p.lag} {p.lag === 1 ? 'version' : 'versions'} behind
                      </span>
                    )}
                    <span className="text-ink-muted block">{timeAgo(p.updatedAt)}</span>
                  </>
                )}
              </Td>
              {canManage && (
                <Td className="text-xs whitespace-nowrap">
                  {p.role === 'mirror' && (
                    <div className="flex flex-col items-start gap-1">
                      <Button
                        variant="link"
                        size="sm"
                        disabled={busy !== ''}
                        onClick={() =>
                          act(
                            `sync:${p.id}`,
                            () =>
                              fetch(`${base}/${p.id}/sync`, {
                                method: 'POST',
                                credentials: 'include',
                              }),
                            `Sync to ${p.location.name} queued.`,
                          )
                        }
                      >
                        {busy === `sync:${p.id}` ? 'Queuing…' : 'Sync now'}
                      </Button>
                      {p.inherited ? (
                        <Link
                          to={`/${owner}/settings/storage`}
                          className="text-ink-muted hover:text-ink"
                        >
                          Manage in org
                        </Link>
                      ) : (
                        <Button
                          variant="dangerLink"
                          size="sm"
                          disabled={busy !== ''}
                          onClick={() =>
                            act(
                              `remove:${p.id}`,
                              () =>
                                fetch(`${base}/${p.id}`, {
                                  method: 'DELETE',
                                  credentials: 'include',
                                }),
                              `Stopped mirroring to ${p.location.name}. What it copied stays in the bucket.`,
                            )
                          }
                        >
                          {busy === `remove:${p.id}` ? 'Removing…' : 'Remove'}
                        </Button>
                      )}
                    </div>
                  )}
                </Td>
              )}
            </tr>
          ))}
        </tbody>
      </Table>

      {moving && (
        <p className="text-ink-muted mb-4 text-xs">Copying. This table refreshes on its own.</p>
      )}

      {canManage &&
        (locations.length === 0 ? (
          <p className="text-ink-muted text-sm">
            To add a mirror, first add a storage location in the{' '}
            <Link to={`/${owner}/settings/storage`} className="text-link hover:underline">
              organization's storage settings
            </Link>
            .
          </p>
        ) : available.length === 0 ? (
          <p className="text-ink-muted text-sm">
            This collection mirrors to every storage location the organization has.
          </p>
        ) : (
          <form
            onSubmit={handleAdd}
            className="border-rule rounded-surface flex flex-wrap items-end gap-3 border p-4"
          >
            <div className="min-w-0 flex-1">
              <label htmlFor="mirrorLocation" className="mb-1 block text-xs font-medium">
                Mirror to
              </label>
              <Select
                id="mirrorLocation"
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
                required
              >
                <option value="">— Select a location —</option>
                {available.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                    {l.status !== 'active' ? ` (${l.status})` : ''}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <label htmlFor="mirrorSets" className="mb-1 block text-xs font-medium">
                Copy
              </label>
              <Select
                id="mirrorSets"
                value={sets}
                onChange={(e) => setSets(e.target.value as Placement['sets'])}
              >
                {Object.entries(SETS_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </div>
            <Button type="submit" disabled={!locationId || busy !== ''}>
              {busy === 'add' ? 'Adding…' : 'Add mirror'}
            </Button>
          </form>
        ))}
    </div>
  )
}
