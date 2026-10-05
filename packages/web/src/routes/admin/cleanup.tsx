import { useEffect, useState } from 'react'
import { useLoaderData, useRevalidator } from 'react-router'

import { compact, StatGrid, StatTile } from '~/components/admin-stats'
import AdminLayout from '~/components/AdminLayout'
import { Alert, Badge, Button, Checkbox, SectionHeading, Table, Td, Th } from '~/components/ui'
import { formatBytes, plural } from '~/lib/format'

type Step = 'internal' | 'mark' | 'sweep'

interface Count {
  objects: number
  bytes: number
}

interface Run {
  id: string
  step: Step
  status: 'queued' | 'running' | 'waiting' | 'done' | 'failed'
  trigger: 'manual' | 'schedule'
  dryRun: boolean
  error: string | null
  stats: {
    deleted: Record<string, Count>
    scanned: number
    unknown: number
    marked: number
    versions: number
    collections: number
    rows: number
    windows: number
    problems: string[]
    samples?: Record<string, string[]>
  } | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
}

interface Cleanup {
  runs: Run[]
  auto: boolean
  paused: boolean
  fence: { epoch: number; windowOpen: boolean }
  waiting: { sessions: number; sessionsInGrace: number; uploads: number }
  deletedCollections: {
    inGrace: { collections: number; bytes: number }
    ready: { collections: number; bytes: number }
  }
  lastMark: {
    id: string
    startedAt: number | null
    finishedAt: number | null
    marked: number
  } | null
  config: { sessionGraceHours: number; uploadGraceHours: number; tombstoneGraceDays: number }
}

const STEP_LABELS: Record<Step, string> = {
  internal: 'Sessions and uploads',
  mark: 'Mark',
  sweep: 'Sweep',
}

/** "Oct 4, 14:05 UTC". */
function when(ms: number | null): string {
  if (ms == null) return '—'
  return `${new Date(ms).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  })} UTC`
}

function duration(run: Run): string {
  // The cron's batches add to one row a day: its span isn't a duration.
  if (run.step === 'internal' && run.trigger === 'schedule') return 'batches'
  if (!run.startedAt) return '—'
  const s = Math.round(((run.finishedAt ?? Date.now()) - run.startedAt) / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  return `${(s / 3600).toFixed(1)}h`
}

const total = (deleted: Record<string, Count>) =>
  Object.values(deleted).reduce(
    (t, c) => ({ objects: t.objects + c.objects, bytes: t.bytes + c.bytes }),
    {
      objects: 0,
      bytes: 0,
    },
  )

export default function AdminCleanup() {
  const data = useLoaderData() as Cleanup | null
  if (!data) {
    return (
      <AdminLayout title="Cleanup">
        <p className="text-ink-muted text-sm">Couldn&rsquo;t load cleanup.</p>
      </AdminLayout>
    )
  }
  const { waiting, deletedCollections: dc } = data
  return (
    <>
      <Follow active={data.runs.some((r) => ACTIVE.includes(r.status))} />
      <AdminLayout
        title="Cleanup"
        description="Deletes what the platform bucket no longer needs: finished push sessions, abandoned uploads, and the objects of deleted collections."
      >
        {data.paused && (
          <Alert variant="info" className="mb-6">
            Marks and sweeps are paused: none starts, and a sweep in progress deletes nothing until
            this is switched off. Sessions and uploads are still cleaned.
          </Alert>
        )}
        {data.fence.windowOpen && (
          <Alert variant="info" className="mb-6">
            A sweep has a deletion window open: pushes and uploads wait a few seconds for it.
          </Alert>
        )}

        <SectionHeading>Waiting to be cleaned</SectionHeading>
        <StatGrid>
          <StatTile
            label="Finished push sessions"
            value={compact(waiting.sessions)}
            detail={`ready; ${compact(waiting.sessionsInGrace)} more within ${data.config.sessionGraceHours}h`}
          />
          <StatTile
            label="Abandoned uploads"
            value={compact(waiting.uploads)}
            detail={`pending over ${data.config.uploadGraceHours}h`}
          />
          <StatTile
            label="Deleted collections, ready"
            value={`up to ${formatBytes(dc.ready.bytes)}`}
            detail={`${compact(dc.ready.collections)} past their ${data.config.tombstoneGraceDays}-day grace, not yet swept`}
          />
          <StatTile
            label="Deleted collections, in grace"
            value={`up to ${formatBytes(dc.inGrace.bytes)}`}
            detail={`${compact(dc.inGrace.collections)} kept for now, so a mistaken delete can be recovered`}
          />
        </StatGrid>
        <p className="text-ink-muted mb-8 text-xs">
          Deleted collections&rsquo; sizes are upper bounds: some of their objects may be shared
          with collections that remain, and those stay.
        </p>

        <SectionHeading>Run</SectionHeading>
        <Controls data={data} />

        <SectionHeading>Runs</SectionHeading>
        <Runs runs={data.runs} />
      </AdminLayout>
    </>
  )
}

const ACTIVE: Run['status'][] = ['queued', 'running', 'waiting']

/** While a run is in progress, reload the page's data every few seconds. */
function Follow({ active }: { active: boolean }) {
  const revalidator = useRevalidator()
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => {
      if (revalidator.state === 'idle') revalidator.revalidate()
    }, 5000)
    return () => clearInterval(t)
  }, [active, revalidator])
  return null
}

function Controls({ data }: { data: Cleanup }) {
  const revalidator = useRevalidator()
  const [dryRun, setDryRun] = useState(true)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const busy = (step: Step) =>
    data.runs.some(
      (r) =>
        ['queued', 'running', 'waiting'].includes(r.status) &&
        (step === 'internal' ? r.step === 'internal' : r.step !== 'internal'),
    )

  async function start(step: Step, opts: { dryRun?: boolean; thenSweep?: boolean } = {}) {
    const res = await fetch('/api/admin/cleanup/runs', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step, ...opts }),
    })
    const body = await res.json().catch(() => ({}))
    setMessage(
      res.ok
        ? { ok: true, text: 'Started. The runs below update as it goes; reload to follow it.' }
        : { ok: false, text: body.error ?? 'That failed.' },
    )
    revalidator.revalidate()
  }

  async function setting(path: 'auto' | 'pause', body: Record<string, boolean>) {
    const res = await fetch(`/api/admin/cleanup/${path}`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) setMessage({ ok: false, text: 'Couldn’t change that setting.' })
    revalidator.revalidate()
  }

  const box = 'border-rule rounded-surface mb-3 border p-3'
  return (
    <div className="mb-8">
      <div className={box}>
        <p className="text-sm font-medium">Sessions and uploads</p>
        <p className="text-ink-muted mb-2 text-xs">
          Deletes the objects of push sessions finished more than {data.config.sessionGraceHours}h
          ago, staging copies of uploads never completed, and leftover scratch. It runs on its own
          every 10 minutes; this runs it to the end now.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy('internal')} onClick={() => start('internal')}>
            Run now
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy('internal')}
            onClick={() => start('internal', { dryRun: true })}
          >
            Dry run
          </Button>
        </div>
      </div>

      <div className={box}>
        <p className="text-sm font-medium">Deleted collections: mark, then sweep</p>
        <p className="text-ink-muted mb-2 text-xs">
          The mark records every object a collection still uses (deleted collections count for{' '}
          {data.config.tombstoneGraceDays} days), reading tree nodes only. The sweep lists the
          bucket and deletes what the mark doesn&rsquo;t hold, a few hundred objects at a time,
          pausing pushes for a few seconds each time. It waits while a push is committing.
        </p>
        <p className="text-ink-muted mb-2 text-xs">
          Last mark:{' '}
          {data.lastMark
            ? `${when(data.lastMark.finishedAt)}, ${plural(data.lastMark.marked, 'object')} in use`
            : 'none yet'}
          .
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={busy('mark')}
            onClick={() => start('mark', { thenSweep: true, dryRun })}
          >
            Mark and sweep
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy('mark')}
            onClick={() => start('mark')}
          >
            Mark only
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy('sweep') || !data.lastMark}
            onClick={() => start('sweep', { dryRun })}
          >
            Sweep with the last mark
          </Button>
          <label className="text-ink-muted flex items-center gap-1.5 text-xs">
            <Checkbox checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
            Dry run: count what the sweep would delete, delete nothing
          </label>
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={data.auto}
          onChange={(e) => setting('auto', { enabled: e.target.checked })}
        />
        Mark and sweep automatically once a week
      </label>
      <p className="text-ink-muted mt-1 text-xs">
        Off until a dry run looks right. Sessions and uploads are cleaned regardless.
      </p>
      <label className="mt-3 flex items-center gap-2 text-sm">
        <Checkbox
          checked={data.paused}
          onChange={(e) => setting('pause', { paused: e.target.checked })}
        />
        Pause marks and sweeps
      </label>
      <p className="text-ink-muted mt-1 text-xs">
        While anything writes to the bucket outside the app, such as the v1 migration tools.
      </p>
      {message && (
        <Alert variant={message.ok ? 'success' : 'error'} className="mt-3 text-xs">
          {message.text}
        </Alert>
      )}
    </div>
  )
}

function Runs({ runs }: { runs: Run[] }) {
  if (runs.length === 0) return <p className="text-ink-muted text-sm">No runs yet.</p>
  return (
    <Table dense>
      <thead>
        <tr>
          <Th>Step</Th>
          <Th>Started</Th>
          <Th>Took</Th>
          <Th>Status</Th>
          <Th className="text-right">Deleted</Th>
          <Th>Details</Th>
        </tr>
      </thead>
      <tbody>
        {runs.map((r) => {
          const s = r.stats
          const t = s ? total(s.deleted) : { objects: 0, bytes: 0 }
          return (
            <tr key={r.id}>
              <Td>
                {STEP_LABELS[r.step]}
                <span className="text-ink-muted block">
                  {r.trigger === 'schedule' ? 'automatic' : 'manual'}
                  {r.dryRun ? ', dry run' : ''}
                </span>
              </Td>
              <Td className="whitespace-nowrap">{when(r.startedAt ?? r.createdAt)}</Td>
              <Td>{duration(r)}</Td>
              <Td>
                <Badge className={r.status === 'failed' ? 'border-red-300 text-red-800' : ''}>
                  {r.status}
                </Badge>
                {r.error && <span className="text-ink-muted block max-w-64">{r.error}</span>}
              </Td>
              <Td className="text-right whitespace-nowrap tabular-nums">
                {r.step === 'mark' ? (
                  '—'
                ) : (
                  <>
                    {r.dryRun ? `${compact(t.objects)} would go` : plural(t.objects, 'object')}
                    <span className="text-ink-muted block">{formatBytes(t.bytes)}</span>
                  </>
                )}
              </Td>
              <Td>{s && <Details run={r} />}</Td>
            </tr>
          )
        })}
      </tbody>
    </Table>
  )
}

function Details({ run }: { run: Run }) {
  const s = run.stats!
  const parts: string[] = []
  if (run.step === 'mark') {
    parts.push(`${plural(s.marked, 'object')} in use`)
    parts.push(`${plural(s.collections, 'collection')}, ${plural(s.versions, 'version')}`)
  } else {
    parts.push(`${compact(s.scanned)} ${run.step === 'sweep' ? 'listed' : 'looked at'}`)
    for (const [kind, c] of Object.entries(s.deleted))
      parts.push(`${kind}: ${compact(c.objects)} (${formatBytes(c.bytes)})`)
    if (s.rows) parts.push(plural(s.rows, 'row'))
    if (s.windows) parts.push(plural(s.windows, 'window'))
    if (s.unknown) parts.push(`${plural(s.unknown, 'unknown key')} kept`)
  }
  return (
    <div className="text-ink-muted">
      {parts.join(' · ')}
      {s.problems.length > 0 && (
        <ul className="mt-1 text-red-800">
          {s.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {s.samples && Object.keys(s.samples).length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer">
            {run.dryRun ? 'Keys it would delete' : 'Keys it deleted'} (first of each kind)
          </summary>
          {Object.entries(s.samples).map(([kind, list]) => (
            <div key={kind} className="mt-1">
              <span className="text-ink font-medium">{kind}</span>
              <ul className="font-mono text-[11px] break-all">
                {list.map((k) => (
                  <li key={k}>{k}</li>
                ))}
              </ul>
            </div>
          ))}
        </details>
      )}
    </div>
  )
}
