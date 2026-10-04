import { type FormEvent, useState } from 'react'
import { Link, useLoaderData, useParams } from 'react-router'

import { SETS_LABELS } from '~/components/MirrorsSettings'
import RestoreSection, { type Restore } from '~/components/RestoreSection'
import SettingsLayout, { orgSettingsRail } from '~/components/SettingsLayout'
import { Alert, Badge, Button, Field, Input, SectionHeading, Select } from '~/components/ui'

/**
 * An org's storage locations (S3-compatible buckets it controls) and its
 * default mirrors, which every collection in the org inherits, and restoring a
 * collection from a location. Owners and admins only
 * (packages/server/src/api/locations.ts).
 */

interface Location {
  id: string
  name: string
  kind: 's3'
  endpoint: string
  region: string | null
  bucket: string
  prefix: string
  permissions: 'write' | 'read_write'
  status: 'active' | 'unverified' | 'broken' | 'disabled'
  lastError: string | null
  verifiedAt: string | null
}

interface DefaultPlacement {
  id: string
  locationId: string
  sets: 'public' | 'public+private'
}

interface CheckResult {
  ok: boolean
  publicRead: boolean
  readBack: boolean
  error: string | null
}

const STATUS_STYLES: Record<Location['status'], string> = {
  active: 'text-green-700',
  unverified: 'text-ink-muted',
  broken: 'text-red-700',
  disabled: 'text-ink-muted',
}

const PERMISSION_LABELS: Record<Location['permissions'], string> = {
  write: 'Write only',
  read_write: 'Read and write',
}

function describeCheck(name: string, check: CheckResult): string {
  if (!check.ok) return `${name} failed its check: ${check.error ?? 'unknown error'}`
  const parts = [`${name} passed its check: Underlay can write`]
  if (check.readBack) parts.push('and read back')
  let text = parts.join(' ') + '.'
  if (check.publicRead) {
    text += ' Objects there can be read without credentials, so it can hold public records only.'
  }
  return text
}

const EMPTY_FORM = {
  name: '',
  endpoint: '',
  bucket: '',
  region: '',
  prefix: '',
  accessKeyId: '',
  secretAccessKey: '',
  permissions: 'write' as Location['permissions'],
}

export default function OwnerSettingsStorage() {
  const { owner } = useParams()
  const loaderData = useLoaderData() as {
    allowed: boolean
    locations: Location[]
    placements: DefaultPlacement[]
    restores: Restore[]
  }
  const api = `/api/orgs/${owner}`

  const [locations, setLocations] = useState<Location[]>(loaderData.locations)
  const [defaults, setDefaults] = useState<DefaultPlacement[]>(loaderData.placements)
  const [success, setSuccess] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const [form, setForm] = useState(EMPTY_FORM)
  const [defaultLocation, setDefaultLocation] = useState('')
  const [defaultSets, setDefaultSets] = useState<DefaultPlacement['sets']>('public')

  const field =
    (key: keyof typeof EMPTY_FORM) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }))

  function clearMessages() {
    setSuccess('')
    setError('')
  }

  async function failed(res: Response, fallback: string) {
    const body = await res.json().catch(() => ({}))
    setError(body.error ?? fallback)
  }

  async function refresh() {
    const [l, p] = await Promise.all([
      fetch(`${api}/locations`, { credentials: 'include' }),
      fetch(`${api}/placements`, { credentials: 'include' }),
    ])
    if (l.ok) setLocations((await l.json()).locations ?? [])
    if (p.ok) setDefaults((await p.json()).placements ?? [])
  }

  async function handleAdd(e: FormEvent) {
    e.preventDefault()
    clearMessages()
    setBusy('add')
    try {
      const res = await fetch(`${api}/locations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          ...form,
          region: form.region.trim() || undefined,
          prefix: form.prefix.trim() || undefined,
        }),
      })
      if (!res.ok) return failed(res, 'Failed to add the location.')
      const body = (await res.json()) as { location: Location; check: CheckResult }
      setLocations((prev) => [...prev, body.location])
      setForm(EMPTY_FORM)
      if (body.check.ok) setSuccess(describeCheck(body.location.name, body.check))
      else setError(describeCheck(body.location.name, body.check))
    } finally {
      setBusy('')
    }
  }

  async function handleCheck(loc: Location) {
    clearMessages()
    setBusy(`check:${loc.id}`)
    try {
      const res = await fetch(`${api}/locations/${loc.id}/check`, {
        method: 'POST',
        credentials: 'include',
      })
      if (!res.ok) return failed(res, 'Check failed.')
      const body = (await res.json()) as { location: Location; check: CheckResult }
      setLocations((prev) => prev.map((l) => (l.id === loc.id ? body.location : l)))
      if (body.check.ok) setSuccess(describeCheck(loc.name, body.check))
      else setError(describeCheck(loc.name, body.check))
    } finally {
      setBusy('')
    }
  }

  async function handleDelete(loc: Location) {
    clearMessages()
    setBusy(`delete:${loc.id}`)
    try {
      const res = await fetch(`${api}/locations/${loc.id}`, {
        method: 'DELETE',
        credentials: 'include',
      })
      if (!res.ok) return failed(res, 'Failed to delete the location.')
      setConfirmDelete(null)
      setSuccess(`Deleted ${loc.name}. Its mirrors stopped; what they copied stays in the bucket.`)
      await refresh()
    } finally {
      setBusy('')
    }
  }

  async function handleAddDefault(e: FormEvent) {
    e.preventDefault()
    clearMessages()
    setBusy('default')
    try {
      const res = await fetch(`${api}/placements`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ locationId: defaultLocation, sets: defaultSets }),
      })
      if (!res.ok) return failed(res, 'Failed to add the default mirror.')
      const body = (await res.json()) as { placement: DefaultPlacement }
      setDefaults((prev) => [...prev, body.placement])
      setDefaultLocation('')
      setSuccess('Default mirror added. Every collection in the organization now copies to it.')
    } finally {
      setBusy('')
    }
  }

  async function handleRemoveDefault(p: DefaultPlacement) {
    clearMessages()
    setBusy(`undefault:${p.id}`)
    try {
      const res = await fetch(`${api}/placements/${p.id}`, {
        method: 'DELETE',
        credentials: 'include',
      })
      if (!res.ok) return failed(res, 'Failed to remove the default mirror.')
      setDefaults((prev) => prev.filter((d) => d.id !== p.id))
      setSuccess(
        "Default mirror removed. The organization's collections stopped mirroring there; what they copied stays in the bucket.",
      )
    } finally {
      setBusy('')
    }
  }

  const byId = new Map(locations.map((l) => [l.id, l]))
  const undefaulted = locations.filter((l) => !defaults.some((d) => d.locationId === l.id))

  return (
    <SettingsLayout
      crumb={
        <nav>
          <Link to={`/${owner}`} className="text-link hover:underline">
            {owner}
          </Link>{' '}
          <span className="text-ink-muted">/</span> <span className="text-ink-muted">settings</span>
        </nav>
      }
      title="Storage"
      description="Buckets your organization controls, and the mirrors that copy collections into them."
      groups={orgSettingsRail(owner!)}
    >
      {!loaderData.allowed ? (
        <p className="text-ink-muted text-sm">
          Only organization owners and admins manage storage.
        </p>
      ) : (
        <>
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

          {/* Locations */}
          <section id="locations" className="mb-10">
            <SectionHeading>Storage locations</SectionHeading>
            <p className="text-ink-muted mb-3 text-sm">
              An S3-compatible bucket (AWS S3, Cloudflare R2, MinIO and others). Mirrors write each
              collection there as a complete, signed repository. Deleting a location or a mirror
              never deletes what was copied.
            </p>

            {locations.length === 0 ? (
              <p className="text-ink-muted mb-6 text-sm">No storage locations yet.</p>
            ) : (
              <div className="mb-6 space-y-3">
                {locations.map((loc) => (
                  <div
                    key={loc.id}
                    className="border-rule rounded-surface border p-3"
                    data-location={loc.id}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">
                          {loc.name}{' '}
                          <span className={`text-xs font-normal ${STATUS_STYLES[loc.status]}`}>
                            {loc.status}
                          </span>
                        </p>
                        <p className="text-ink-muted font-mono text-xs break-all">
                          {loc.endpoint} · {[loc.bucket, loc.prefix].filter(Boolean).join('/')}
                        </p>
                        <div className="text-ink-muted mt-1 flex flex-wrap items-center gap-2 text-xs">
                          <Badge>{PERMISSION_LABELS[loc.permissions]}</Badge>
                          {loc.region && <Badge>{loc.region}</Badge>}
                          {loc.verifiedAt && (
                            <span>checked {new Date(loc.verifiedAt).toLocaleString()}</span>
                          )}
                        </div>
                        {loc.lastError && (
                          <p className="mt-1 text-xs break-words text-red-700">{loc.lastError}</p>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-3 text-xs">
                        <Button
                          variant="link"
                          size="sm"
                          disabled={busy !== ''}
                          onClick={() => handleCheck(loc)}
                        >
                          {busy === `check:${loc.id}` ? 'Checking…' : 'Re-check'}
                        </Button>
                        <Button
                          variant="dangerLink"
                          size="sm"
                          disabled={busy !== ''}
                          onClick={() => setConfirmDelete(loc.id)}
                        >
                          Delete
                        </Button>
                      </div>
                    </div>
                    {confirmDelete === loc.id && (
                      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-red-200 pt-3 text-sm">
                        <span className="text-red-700">
                          Delete {loc.name}? Every mirror to it stops. The bucket is left as it is.
                        </span>
                        <Button
                          variant="danger"
                          size="sm"
                          disabled={busy !== ''}
                          onClick={() => handleDelete(loc)}
                        >
                          {busy === `delete:${loc.id}` ? 'Deleting…' : 'Delete location'}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(null)}>
                          Cancel
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            <form
              onSubmit={handleAdd}
              className="border-rule rounded-surface space-y-3 border p-4"
              autoComplete="off"
            >
              <h3 className="text-sm font-semibold">Add a storage location</h3>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <Field label="Name" htmlFor="locName">
                  <Input
                    id="locName"
                    value={form.name}
                    onChange={field('name')}
                    placeholder="Archive bucket"
                    required
                  />
                </Field>
                <Field label="Endpoint" htmlFor="locEndpoint">
                  <Input
                    id="locEndpoint"
                    type="url"
                    value={form.endpoint}
                    onChange={field('endpoint')}
                    placeholder="https://s3.us-east-1.amazonaws.com"
                    required
                  />
                </Field>
                <Field label="Bucket" htmlFor="locBucket">
                  <Input
                    id="locBucket"
                    value={form.bucket}
                    onChange={field('bucket')}
                    className="font-mono"
                    required
                  />
                </Field>
                <Field label="Region" htmlFor="locRegion" hint="Optional.">
                  <Input
                    id="locRegion"
                    value={form.region}
                    onChange={field('region')}
                    placeholder="auto"
                    className="font-mono"
                  />
                </Field>
                <Field
                  label="Prefix"
                  htmlFor="locPrefix"
                  hint="Optional. Underlay writes only under this path."
                >
                  <Input
                    id="locPrefix"
                    value={form.prefix}
                    onChange={field('prefix')}
                    placeholder="underlay"
                    className="font-mono"
                  />
                </Field>
                <Field
                  label="Access"
                  htmlFor="locPermissions"
                  hint="Read and write also lets a collection be restored from this location."
                >
                  <Select
                    id="locPermissions"
                    value={form.permissions}
                    onChange={field('permissions')}
                  >
                    {Object.entries(PERMISSION_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Access key ID" htmlFor="locKeyId">
                  <Input
                    id="locKeyId"
                    value={form.accessKeyId}
                    onChange={field('accessKeyId')}
                    className="font-mono"
                    required
                  />
                </Field>
                <Field
                  label="Secret access key"
                  htmlFor="locSecret"
                  hint="Stored encrypted and never shown again."
                >
                  <Input
                    id="locSecret"
                    type="password"
                    value={form.secretAccessKey}
                    onChange={field('secretAccessKey')}
                    autoComplete="new-password"
                    className="font-mono"
                    required
                  />
                </Field>
              </div>
              <p className="text-ink-muted text-xs">
                Adding a location checks it: Underlay writes a small object under the prefix, reads
                it back when allowed, and tests whether the bucket can be read without credentials.
              </p>
              <Button type="submit" disabled={busy !== ''}>
                {busy === 'add' ? 'Adding and checking…' : 'Add location'}
              </Button>
            </form>
          </section>

          {/* Org default mirrors */}
          <section id="defaults" className="border-rule border-t pt-6">
            <SectionHeading>Default mirrors</SectionHeading>
            <p className="text-ink-muted mb-3 text-sm">
              Every collection in the organization, existing and new, mirrors to these locations. To
              mirror a single collection, use its settings instead.
            </p>

            {defaults.length === 0 ? (
              <p className="text-ink-muted mb-4 text-sm">No default mirrors.</p>
            ) : (
              <div className="mb-4 space-y-2">
                {defaults.map((p) => (
                  <div
                    key={p.id}
                    className="border-rule rounded-surface flex items-center justify-between gap-3 border px-3 py-2"
                  >
                    <div className="min-w-0 text-sm">
                      <span className="font-medium">
                        {byId.get(p.locationId)?.name ?? p.locationId}
                      </span>
                      <span className="text-ink-muted ml-2 text-xs">{SETS_LABELS[p.sets]}</span>
                    </div>
                    <Button
                      variant="dangerLink"
                      size="sm"
                      disabled={busy !== ''}
                      onClick={() => handleRemoveDefault(p)}
                    >
                      {busy === `undefault:${p.id}` ? 'Removing…' : 'Remove'}
                    </Button>
                  </div>
                ))}
              </div>
            )}

            {locations.length === 0 ? (
              <p className="text-ink-muted text-sm">Add a storage location first.</p>
            ) : undefaulted.length > 0 ? (
              <form
                onSubmit={handleAddDefault}
                className="border-rule rounded-surface flex flex-wrap items-end gap-3 border p-4"
              >
                <div className="min-w-0 flex-1">
                  <label htmlFor="defaultLocation" className="mb-1 block text-xs font-medium">
                    Mirror every collection to
                  </label>
                  <Select
                    id="defaultLocation"
                    value={defaultLocation}
                    onChange={(e) => setDefaultLocation(e.target.value)}
                    required
                  >
                    <option value="">— Select a location —</option>
                    {undefaulted.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                        {l.status !== 'active' ? ` (${l.status})` : ''}
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <label htmlFor="defaultSets" className="mb-1 block text-xs font-medium">
                    Copy
                  </label>
                  <Select
                    id="defaultSets"
                    value={defaultSets}
                    onChange={(e) => setDefaultSets(e.target.value as DefaultPlacement['sets'])}
                  >
                    {Object.entries(SETS_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </Select>
                </div>
                <Button type="submit" disabled={!defaultLocation || busy !== ''}>
                  {busy === 'default' ? 'Adding…' : 'Add default mirror'}
                </Button>
              </form>
            ) : null}
          </section>

          <RestoreSection
            owner={owner!}
            locations={locations}
            initialRestores={loaderData.restores}
          />
        </>
      )}
    </SettingsLayout>
  )
}
