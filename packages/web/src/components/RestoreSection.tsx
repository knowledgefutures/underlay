import { type FormEvent, useEffect, useState } from 'react'
import { Link } from 'react-router'

import { Alert, Badge, Button, Field, Input, SectionHeading, Select } from '~/components/ui'

/**
 * Restoring a collection from one of the org's storage locations, on the org's
 * Storage page (packages/server/src/api/locations.ts, "restores"). A restore
 * rebuilds a collection that's gone from this instance, history and all, from
 * a mirror in a read-and-write location. It keeps the collection's id, so one
 * this instance still has can't be restored.
 */

export interface RestoreLocation {
  id: string
  name: string
  permissions: 'write' | 'read_write'
}

export interface Restore {
  id: string
  status: 'running' | 'done' | 'failed'
  collectionId: string
  sets: 'public' | 'all'
  restoredSeq: number
  error: string | null
  updatedAt: string
  slug: string | null
}

interface SourceCollection {
  id: string
  owner: string
  slug: string
  name: string
  versions: number
  latest: { semver: string; createdAt: string } | null
  keys: { id: string; own: boolean }[]
  present: boolean
}

const POLL_MS = 3000

const STATUS_STYLES: Record<Restore['status'], string> = {
  running: 'text-ink-muted',
  done: 'text-green-700',
  failed: 'text-red-700',
}

export default function RestoreSection({
  owner,
  locations,
  initialRestores,
}: {
  owner: string
  locations: RestoreLocation[]
  initialRestores: Restore[]
}) {
  const api = `/api/orgs/${owner}`
  const readable = locations.filter((l) => l.permissions === 'read_write')

  const [locationId, setLocationId] = useState('')
  const [found, setFound] = useState<{
    collections: SourceCollection[]
    truncated: boolean
  } | null>(null)
  const [picked, setPicked] = useState<SourceCollection | null>(null)
  const [slug, setSlug] = useState('')
  const [name, setName] = useState('')
  const [trust, setTrust] = useState<string[]>([])
  const [restores, setRestores] = useState<Restore[]>(initialRestores)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  // Follow running restores until they finish.
  const running = restores.some((r) => r.status === 'running')
  useEffect(() => {
    if (!running) return
    const t = setInterval(async () => {
      const res = await fetch(`${api}/restores`, { credentials: 'include' })
      if (res.ok) setRestores((await res.json()).restores ?? [])
    }, POLL_MS)
    return () => clearInterval(t)
  }, [running, api])

  async function look(id: string) {
    setLocationId(id)
    setFound(null)
    setPicked(null)
    setError('')
    setSuccess('')
    if (!id) return
    setBusy('look')
    try {
      const res = await fetch(`${api}/locations/${id}/collections`, { credentials: 'include' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) return setError(body.error ?? 'Could not read the location.')
      setFound(body)
    } finally {
      setBusy('')
    }
  }

  function pick(c: SourceCollection) {
    setPicked(c)
    setSlug(c.slug)
    setName(c.name)
    setTrust([])
    setError('')
    setSuccess('')
  }

  async function handleRestore(e: FormEvent) {
    e.preventDefault()
    if (!picked) return
    setError('')
    setSuccess('')
    setBusy('restore')
    try {
      const res = await fetch(`${api}/restores`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          locationId,
          collectionId: picked.id,
          slug: slug.trim(),
          name: name.trim() || undefined,
          trustKeyIds: trust,
        }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) return setError(body.error ?? 'Failed to start the restore.')
      setRestores((prev) => [{ ...body.restore, slug: body.collection.slug }, ...prev])
      setSuccess(
        `Restoring ${picked.owner}/${picked.slug} as ${owner}/${body.collection.slug}: ${body.versions} version${body.versions === 1 ? '' : 's'}, oldest first.`,
      )
      setPicked(null)
      setFound((f) =>
        f
          ? {
              ...f,
              collections: f.collections.map((c) =>
                c.id === picked.id ? { ...c, present: true } : c,
              ),
            }
          : f,
      )
    } finally {
      setBusy('')
    }
  }

  const foreignKeys = picked?.keys.filter((k) => !k.own) ?? []
  const ownKey = picked?.keys.some((k) => k.own) ?? false

  return (
    <section id="restore" className="border-rule mt-10 border-t pt-6">
      <SectionHeading>Restore a collection</SectionHeading>
      <p className="text-ink-muted mb-3 text-sm">
        Bring back a collection that is gone from Underlay, history and all, from a mirror in one of
        your locations. Only locations with read and write access can be restored from.
      </p>

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

      {readable.length === 0 ? (
        <p className="text-ink-muted mb-4 text-sm">
          No location with read and write access. Add one above to restore from it.
        </p>
      ) : (
        <div className="mb-4 max-w-sm">
          <label htmlFor="restoreLocation" className="mb-1 block text-xs font-medium">
            Restore from
          </label>
          <Select
            id="restoreLocation"
            value={locationId}
            onChange={(e) => look(e.target.value)}
            disabled={busy !== ''}
          >
            <option value="">— Select a location —</option>
            {readable.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </div>
      )}

      {busy === 'look' && <p className="text-ink-muted mb-4 text-sm">Reading the location…</p>}

      {found &&
        (found.collections.length === 0 ? (
          <p className="text-ink-muted mb-4 text-sm">This location holds no collections.</p>
        ) : (
          <div className="border-rule rounded-surface mb-4 overflow-x-auto border">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-parchment-dark border-rule border-b">
                  <th className="p-2.5 text-left font-medium">Collection</th>
                  <th className="p-2.5 text-left font-medium">Versions</th>
                  <th className="p-2.5 text-left font-medium">Latest</th>
                  <th className="p-2.5 text-right font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {found.collections.map((c) => (
                  <tr key={c.id} className="border-rule border-t">
                    <td className="p-2.5">
                      <span className="font-medium">
                        {c.owner}/{c.slug}
                      </span>
                      {c.name !== c.slug && <span className="text-ink-muted ml-2">{c.name}</span>}
                    </td>
                    <td className="p-2.5">{c.versions}</td>
                    <td className="text-ink-muted p-2.5">
                      {c.latest
                        ? `${c.latest.semver} · ${new Date(c.latest.createdAt).toLocaleDateString('en-US', { timeZone: 'UTC' })}`
                        : '—'}
                    </td>
                    <td className="p-2.5 text-right">
                      {c.present ? (
                        <Badge>On this instance</Badge>
                      ) : (
                        <Button
                          variant="link"
                          size="sm"
                          disabled={busy !== ''}
                          onClick={() => pick(c)}
                        >
                          Restore…
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {found.truncated && (
              <p className="text-ink-muted border-rule border-t p-2.5 text-xs">
                Showing the first {found.collections.length} collections in this location.
              </p>
            )}
          </div>
        ))}

      {picked && (
        <form
          onSubmit={handleRestore}
          className="border-rule rounded-surface mb-6 space-y-3 border p-4"
        >
          <h3 className="text-sm font-semibold">
            Restore {picked.owner}/{picked.slug} into {owner}
          </h3>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field label="Slug" htmlFor="restoreSlug">
              <Input
                id="restoreSlug"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                className="font-mono"
                required
              />
            </Field>
            <Field label="Name" htmlFor="restoreName">
              <Input id="restoreName" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          </div>
          {foreignKeys.length > 0 && (
            <fieldset className="space-y-1">
              <legend className="mb-1 text-xs font-medium">Signing keys to trust</legend>
              <p className="text-ink-muted text-xs">
                {ownKey
                  ? 'This instance signed some of this history. '
                  : "This instance didn't sign this history. "}
                Trust another key only if you know this collection's log came from the deployment
                holding it; the restore refuses any entry no trusted key signed.
              </p>
              {foreignKeys.map((k) => (
                <label key={k.id} className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={trust.includes(k.id)}
                    onChange={(e) =>
                      setTrust((t) =>
                        e.target.checked ? [...t, k.id] : t.filter((x) => x !== k.id),
                      )
                    }
                  />
                  <code className="font-mono">{k.id}</code>
                </label>
              ))}
            </fieldset>
          )}
          <p className="text-ink-muted text-xs">
            The collection comes back private, with the id it had. Its versions are copied one at a
            time; large collections take a while.
          </p>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={busy !== '' || !slug.trim()}>
              {busy === 'restore' ? 'Starting…' : 'Start restore'}
            </Button>
            <Button variant="ghost" type="button" onClick={() => setPicked(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {restores.length > 0 && (
        <div>
          <h3 className="text-ink-muted mb-2 text-xs font-semibold">Recent restores</h3>
          <div className="space-y-2">
            {restores.map((r) => (
              <div
                key={r.id}
                className="border-rule rounded-surface flex flex-wrap items-center justify-between gap-2 border px-3 py-2 text-sm"
              >
                <div className="min-w-0">
                  {r.slug ? (
                    <Link
                      to={`/${owner}/${r.slug}`}
                      className="text-link font-medium hover:underline"
                    >
                      {owner}/{r.slug}
                    </Link>
                  ) : (
                    <span className="text-ink-muted">deleted collection</span>
                  )}
                  <span className={`ml-2 text-xs ${STATUS_STYLES[r.status]}`}>{r.status}</span>
                  <span className="text-ink-muted ml-2 text-xs">
                    {r.restoredSeq} version{r.restoredSeq === 1 ? '' : 's'} restored
                    {r.sets === 'public' ? ' · public records only' : ''}
                  </span>
                  {r.error && <p className="mt-1 text-xs break-words text-red-700">{r.error}</p>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}
