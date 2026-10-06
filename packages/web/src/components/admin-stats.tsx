/**
 * Pieces of the steward metrics pages (routes/admin/*): stat tiles, the period
 * picker, a one-series column chart, and sortable tables.
 */
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'

import { Th } from '~/components/ui'
import { formatBytes, formatCount, formatDate, plural } from '~/lib/format'

export type Metric = 'api_calls' | 'response_bytes' | 'file_downloads' | 'file_bytes'
export type Usage = Record<Metric, number>

export const METRIC_LABELS: Record<Metric, string> = {
  api_calls: 'API calls',
  response_bytes: 'Response bytes',
  file_downloads: 'File downloads',
  file_bytes: 'File bytes',
}

const isBytes = (m: Metric) => m === 'response_bytes' || m === 'file_bytes'

/** A whole number with thousands separators. */
export const num = (n: number) => n.toLocaleString('en-US')

/** The one compact count style (lib/format). */
export const compact = formatCount
export { plural }

export const metricValue = (m: Metric, n: number) => (isBytes(m) ? formatBytes(n) : compact(n))

/** A date as "Oct 4, 2026", in UTC so server and browser agree. */
export function day(ms: number | string | null): string {
  if (ms == null) return '—'
  return formatDate(ms)
}

export function StatTile({
  label,
  value,
  detail,
  to,
}: {
  label: string
  value: string
  /** A second line: what the value covers, or a related figure. */
  detail?: string
  to?: string
}) {
  const body = (
    <>
      <p className="text-ink-muted text-xs">{label}</p>
      <p className="text-ink mt-1 text-2xl font-semibold tracking-tight">{value}</p>
      {detail && <p className="text-ink-muted mt-0.5 text-xs">{detail}</p>}
    </>
  )
  const className = 'border-rule rounded-surface block border px-3 py-2.5'
  return to ? (
    <Link to={to} className={`${className} hover:bg-parchment-dark transition-colors`}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  )
}

export function StatGrid({ children }: { children: React.ReactNode }) {
  return <div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">{children}</div>
}

/** Last 7 / 30 / 90 days, as links that keep the page's other parameters. */
export function PeriodPicker({ since }: { since?: string }) {
  const [params] = useSearchParams()
  const current = params.get('days') ?? '30'
  return (
    <div className="mb-6 flex flex-wrap items-center gap-2 text-sm">
      {['7', '30', '90'].map((d) => {
        const next = new URLSearchParams(params)
        next.set('days', d)
        return (
          <Link
            key={d}
            to={`?${next}`}
            className={`rounded-control border px-2.5 py-1 transition-colors ${
              current === d
                ? 'border-ink bg-ink text-parchment'
                : 'border-rule text-ink-light hover:border-ink-muted'
            }`}
          >
            Last {d} days
          </Link>
        )
      })}
      {since && <span className="text-ink-muted text-xs">since {day(since)} (UTC)</span>}
    </div>
  )
}

/** Buttons choosing which metric a chart shows. */
export function MetricToggle({
  value,
  onChange,
}: {
  value: Metric
  onChange: (m: Metric) => void
}) {
  return (
    <div className="mb-2 flex flex-wrap gap-1" role="radiogroup" aria-label="Metric">
      {(Object.keys(METRIC_LABELS) as Metric[]).map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={value === m}
          onClick={() => onChange(m)}
          className={`rounded-control cursor-pointer px-2 py-0.5 text-xs transition-colors ${
            value === m ? 'bg-parchment-dark text-ink font-medium' : 'text-ink-muted hover:text-ink'
          }`}
        >
          {METRIC_LABELS[m]}
        </button>
      ))}
    </div>
  )
}

const CHART_H = 140
const PAD_TOP = 8
const AXIS_W = 56

/**
 * One series as columns: thin bars from a hairline baseline, rounded at the
 * data end, a 2px gap between them. Each column's full-height slot is its hover
 * and focus target, with the value in a tooltip.
 */
export function ColumnChart({
  points,
  format,
  label,
}: {
  points: { label: string; value: number }[]
  format: (n: number) => string
  /** What the chart shows, for screen readers. */
  label: string
}) {
  const [hover, setHover] = useState<number | null>(null)
  const width = 640
  const plotW = width - AXIS_W
  const max = Math.max(1, ...points.map((p) => p.value))
  const slot = plotW / Math.max(1, points.length)
  const barW = Math.max(1, Math.min(24, slot - 2))
  const y = (v: number) => PAD_TOP + (CHART_H - PAD_TOP) * (1 - v / max)
  const hovered = hover == null ? null : points[hover]

  return (
    <figure className="relative mb-8">
      <svg
        viewBox={`0 0 ${width} ${CHART_H + 20}`}
        className="w-full"
        role="img"
        aria-label={label}
        onPointerLeave={() => setHover(null)}
      >
        <text
          x={AXIS_W - 6}
          y={PAD_TOP + 4}
          textAnchor="end"
          className="fill-ink-muted text-[10px]"
        >
          {format(max)}
        </text>
        <text x={AXIS_W - 6} y={CHART_H} textAnchor="end" className="fill-ink-muted text-[10px]">
          0
        </text>
        <line x1={AXIS_W} x2={width} y1={PAD_TOP} y2={PAD_TOP} className="stroke-rule/50" />
        <line x1={AXIS_W} x2={width} y1={CHART_H} y2={CHART_H} className="stroke-rule" />
        {points.map((p, i) => {
          const x = AXIS_W + i * slot + (slot - barW) / 2
          const top = y(p.value)
          const h = CHART_H - top
          const r = Math.min(4, barW / 2, h)
          return (
            <g key={p.label}>
              {p.value > 0 && (
                <path
                  d={`M${x},${CHART_H} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${CHART_H} Z`}
                  className={hover === i ? 'fill-accent-light' : 'fill-accent'}
                />
              )}
              <rect
                x={AXIS_W + i * slot}
                y={0}
                width={slot}
                height={CHART_H}
                fill="transparent"
                tabIndex={0}
                aria-label={`${p.label}: ${format(p.value)}`}
                onPointerEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                className="focus:outline-none"
              />
            </g>
          )
        })}
        {points.length > 0 && (
          <>
            <text x={AXIS_W} y={CHART_H + 14} className="fill-ink-muted text-[10px]">
              {points[0]!.label}
            </text>
            {points.length > 1 && (
              <text
                x={width}
                y={CHART_H + 14}
                textAnchor="end"
                className="fill-ink-muted text-[10px]"
              >
                {points.at(-1)!.label}
              </text>
            )}
          </>
        )}
      </svg>
      {hovered && hover != null && (
        <div
          className="bg-parchment border-rule rounded-surface pointer-events-none absolute top-0 border px-2 py-1 text-xs shadow-sm"
          style={{
            left: `${((AXIS_W + (hover + 0.5) * slot) / width) * 100}%`,
            transform: 'translateX(-50%)',
          }}
        >
          <span className="text-ink font-semibold">{format(hovered.value)}</span>{' '}
          <span className="text-ink-muted">{hovered.label}</span>
        </div>
      )}
    </figure>
  )
}

/** Daily usage as a column chart, with a metric toggle. */
export function UsageChart({ daily }: { daily: ({ day: string } & Usage)[] }) {
  const [metric, setMetric] = useState<Metric>('api_calls')
  return (
    <>
      <MetricToggle value={metric} onChange={setMetric} />
      <ColumnChart
        label={`${METRIC_LABELS[metric]} per day`}
        format={(v) => metricValue(metric, v)}
        points={daily.map((d) => ({ label: day(d.day), value: d[metric] }))}
      />
    </>
  )
}

export interface Column<T> {
  key: string
  label: string
  /** Sort value; the column isn't sortable without one. */
  sort?: (row: T) => number | string
  render: (row: T) => React.ReactNode
  numeric?: boolean
}

/** A table whose headers sort it (numbers largest first). */
export function SortableTable<T>({
  rows,
  columns,
  rowKey,
  initialSort,
  footer,
}: {
  rows: T[]
  columns: Column<T>[]
  rowKey: (row: T) => string
  initialSort?: string
  footer?: React.ReactNode
}) {
  const [sortKey, setSortKey] = useState(initialSort ?? null)
  const [asc, setAsc] = useState(false)
  const col = columns.find((c) => c.key === sortKey)
  const sorted = col?.sort
    ? [...rows].sort((a, b) => {
        const va = col.sort!(a)
        const vb = col.sort!(b)
        const cmp =
          typeof va === 'number' && typeof vb === 'number'
            ? va - vb
            : String(va).localeCompare(String(vb))
        return asc ? cmp : -cmp
      })
    : rows
  return (
    <div className="border-rule rounded-surface mb-8 overflow-x-auto border">
      <table className="w-full text-sm">
        <thead>
          <tr>
            {columns.map((c) => (
              <Th key={c.key} className={c.numeric ? 'text-right' : ''}>
                {c.sort ? (
                  <button
                    type="button"
                    className="hover:text-ink cursor-pointer"
                    onClick={() => {
                      if (sortKey === c.key) setAsc(!asc)
                      else {
                        setSortKey(c.key)
                        setAsc(!c.numeric)
                      }
                    }}
                  >
                    {c.label}
                    {sortKey === c.key ? (asc ? ' ↑' : ' ↓') : ''}
                  </button>
                ) : (
                  c.label
                )}
              </Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr key={rowKey(row)} className="hover:bg-parchment-dark/50">
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={`border-rule border-b px-2.5 py-1.5 align-top ${
                    c.numeric ? 'text-right tabular-nums' : ''
                  }`}
                >
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {footer && <tfoot>{footer}</tfoot>}
      </table>
    </div>
  )
}
