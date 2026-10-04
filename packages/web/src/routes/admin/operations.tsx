import { type FormEvent, useState } from 'react'
import { useLoaderData } from 'react-router'

import { compact, day } from '~/components/admin-stats'
import AdminLayout from '~/components/AdminLayout'
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Input,
  SectionHeading,
  Table,
  Td,
  Th,
} from '~/components/ui'

interface Operations {
  sessions: { kind: string; status: string; n: number }[]
  failedPushes: {
    id: string
    kind: string
    owner: string
    slug: string
    error: string | null
    createdAt: number
  }[]
  locations: {
    id: string
    name: string
    bucket: string | null
    owner: string | null
    status: string
    lastError: string | null
    checkedAt: number | null
  }[]
  uploads: Record<string, number>
  jobs: { type: string; status: string; n: number }[]
}

const STATUSES = ['open', 'committing', 'committed', 'failed', 'expired']

export default function AdminOperations() {
  const data = useLoaderData() as Operations | null
  if (!data) {
    return (
      <AdminLayout title="Operations">
        <p className="text-ink-muted text-sm">Couldn't load the figures.</p>
      </AdminLayout>
    )
  }
  const kinds = [...new Set(data.sessions.map((s) => s.kind))].sort()
  const count = (kind: string, status: string) =>
    data.sessions.find((s) => s.kind === kind && s.status === status)?.n ?? 0

  return (
    <AdminLayout
      title="Operations"
      description="Pushes, storage locations and background work, and the tools that rebuild counters."
    >
      <SectionHeading>Pushes</SectionHeading>
      <p className="text-ink-muted mb-2 text-xs">
        Open sessions, and every session of the last 7 days.
      </p>
      {kinds.length === 0 ? (
        <p className="text-ink-muted mb-8 text-sm">No pushes in the last 7 days.</p>
      ) : (
        <Table className="mb-8">
          <thead>
            <tr>
              <Th>Kind</Th>
              {STATUSES.map((s) => (
                <Th key={s} className="text-right">
                  {s}
                </Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {kinds.map((k) => (
              <tr key={k}>
                <Td>{k}</Td>
                {STATUSES.map((s) => (
                  <Td key={s} className="text-right tabular-nums">
                    {count(k, s) || '—'}
                  </Td>
                ))}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {data.failedPushes.length > 0 && (
        <ul className="mb-8 space-y-1 text-sm">
          {data.failedPushes.map((f) => (
            <li key={f.id}>
              <code>
                {f.owner}/{f.slug}
              </code>{' '}
              <Badge>{f.kind}</Badge>{' '}
              <span className="text-ink-muted text-xs">{day(f.createdAt)}</span>{' '}
              <span className="text-red-800">{f.error ?? 'failed'}</span>
            </li>
          ))}
        </ul>
      )}

      <SectionHeading>Storage locations</SectionHeading>
      {data.locations.length === 0 ? (
        <p className="text-ink-muted mb-8 text-sm">No customer locations.</p>
      ) : (
        <Table className="mb-8">
          <thead>
            <tr>
              <Th>Location</Th>
              <Th>Organization</Th>
              <Th>Status</Th>
              <Th>Checked</Th>
            </tr>
          </thead>
          <tbody>
            {data.locations.map((l) => (
              <tr key={l.id}>
                <Td>
                  {l.name}
                  {l.bucket && (
                    <span className="text-ink-muted block font-mono text-xs">{l.bucket}</span>
                  )}
                </Td>
                <Td>{l.owner ?? '—'}</Td>
                <Td>
                  <Badge>{l.status}</Badge>
                  {l.lastError && (
                    <span className="text-ink-muted block text-xs">{l.lastError}</span>
                  )}
                </Td>
                <Td>{day(l.checkedAt)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <SectionHeading>Background work</SectionHeading>
      <p className="mb-2 text-sm">
        Direct file uploads, last 7 days:{' '}
        {Object.keys(data.uploads).length === 0
          ? 'none'
          : Object.entries(data.uploads)
              .map(([s, n]) => `${compact(n)} ${s}`)
              .join(', ')}
        .
      </p>
      {data.jobs.length > 0 ? (
        <ul className="mb-8 space-y-0.5 text-sm">
          {data.jobs.map((j) => (
            <li key={`${j.type}/${j.status}`}>
              <code>{j.type}</code> <Badge>{j.status}</Badge> {compact(j.n)}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-ink-muted mb-8 text-xs">
          No jobs waiting in the jobs table. On Cloudflare jobs run on Queues, which this page
          doesn&rsquo;t see; check the queues in the dashboard.
        </p>
      )}

      <SectionHeading>Tools</SectionHeading>
      <CollectionTool
        title="Reconcile a collection"
        hint="Rebuilds its billing counters, schema usage and public files tree from its versions, and reports what it corrected."
        endpoint="/api/admin/reconcile"
      />
      <CollectionTool
        title="Check a repository"
        hint="Reads every object of the collection's repository and checks its hash, every tree, and the signed log."
        endpoint="/api/admin/fsck"
        fileBytes
      />
      <RebuildUsage />
    </AdminLayout>
  )
}

/** Start a job on one collection (owner/slug), then read back its last result. */
function CollectionTool({
  title,
  hint,
  endpoint,
  fileBytes,
}: {
  title: string
  hint: string
  endpoint: string
  /** Offer the fsck option of hashing file bytes too. */
  fileBytes?: boolean
}) {
  const [collection, setCollection] = useState('')
  const [withBytes, setWithBytes] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [result, setResult] = useState<unknown>(null)

  async function start(e: FormEvent) {
    e.preventDefault()
    setResult(null)
    const res = await fetch(endpoint, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        collection: collection.trim(),
        ...(fileBytes ? { fileBytes: withBytes } : {}),
      }),
    })
    const body = await res.json().catch(() => ({}))
    setMessage(
      res.ok
        ? { ok: true, text: 'Queued. Show the result once it has run.' }
        : { ok: false, text: body.error ?? 'That failed.' },
    )
  }

  async function show() {
    const res = await fetch(`${endpoint}?collection=${encodeURIComponent(collection.trim())}`, {
      credentials: 'include',
    })
    const body = await res.json().catch(() => ({}))
    if (res.ok) {
      setMessage(null)
      setResult(body)
    } else setMessage({ ok: false, text: body.error ?? 'Nothing to show.' })
  }

  return (
    <form onSubmit={start} className="border-rule rounded-surface mb-4 border p-3">
      <p className="text-sm font-medium">{title}</p>
      <p className="text-ink-muted mb-2 text-xs">{hint}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          required
          placeholder="owner/slug"
          value={collection}
          onChange={(e) => setCollection(e.target.value)}
          className="max-w-64 font-mono"
        />
        {fileBytes && (
          <label className="text-ink-muted flex items-center gap-1.5 text-xs">
            <Checkbox checked={withBytes} onChange={(e) => setWithBytes(e.target.checked)} />
            Hash file bytes too
          </label>
        )}
        <Button type="submit" size="sm">
          Start
        </Button>
        <Button type="button" variant="link" size="sm" onClick={show} disabled={!collection.trim()}>
          Show last result
        </Button>
      </div>
      {message && (
        <Alert variant={message.ok ? 'success' : 'error'} className="mt-2 text-xs">
          {message.text}
        </Alert>
      )}
      {result != null && (
        <pre className="bg-parchment-dark rounded-surface mt-2 max-h-64 overflow-auto p-2 text-xs">
          {JSON.stringify(result, null, 2)}
        </pre>
      )}
    </form>
  )
}

/** Recompute one day's usage rollups from the usage log. */
function RebuildUsage() {
  const [dayValue, setDayValue] = useState('')
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  async function submit(e: FormEvent) {
    e.preventDefault()
    const res = await fetch('/api/admin/usage/rebuild', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ day: dayValue }),
    })
    const body = await res.json().catch(() => ({}))
    setMessage(
      res.ok
        ? { ok: true, text: `Queued: ${dayValue} will be recomputed from the usage log.` }
        : { ok: false, text: body.error ?? 'That failed.' },
    )
  }
  return (
    <form onSubmit={submit} className="border-rule rounded-surface border p-3">
      <p className="text-sm font-medium">Rebuild a day&rsquo;s usage</p>
      <p className="text-ink-muted mb-2 text-xs">
        Recomputes the day&rsquo;s rollups from the usage log, dropping events a retried batch
        counted twice.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="date"
          required
          value={dayValue}
          onChange={(e) => setDayValue(e.target.value)}
          className="max-w-48"
        />
        <Button type="submit" size="sm">
          Rebuild
        </Button>
      </div>
      {message && (
        <Alert variant={message.ok ? 'success' : 'error'} className="mt-2 text-xs">
          {message.text}
        </Alert>
      )}
    </form>
  )
}
