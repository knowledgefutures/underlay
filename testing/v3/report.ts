/**
 * The report page, built from the results folder: what held, the measured
 * numbers beside layout F's, and each suite's detail. The words (verdict,
 * findings, limits) are in findings.ts; edit them there, not in the HTML.
 *
 *   node --import tsx v3/bench.ts report --out /path/underlay-v3-bench.html
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { FINDINGS, LAYOUT_F } from './findings.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type R = Record<string, any>

export function readResults(dir: string): R[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as R)
}

const esc = (s: unknown) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const GB = 1024 ** 3
const MB = 1024 ** 2
const n0 = (v: number) => Math.round(v).toLocaleString('en-US')
function num(v: unknown, digits = 1): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return ''
  if (Math.abs(v) >= 100 || Number.isInteger(v)) return n0(v)
  return v.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 })
}
function bytes(v: unknown): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return ''
  if (v >= GB) return `${num(v / GB, v >= 100 * GB ? 0 : 1)} GB`
  if (v >= MB) return `${num(v / MB, v >= 100 * MB ? 0 : 1)} MB`
  if (v >= 1024) return `${num(v / 1024, 0)} KB`
  return `${v} B`
}
function secs(v: unknown): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return ''
  if (v >= 5400) return `${num(v / 3600, 1)} h`
  if (v >= 120) return `${num(v / 60, 1)} min`
  if (v >= 1) return `${num(v, 1)} s`
  return `${num(v * 1000, 0)} ms`
}
const ms = (v: unknown) => (typeof v === 'number' ? secs(v / 1000) : '')

const SIZES: [suite: string, label: string][] = [
  ['quick', '100k'],
  ['1m', '1M'],
  ['5m', '5M'],
  ['12m', '12M'],
  ['crossref', 'Crossref, 180M'],
]

class Results {
  constructor(readonly all: R[]) {}
  get(suite: string, scenario: string, label = ''): R | undefined {
    return this.all.find(
      (r) => r.suite === suite && r.scenario === scenario && (r.label ?? '') === label,
    )
  }
  /** The first result of a scenario whose label starts with a prefix. */
  like(suite: string, scenario: string, prefix: string): R | undefined {
    return this.all.find(
      (r) =>
        r.suite === suite && r.scenario === scenario && String(r.label ?? '').startsWith(prefix),
    )
  }
  suites(): string[] {
    return [...new Set(this.all.map((r) => r.suite as string))]
  }
  many(): R | undefined {
    return this.all
      .filter((r) => r.scenario === 'many' && r.suite !== 'gate')
      .sort((a, b) => (b.collections ?? 0) - (a.collections ?? 0))[0]
  }
}

// --- Tables ---

function table(
  head: string[],
  rows: (string | number | undefined)[][],
  opts: { num?: number[] } = {},
): string {
  const isNum = (i: number) => (opts.num ? opts.num.includes(i) : i > 0)
  const th = head.map((h, i) => `<th${isNum(i) ? ' class="n"' : ''}>${h}</th>`).join('')
  const body = rows
    .map(
      (r) =>
        `<tr>${r.map((c, i) => `<td${isNum(i) ? ' class="n"' : ''}>${c ?? ''}</td>`).join('')}</tr>`,
    )
    .join('')
  return `<div class="scroll"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`
}

// --- Charts (static SVG; a hover layer is added by the page's script) ---

interface Series {
  name: string
  /** One value per category; null where there is none. */
  values: (number | null)[]
}

const PLOT = { w: 640, h: 250, left: 52, right: 16, top: 14, bottom: 34 }

function niceMax(v: number): number {
  if (v <= 0) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p
  return 10 * p
}

function axis(max: number, unit: (v: number) => string): { svg: string; y: (v: number) => number } {
  const { w, h, left, right, top, bottom } = PLOT
  const y = (v: number) => top + (h - top - bottom) * (1 - v / max)
  let svg = ''
  for (let i = 0; i <= 4; i++) {
    const v = (max * i) / 4
    svg += `<line x1="${left}" x2="${w - right}" y1="${y(v)}" y2="${y(v)}" class="${i === 0 ? 'base' : 'grid'}"/>`
    svg += `<text x="${left - 8}" y="${y(v) + 4}" text-anchor="end" class="tick">${esc(unit(v))}</text>`
  }
  return { svg, y }
}

const legend = (series: Series[]) =>
  series.length < 2
    ? ''
    : `<div class="legend">${series.map((s, i) => `<span><i class="sw s${i + 1}"></i>${esc(s.name)}</span>`).join('')}</div>`

/** Grouped columns: categories along x, a column per series. */
function columns(
  title: string,
  categories: string[],
  series: Series[],
  unit: (v: number) => string,
  note = '',
): string {
  const { w, h, left, right, bottom } = PLOT
  const max = niceMax(Math.max(...series.flatMap((s) => s.values.map((v) => v ?? 0))))
  const { svg: ax, y } = axis(max, unit)
  const band = (w - left - right) / categories.length
  const bar = Math.min(24, (band - 16) / series.length - 2)
  let marks = ''
  categories.forEach((c, ci) => {
    const x0 = left + band * ci + (band - (bar + 2) * series.length + 2) / 2
    series.forEach((s, si) => {
      const v = s.values[ci]
      if (v === null || v === undefined) return
      const x = x0 + (bar + 2) * si
      const top = y(v)
      const hh = Math.max(1, y(0) - top)
      const r = Math.min(4, hh)
      marks += `<path class="mark s${si + 1}" data-tip="${esc(`${c} · ${s.name}: ${unit(v)}`)}" d="M${x},${y(0)} v${-(hh - r)} q0,${-r} ${r},${-r} h${bar - 2 * r} q${r},0 ${r},${r} v${hh - r} z"/>`
      if (series.length * categories.length <= 12) {
        marks += `<text x="${x + bar / 2}" y="${top - 5}" text-anchor="middle" class="val">${esc(unit(v))}</text>`
      }
    })
    marks += `<text x="${left + band * (ci + 0.5)}" y="${h - bottom + 18}" text-anchor="middle" class="tick">${esc(c)}</text>`
  })
  return figure(
    title,
    `${legend(series)}<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">${ax}${marks}</svg>`,
    note,
    categories,
    series,
    unit,
  )
}

/** Lines: categories along x (evenly spaced), a line per series, the last point labeled. */
function lines(
  title: string,
  categories: string[],
  series: Series[],
  unit: (v: number) => string,
  note = '',
): string {
  const { w, h, left, right, bottom } = PLOT
  const max = niceMax(Math.max(...series.flatMap((s) => s.values.map((v) => v ?? 0))))
  const { svg: ax, y } = axis(max, unit)
  const step = (w - left - right - 60) / Math.max(1, categories.length - 1)
  const x = (i: number) => left + 14 + step * i
  let marks = ''
  categories.forEach((c, i) => {
    marks += `<text x="${x(i)}" y="${h - bottom + 18}" text-anchor="middle" class="tick">${esc(c)}</text>`
  })
  series.forEach((s, si) => {
    const pts = s.values.map((v, i) => (v === null ? null : ([x(i), y(v)] as const)))
    const path = pts.reduce(
      (d, p, i) => (p ? `${d}${d && pts[i - 1] ? 'L' : 'M'}${p[0]},${p[1]}` : d),
      '',
    )
    marks += `<path class="line s${si + 1}" d="${path}"/>`
    pts.forEach((p, i) => {
      if (!p) return
      marks += `<circle class="dot s${si + 1}" cx="${p[0]}" cy="${p[1]}" r="4" data-tip="${esc(`${categories[i]} · ${s.name}: ${unit(s.values[i]!)}`)}"/>`
    })
    const lastIndex = s.values.reduce<number>((li, v, i) => (v === null ? li : i), -1)
    if (lastIndex >= 0) {
      const p = pts[lastIndex]!
      marks += `<text x="${p[0] + 9}" y="${p[1] + 4}" class="val">${esc(unit(s.values[lastIndex]!))}</text>`
    }
  })
  return figure(
    title,
    `${legend(series)}<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">${ax}${marks}</svg>`,
    note,
    categories,
    series,
    unit,
  )
}

function figure(
  title: string,
  inner: string,
  note: string,
  categories: string[],
  series: Series[],
  unit: (v: number) => string,
): string {
  const data = table(
    ['', ...series.map((s) => esc(s.name))],
    categories.map((c, i) => [
      esc(c),
      ...series.map((s) => (s.values[i] === null ? '' : esc(unit(s.values[i]!)))),
    ]),
  )
  return `<figure class="chart"><figcaption>${esc(title)}</figcaption>${inner}${note ? `<p class="note">${note}</p>` : ''}<details><summary>The numbers</summary>${data}</details></figure>`
}

// --- Sections ---

function claims(r: Results): string {
  const suites = r.suites().filter((s) => s !== 'gate')
  const row = (claim: string, held: boolean | null, evidence: string) => [
    esc(claim),
    held === null
      ? '<span class="pill wait">not run yet</span>'
      : held
        ? '<span class="pill ok">✓ held</span>'
        : '<span class="pill bad">✕ did not hold</span>',
    evidence,
  ]
  const recreate = suites.map((s) => r.get(s, 'recreate')).filter(Boolean) as R[]
  const racing = r.all.filter((x) => x.scenario === 'racing' && x.suite !== 'gate')
  const sweeps = r.all.filter((x) => x.scenario === 'sweep' && x.suite !== 'gate')
  const forks = suites.map((s) => r.get(s, 'forks')).filter(Boolean) as R[]
  const loads = SIZES.map(([s]) => r.get(s, 'load')).filter(Boolean) as R[]
  const dailies = SIZES.map(
    ([s, label]) => [label, r.like(s, 'daily', 'maintained-')] as const,
  ).filter(([, d]) => d)
  const flat = dailies.length >= 2
  const first = dailies[0]?.[1]
  const last = dailies[dailies.length - 1]?.[1]
  const heap = Math.max(0, ...r.all.filter((x) => x.suite !== 'gate').flatMap((x) => peaks(x)))
  const many = r.many()
  const rows = [
    row(
      'A commit costs the same whatever the collection holds',
      flat ? last!.serverRequests.p50 <= first!.serverRequests.p50 + 4 : null,
      flat
        ? `${dailies.map(([l, d]) => `${l}: ${num(d!.serverRequests.p50)} requests`).join('; ')} for a day's commit`
        : '',
    ),
    row(
      'A first load is readable the moment it commits',
      loads.length > 0 ? loads.every((l) => l.firstRead.seconds < 5) : null,
      loads.length > 0
        ? `first read ${secs(Math.max(...loads.map((l) => l.firstRead.seconds)))} after the largest load's commit`
        : '',
    ),
    row(
      'The same rows give the same file id (originals can be made again)',
      recreate.length > 0 ? recreate.every((x) => x.differ === 0) : null,
      recreate.length > 0
        ? `${n0(recreate.reduce((n, x) => n + x.match, 0))} of ${n0(recreate.reduce((n, x) => n + x.commits, 0))} commits recreated to the ids in the log, originals deleted first`
        : '',
    ),
    row(
      'Racing writers: one winner for each number, no upload lost',
      racing.length > 0 ? racing.every((x) => x.oneWinnerPerNumber && x.lostUploads === 0) : null,
      racing
        .map(
          (x) =>
            `${x.writers} writers, ${n0(x.commits)} commits, ${num(x.commitsPerSecond)} a second`,
        )
        .join('; '),
    ),
    row(
      'The sweep never deletes a file a collection lists',
      sweeps.length > 0 || forks.length > 0
        ? sweeps.every((x) => x.broken === 0 && x.missing === 0) &&
            forks.every((f) => f.track.every((t: R) => t.missing === 0))
        : null,
      sweeps
        .map(
          (x) =>
            `${n0(x.deleted)} collections deleted and ${n0(x.thinned)} thinned under load, ${bytes(x.reclaimedBytes)} reclaimed, ${n0(x.checked)} checked`,
        )
        .join('; '),
    ),
    row(
      'A fork copies no records',
      forks.length > 0 ? forks.every((f) => f.fork.recordBytesAdded === 0) : null,
      forks.length > 0
        ? `largest fork wrote ${bytes(Math.max(...forks.map((f) => f.fork.bytes)))} in ${n0(Math.max(...forks.map((f) => f.fork.objects)))} small objects`
        : '',
    ),
    row(
      'Every job fits a Worker’s memory (a heap of 120 MB at most)',
      heap > 0 ? heap <= 120 : null,
      heap > 0 ? `every process ran under the cap; the most heap in use was ${n0(heap)} MB` : '',
    ),
    row(
      'Work across many collections is linear and streaming',
      many ? many.load.lastOverFirst < 1.3 : null,
      many
        ? `${n0(many.collections)} collections: the last thousand loaded in ${num(many.load.lastOverFirst, 2)}× the time of the first; a sweep pass took ${num(many.sweep[many.sweep.length - 1].msPerCollection, 2)} ms a collection`
        : '',
    ),
  ]
  return table(['Claim', 'Result', 'Measured'], rows, { num: [] })
}

function peaks(x: R): number[] {
  const out: number[] = []
  const walk = (o: unknown) => {
    if (!o || typeof o !== 'object') return
    for (const [k, v] of Object.entries(o as R)) {
      if (/peakHeapMb$/i.test(k) && typeof v === 'number') out.push(v)
      else if (k !== 'rows') walk(v)
    }
  }
  walk(x)
  return out
}

function besideF(r: Results): string {
  const v = (suite: string) => ({
    load: r.get(suite, 'load'),
    daily: r.get(suite, 'daily', 'f-rate-2'),
    reads: r.get(suite, 'reads', 'after-policy') ?? r.get(suite, 'reads', 'rebuilt'),
    rebuilt: r.get(suite, 'reads', 'rebuilt'),
  })
  const rows: (string | undefined)[][] = []
  for (const [suite, label] of [
    ['5m', '5M'],
    ['12m', '12M'],
  ] as const) {
    const f = LAYOUT_F[suite]
    const x = v(suite)
    if (!x.load && !x.daily) continue
    const cell = (a: string | undefined, b: string) => [
      a ?? '<span class="muted">not run</span>',
      b,
    ]
    const total = x.load
      ? x.load.build.seconds + x.load.verify.seconds + x.load.commit.seconds
      : undefined
    rows.push(
      [`<b>${label} records</b>`, '', ''],
      [
        'First load, upload to readable',
        ...cell(total === undefined ? undefined : secs(total), secs(f.loadSeconds)),
      ],
      [
        'Stored after the load',
        ...cell(
          x.load ? bytes(x.load.storedBytes) : undefined,
          `${bytes(f.loadBucketBytes)} (and ${bytes(f.loadInternalBytes)} of upload sessions)`,
        ),
      ],
      [
        'A day’s commit, server time',
        ...cell(x.daily ? secs(x.daily.serverSeconds.p50) : undefined, f.dailyCommitSeconds),
      ],
      [
        'A day’s commit, requests',
        ...cell(x.daily ? n0(x.daily.serverRequests.p50) : undefined, f.dailyRequests),
      ],
      [
        'Written for a day (commit and maintenance)',
        ...cell(
          x.daily
            ? bytes(x.daily.storedBytesPerDay.mean + (x.daily.rewrittenBytesPerDay ?? 0))
            : undefined,
          f.dailyWritten,
        ),
      ],
      [
        'One record, cold',
        ...cell(
          x.reads?.r2
            ? `${ms(x.reads.r2.pointCold.ms.p50)}, ${num(x.reads.r2.pointCold.requests.p50)} requests`
            : undefined,
          f.pointCold,
        ),
      ],
      [
        'One record, warm',
        ...cell(
          x.reads?.r2
            ? `${ms(x.reads.r2.pointWarm.ms.p50)}, ${num(x.reads.r2.pointWarm.requests.p50)} requests`
            : undefined,
          f.pointWarm,
        ),
      ],
      [
        'A page of 50',
        ...cell(
          x.reads?.r2
            ? `${ms(x.reads.r2.page50.ms.p50)}, ${num(x.reads.r2.page50.requests.p50)} requests`
            : undefined,
          f.page50,
        ),
      ],
      [
        'A diff page of 500, with what each was before',
        ...cell(
          x.reads?.r2?.diffPage500Before
            ? `${ms(x.reads.r2.diffPage500Before.ms.p50)}, ${num(x.reads.r2.diffPage500Before.requests.p50)} requests`
            : undefined,
          f.diffPage,
        ),
      ],
      [
        'Full export of the newest version',
        ...cell(
          x.rebuilt?.export
            ? `${secs(x.rebuilt.export.seconds)} (${x.rebuilt.export.parts} processes)`
            : undefined,
          f.exportLatest,
        ),
      ],
    )
  }
  const many = r.many()
  if (many) {
    const f = LAYOUT_F.many
    rows.push(
      [`<b>${n0(many.collections)} collections</b>`, '', ''],
      ['Loading them all', secs(many.load.seconds), f.load],
      ['Requests for one small commit, with its layout', perCommit(many.days?.[0]), f.perCommit],
      [
        `A burst of ${n0(many.burst.commits)} commits at once`,
        `${secs(many.burst.seconds)}, p95 ${ms(many.burst.commitMs.p95)}`,
        f.burst,
      ],
      [
        'Stored for each collection',
        bytes((many.stored.records?.bytes ?? 0) / many.collections),
        f.perCollection,
      ],
    )
  }
  if (rows.length === 0)
    return '<p class="muted">The 5M, 12M, and 20,000-collection runs have not landed yet.</p>'
  return table(['', 'v3', 'Layout F with deltas'], rows, { num: [] })
}

function commitChart(r: Results): string {
  const cats: string[] = []
  const seconds: (number | null)[] = []
  const requests: (number | null)[] = []
  for (const [suite, label] of SIZES) {
    const d = r.like(suite, 'daily', 'maintained-')
    if (!d) continue
    cats.push(label)
    seconds.push(d.serverSeconds.p50)
    requests.push(d.serverRequests.p50)
  }
  if (cats.length === 0) return ''
  return (
    columns(
      'Requests to commit a day’s upload, by collection size',
      cats,
      [{ name: 'requests', values: requests }],
      (v) => num(v, 0),
      'Checking the files and creating the commit, with the rebuild policy running after each day. It does not grow with the collection.',
    ) +
    columns(
      'Server seconds to commit a day’s upload, by collection size',
      cats,
      [{ name: 'seconds', values: seconds }],
      (v) => `${num(v, 2)} s`,
      'A day is the same share of the collection at every size (97,600 changes at Crossref’s), so the upload itself grows; the time is for streaming it once.',
    )
  )
}

const READ_STATES: [label: string, name: string][] = [
  ['0-since-rebuild', 'at load'],
  ['10-since-rebuild', '10 commits later'],
  ['30-since-rebuild', '30 commits later'],
  ['rebuilt', 'rebuilt'],
  ['after-policy', '30 more days, policy on'],
]

function readsChart(r: Results): string {
  const series: Series[] = []
  const runs: Series[] = []
  for (const [suite, label] of SIZES) {
    const values = READ_STATES.map(
      ([l]) => r.get(suite, 'reads', l)?.r2?.pointWarm?.requests?.mean ?? null,
    )
    if (values.every((v) => v === null)) continue
    if (series.length < 4) {
      series.push({ name: label, values })
      runs.push({
        name: label,
        values: READ_STATES.map(([l]) => r.get(suite, 'reads', l)?.r2?.runs ?? null),
      })
    }
  }
  if (series.length === 0) return ''
  const cats = READ_STATES.map(([, n]) => n)
  return (
    lines(
      'Requests for one record, footers cached, as commits pile up and are rebuilt',
      cats,
      series,
      (v) => num(v, 1),
      'Mean over 200 records. Each file whose key range covers the record costs a key block, unless the file is small enough to sit whole in its cached tail; then the record block.',
    ) +
    lines(
      'Runs a record may sit in',
      cats,
      runs,
      (v) => num(v, 0),
      'A run is one rebuild’s output or one commit’s files. A point read looks in each.',
    )
  )
}

function forkChart(r: Results): string {
  const series: Series[] = []
  let cats: string[] = []
  for (const [suite, label] of SIZES) {
    const f = r.get(suite, 'forks')
    if (!f || series.length >= 4) continue
    cats = f.track.map((t: R) => `day ${t.day}`)
    series.push({ name: label, values: f.track.map((t: R) => t.sharedShare * 100) })
  }
  if (series.length === 0) return ''
  return lines(
    'Share of a fork’s bytes stored once with its parent, as both change daily',
    cats,
    series,
    (v) => `${num(v, 1)}%`,
    'The fork is edited by 1% on day 0; then both take a day’s changes and run the rebuild policy each day.',
  )
}

function manyChart(r: Results): string {
  const many = r.many()
  if (!many) return ''
  const steps = many.load.steps as R[]
  return lines(
    `Seconds to load each thousand collections, of ${n0(many.collections)}`,
    steps
      .map((s) => `${n0(s.to / 1000)}k`)
      .map((c, i) =>
        steps.length > 12 && i % Math.ceil(steps.length / 10) !== 0 && i !== steps.length - 1
          ? ''
          : c,
      ),
    [{ name: 'seconds', values: steps.map((s) => s.seconds) }],
    (v) => `${num(v, 0)} s`,
    'Flat means nothing shared between collections slows as the location fills.',
  )
}

function policy(r: Results): string {
  const p =
    r.all.find((x) => x.scenario === 'policy' && x.suite !== 'gate') ??
    r.all.find((x) => x.scenario === 'policy')
  const y = r.all.find((x) => x.scenario === 'policy-year' && x.suite !== 'gate')
  let out = ''
  if (p) {
    out += `<h3>By arithmetic, at Crossref’s size over ${num(p.days / 365)} years</h3>`
    out += table(
      [
        'Ratio',
        'Runs a record may sit in, mean',
        'Most',
        'Lines rewritten a day',
        'Stored a day, at a quarter of lines',
        'Times each byte is rewritten',
        'Largest single merge',
      ],
      (p.ratios as R[]).map((x) => [
        x.ratio,
        num(x.meanRuns),
        x.maxRuns,
        bytes(x.rewrittenLineBytesPerDay),
        bytes(x.rewrittenLineBytesPerDay * 0.25),
        num(x.rewritesPerByte),
        bytes(x.largestMergeLineBytes),
      ]),
    )
  }
  if (y) {
    out += `<h3>For real, ${n0(y.ratios[0].days)} daily commits to ${n0(y.records)} records</h3>`
    out += table(
      [
        'Ratio',
        'Runs, mean',
        'Most',
        'At the end',
        'Stored bytes rewritten a day',
        'Requests for one record, warm',
      ],
      (y.ratios as R[]).map((x) => [
        x.ratio,
        num(x.meanRuns),
        x.maxRuns,
        x.runsAtEnd,
        bytes(x.rewrittenStoredBytesPerDay),
        num(x.warmRequests.mean),
      ]),
    )
  }
  return out
}

/** Fork, edit one record, rebuild: what the fork costs to store, by target file size. */
function forkEdit(r: Results): string {
  const x = r.all.find((q) => q.scenario === 'fork-edit' && q.suite !== 'gate')
  if (!x) return ''
  const rows = (x.targets as R[]).map((t) => [
    `${num(t.targetMb)} MB`,
    n0(t.files),
    bytes(t.meanFileBytes),
    `${bytes(t.tiered.extraBytes)}, ${t.tiered.forkRuns} runs`,
    `${bytes(t.folded.extraBytes)}, ${t.folded.forkRuns} run`,
    `${n0(t.fold.filesIn - t.fold.kept)} of ${n0(t.fold.filesIn)}`,
    secs(t.fold.seconds),
  ])
  return (
    `<h3>Fork, edit one record, rebuild (${n0(x.records)} records, ${bytes(x.targets[0].storedBytes)} stored)</h3>` +
    table(
      [
        'Target file size',
        'Files',
        'Mean file',
        'Fork adds, tier rule alone',
        'Fork adds, merged to one run',
        'Files rewritten',
        'Merge time',
      ],
      rows,
    ) +
    `<p class="note">${FINDINGS.forkEdit}</p>`
  )
}

function suiteDetail(r: Results, suite: string, label: string): string {
  const load = r.get(suite, 'load')
  if (!load) return ''
  let out = `<h3>${esc(label)}</h3>`
  const stored = load.stored as R
  out += table(
    ['First load', ''],
    [
      ['Records', n0(load.records)],
      ['Lines, uncompressed', bytes(load.lineBytes)],
      [
        'Stored',
        `${bytes(load.storedBytes)} (${num(load.storedOverLines * 100)}% of lines) in ${n0(load.files)} files`,
      ],
      [
        'Building (the client)',
        `${secs(load.build.seconds)}, ${n0(load.build.recordsPerSecond)} records a second, ${num(load.build.mbPerCpuSecond)} MB of lines a CPU second`,
      ],
      [
        'Verifying and validating (the server)',
        `${secs(load.verify.seconds)}, ${num(load.verify.mbPerCpuSecond)} MB a CPU second`,
      ],
      [
        'Creating the commit',
        `${secs(load.commit.seconds)}, ${n0(load.commit.classA)} class A and ${n0(load.commit.classB)} class B requests`,
      ],
      [
        'First read after the commit',
        `${secs(load.firstRead.seconds)}, ${n0(load.firstRead.requests)} requests`,
      ],
      [
        'Most memory in one process',
        `${n0(Math.max(load.build.peakRssMb, load.verify.peakRssMb))} MB resident, ${n0(Math.max(load.build.peakHeapMb, load.verify.peakHeapMb))} MB of heap`,
      ],
      [
        'Stored by kind',
        Object.entries(stored)
          .map(([k, v]) => `${k} ${bytes((v as R).bytes)}`)
          .join(', '),
      ],
    ],
    { num: [] },
  )
  const dailies = r.all
    .filter((x) => x.suite === suite && x.scenario === 'daily')
    .sort((a, b) => String(a.at).localeCompare(String(b.at)))
  if (dailies.length > 0) {
    out += table(
      [
        'Daily commits',
        'Changes a day',
        'Stored a day',
        'Server time',
        'Server CPU',
        'Requests',
        'Class A',
        'Rewritten a day by rebuilds',
        'Most heap',
      ],
      dailies.map((d) => [
        esc(`${d.label}${d.maintain ? ', policy on' : ''}`),
        num(d.changesPerDay.mean, 0),
        bytes(d.storedBytesPerDay.mean),
        secs(d.serverSeconds.p50),
        secs(d.serverCpuSeconds.p50),
        num(d.serverRequests.p50, 0),
        num(d.serverClassA.p50, 0),
        d.maintain ? bytes(d.rewrittenBytesPerDay) : '',
        `${n0(d.serverPeakHeapMb)} MB`,
      ]),
    )
  }
  const reads = r.all.filter((x) => x.suite === suite && x.scenario === 'reads')
  if (reads.length > 0) {
    const rows: (string | number | undefined)[][] = []
    for (const [l, name] of READ_STATES) {
      const x = reads.find((q) => q.label === l)
      if (!x) continue
      for (const profile of ['r2', 'r2-slow', 'none']) {
        const p = x[profile] as R | undefined
        if (!p) continue
        const cell = (s: R | undefined) => (s ? `${num(s.requests.p50)} · ${ms(s.ms.p50)}` : '')
        rows.push([
          esc(`${name} (${profile})`),
          p.runs,
          cell(p.pointCold),
          cell(p.pointWarm),
          bytes(p.pointWarm.bytes.mean),
          cell(p.page50),
          cell(p.diffPage500),
          cell(p.diffPage500Before),
          cell(p.history),
        ])
      }
    }
    out += table(
      [
        'Reads: requests · time, medians',
        'Runs',
        'One record, cold',
        'One record, warm',
        'Bytes, warm',
        'Page of 50',
        'Diff page of 500',
        'Diff page, with before',
        'History of a key',
      ],
      rows,
    )
    const ex = reads.filter((x) => x.export)
    if (ex.length > 0) {
      out += table(
        ['Export', 'Records', 'Lines', 'Time', 'Processes', 'MB a second', 'Requests', 'Most heap'],
        ex.map((x) => [
          esc(READ_STATES.find(([l]) => l === x.label)?.[1] ?? x.label),
          n0(x.export.records),
          bytes(x.export.bytes),
          secs(x.export.seconds),
          x.export.parts,
          num(x.export.mbPerSecond),
          n0(x.export.classB),
          `${n0(x.export.peakHeapMb)} MB`,
        ]),
      )
    }
  }
  const rows: (string | number | undefined)[][] = []
  const m = r.get(suite, 'maintain', 'catch-up')
  if (m)
    rows.push([
      'Rebuild after 30 commits',
      `${secs(m.seconds)}: ${m.merges} merges of ${m.filesIn} files into ${m.filesOut}, ${bytes(m.written)} written; runs ${m.runsBefore} to ${m.runs}; most heap ${n0(m.peakHeapMb)} MB`,
    ])
  const rc = r.get(suite, 'recreate')
  if (rc)
    rows.push([
      'Recreating originals',
      `${n0(rc.match)} of ${n0(rc.commits)} commits match (${n0(rc.originalsGone)} had their files deleted first), ${secs(rc.seconds)}, ${n0(rc.classB)} requests`,
    ])
  const sc = r.get(suite, 'schema')
  if (sc)
    rows.push([
      'Schema change',
      `relaxing: ${secs(sc.relaxed.seconds)}, no records read. Tightening: ${secs(sc.stricter.seconds)} to scan ${n0(sc.stricter.scanned)} records of ${esc(sc.type)} (${n0(sc.stricter.recordsPerSecond)} a second, ${num(sc.stricter.mbPerCpuSecond)} MB a CPU second, one process)`,
    ])
  const fk = r.get(suite, 'forks')
  if (fk) {
    const lastTrack = fk.track[fk.track.length - 1] as R
    rows.push([
      'Fork',
      `${secs(fk.fork.seconds)}, ${n0(fk.fork.objects)} small objects, ${bytes(fk.fork.bytes)} written, ${bytes(fk.fork.recordBytesAdded)} of records. After ${fk.days} days of changes to both: ${num(lastTrack.sharedShare * 100)}% of the fork still shared; the two list ${bytes(lastTrack.parentBytes + lastTrack.forkBytes)}, the location stores ${bytes(lastTrack.physicalBytes)}`,
    ])
  }
  const st = r.get(suite, 'storage')
  if (st) {
    rows.push([
      'What the stored files are made of',
      `${n0(st.all.files)} files, ${bytes(st.all.bytes)}: record blocks ${bytes(st.all.recordBlocks)}, key blocks ${bytes(st.all.keyBlocks)} (${num(st.keyBlockShare * 100)}%, ${num(st.keyBytesPerEntry)} bytes an entry), footers ${bytes(st.all.footers)}; commits ${bytes(st.stored.commits?.bytes ?? 0)}, layouts ${bytes(st.stored.layouts?.bytes ?? 0)}`,
    ])
  }
  if (rows.length > 0) out += table(['Other steps', ''], rows, { num: [] })
  return out
}

/** Requests for a commit in a many-collections phase: the phase's total over its commits. */
const perCommit = (d: R | undefined): string =>
  d && d.commits > 0 ? num((d.classA + d.classB) / d.commits) : ''

function manyDetail(r: Results): string {
  const many = r.many()
  if (!many) return ''
  const sweep = r.all.find((x) => x.scenario === 'sweep' && x.suite === many.suite)
  const rows: (string | number | undefined)[][] = [
    [
      'Collections',
      `${n0(many.collections)}; first loads of a median ${many.records} records, a few of thousands`,
    ],
    [
      'Loading',
      `${secs(many.load.seconds)}, ${num((many.load.seconds / 60 / many.collections) * 1000)} minutes a thousand, ${many.load.failed} failed`,
    ],
    ...(many.days as R[]).map((d) => [
      `Day ${d.day}: a commit to every collection`,
      `${secs(d.seconds)}, ${num(d.commitsPerSecond)} commits a second, ${perCommit(d)} requests each with its layout, ${n0(d.merges)} merges, ${d.failed} failed`,
    ]),
    [
      `Burst: ${n0(many.burst.commits)} commits at once`,
      `${secs(many.burst.seconds)}, ${num(many.burst.commitsPerSecond)} a second, median ${ms(many.burst.commitMs.p50)}, p95 ${ms(many.burst.commitMs.p95)}, ${many.burst.failed} failed`,
    ],
    ...(many.sweep as R[]).map((p) => [
      `Sweep pass ${p.pass}`,
      `${secs(p.seconds)} for ${n0(p.collections)} collections and ${n0(p.files)} files: ${num(p.msPerCollection, 2)} ms and ${num(p.requestsPerCollection)} requests a collection, most heap ${n0(p.peakHeapMb)} MB`,
    ]),
    [
      'Most memory in one process',
      `${n0(Math.max(many.burst.peakRssMb, ...(many.days as R[]).map((d) => d.peakRssMb)))} MB resident`,
    ],
    [
      'Stored',
      Object.entries(many.stored as R)
        .map(([k, v]) => `${k} ${bytes((v as R).bytes)}`)
        .join(', '),
    ],
  ]
  if (sweep) {
    rows.push([
      'Sweep under load',
      `${n0(sweep.deleted)} collections deleted and ${n0(sweep.thinned)} thinned while ${n0(sweep.committed)} commits landed; ${bytes(sweep.reclaimedBytes)} reclaimed; ${n0(sweep.checked)} collections checked after, ${sweep.broken} broken, ${sweep.missing} listed files missing`,
    ])
  }
  return table(['Many collections', ''], rows, { num: [] })
}

function runsTable(r: Results): string {
  const bySuite = new Map<string, R[]>()
  for (const x of r.all) {
    if (x.suite === 'gate') continue
    bySuite.set(x.suite, [...(bySuite.get(x.suite) ?? []), x])
  }
  return table(
    ['Suite', 'Machine', 'Commit', 'Latency', 'Heap cap', 'Finished', 'Command'],
    [...bySuite].map(([suite, xs]) => {
      const lastOne = xs.sort((a, b) => String(a.at).localeCompare(String(b.at)))[xs.length - 1]!
      return [
        esc(suite),
        esc(`${lastOne.host}, ${lastOne.cpus} threads, ${lastOne.memoryGb} GB`),
        `<code>${esc(lastOne.commit)}</code>`,
        esc(lastOne.latency),
        lastOne.heapCapMb ? `${lastOne.heapCapMb} MB` : 'none',
        esc(String(lastOne.at).slice(0, 16).replace('T', ' ')),
        `<code>bench ${esc(lastOne.command)}</code>`,
      ]
    }),
    { num: [] },
  )
}

export function buildReport(results: R[]): string {
  const r = new Results(results)
  const details = SIZES.map(([s, l]) => suiteDetail(r, s, l)).join('')
  return `<title>Underlay v3 Scale Bench</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>
/* Layout: one plain column, dense tables, charts first in each section; an internal review page. */
:root {
  --bg: #f9f9f7; --surface: #fcfcfb; --fg: #0b0b0b; --fg2: #52514e; --muted: #898781;
  --line: #e1e0d9; --base: #c3c2b7; --accent: #2a78d6;
  --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a; --s4: #eda100;
  --ok: #006300; --ok-bg: #e4f3e2; --bad: #b02a2a; --bad-bg: #fbe6e4; --wait-bg: #eeede8;
  --sans: system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #0d0d0d; --surface: #1a1a19; --fg: #f0efec; --fg2: #c3c2b7; --muted: #898781;
    --line: #2c2c2a; --base: #383835; --accent: #3987e5;
    --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500;
    --ok: #0ca30c; --ok-bg: #12290f; --bad: #e66767; --bad-bg: #331615; --wait-bg: #262624;
    color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --bg: #0d0d0d; --surface: #1a1a19; --fg: #f0efec; --fg2: #c3c2b7; --muted: #898781;
  --line: #2c2c2a; --base: #383835; --accent: #3987e5;
  --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500;
  --ok: #0ca30c; --ok-bg: #12290f; --bad: #e66767; --bad-bg: #331615; --wait-bg: #262624;
  color-scheme: dark;
}
body {
  background: var(--bg); color: var(--fg); font: 14px/1.5 var(--sans);
  padding-left: max(16px, env(safe-area-inset-left, 0px));
  padding-right: max(16px, env(safe-area-inset-right, 0px));
  padding-block: 24px 56px;
}
main { max-width: 960px; margin: 0 auto; display: grid; gap: 10px; }
main > * { min-width: 0; }
h1 { font-size: 24px; line-height: 1.2; margin: 0; font-weight: 650; }
h2 { font-size: 17px; margin: 26px 0 0; padding-top: 14px; border-top: 1px solid var(--base); font-weight: 650; }
h3 { font-size: 14px; margin: 14px 0 0; font-weight: 650; }
p, li { max-width: 78ch; margin: 0; }
ul { margin: 0; padding-left: 20px; display: grid; gap: 4px; }
.meta, .muted, .note { color: var(--fg2); font-size: 13px; }
.note { margin-top: 4px; }
code { font: 12.5px var(--mono); background: var(--wait-bg); padding: 1px 4px; border-radius: 3px; }
a { color: var(--accent); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 13px; font-variant-numeric: tabular-nums; }
th, td { text-align: left; vertical-align: top; padding: 5px 10px 5px 0; border-bottom: 1px solid var(--line); }
th { font-weight: 600; color: var(--fg2); border-bottom-color: var(--base); white-space: nowrap; }
td.n, th.n { text-align: right; white-space: nowrap; padding-right: 14px; }
td:first-child { padding-right: 16px; }
.pill { display: inline-block; white-space: nowrap; padding: 0 7px; border-radius: 3px; font-size: 12.5px; font-weight: 600; }
.pill.ok { color: var(--ok); background: var(--ok-bg); }
.pill.bad { color: var(--bad); background: var(--bad-bg); }
.pill.wait { color: var(--fg2); background: var(--wait-bg); font-weight: 500; }
.charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); gap: 14px; }
.chart { margin: 0; background: var(--surface); border: 1px solid var(--line); border-radius: 4px; padding: 12px 14px; min-width: 0; position: relative; }
.chart figcaption { font-weight: 600; font-size: 13.5px; text-wrap: balance; }
.chart svg { display: block; width: 100%; height: auto; margin-top: 6px; }
.chart details { margin-top: 6px; font-size: 12.5px; color: var(--fg2); }
.chart summary { cursor: pointer; }
.legend { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12.5px; color: var(--fg2); margin-top: 6px; }
.legend i.sw { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 5px; }
.sw.s1, .mark.s1, .dot.s1 { fill: var(--s1); background: var(--s1); }
.sw.s2, .mark.s2, .dot.s2 { fill: var(--s2); background: var(--s2); }
.sw.s3, .mark.s3, .dot.s3 { fill: var(--s3); background: var(--s3); }
.sw.s4, .mark.s4, .dot.s4 { fill: var(--s4); background: var(--s4); }
.line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.line.s1 { stroke: var(--s1); } .line.s2 { stroke: var(--s2); } .line.s3 { stroke: var(--s3); } .line.s4 { stroke: var(--s4); }
.dot { stroke: var(--surface); stroke-width: 2; }
.grid { stroke: var(--line); stroke-width: 1; } .base { stroke: var(--base); stroke-width: 1; }
.tick { fill: var(--muted); font: 11px var(--sans); font-variant-numeric: tabular-nums; }
.val { fill: var(--fg2); font: 11px var(--sans); font-variant-numeric: tabular-nums; }
.mark, .dot { cursor: default; }
#tip { position: fixed; pointer-events: none; background: var(--fg); color: var(--bg); font-size: 12.5px; padding: 3px 8px; border-radius: 3px; z-index: 5; max-width: 280px; }
</style>
<main>
  <div class="meta">kf/underlay · protocol v3 · ${esc(FINDINGS.date)}</div>
  <h1>Underlay v3 Scale Bench</h1>
  <p>${FINDINGS.lede}</p>
  <p class="meta">${FINDINGS.status}</p>

  <h2>Where it stands</h2>
  ${FINDINGS.verdict}

  <h2>The design’s claims</h2>
  ${claims(r)}

  <h2>Commits</h2>
  <div class="charts">${commitChart(r)}</div>

  <h2>Reads and rebuilds</h2>
  <div class="charts">${readsChart(r)}</div>
  ${FINDINGS.reads}

  <h2>The rebuild policy over years</h2>
  ${policy(r)}
  ${FINDINGS.policy}

  <h2>Forks and many collections</h2>
  <div class="charts">${forkChart(r)}${manyChart(r)}</div>
  ${forkEdit(r)}
  ${manyDetail(r)}

  <h2>Beside layout F</h2>
  ${besideF(r)}
  <p class="note">${FINDINGS.besideF}</p>

  <h2>Against R2’s documented limits</h2>
  ${FINDINGS.r2}

  <h2>Not built, and what to change first</h2>
  ${FINDINGS.open}

  <h2>Each size in detail</h2>
  ${details || '<p class="muted">No sized suite has landed yet.</p>'}

  <h2>The runs</h2>
  ${runsTable(r)}
  <p class="note">${FINDINGS.method}</p>
</main>
<div id="tip" hidden></div>
<script>
(function () {
  var tip = document.getElementById('tip');
  document.addEventListener('pointermove', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-tip]') : null;
    if (!t) { tip.hidden = true; return; }
    tip.textContent = t.getAttribute('data-tip');
    tip.hidden = false;
    var x = Math.min(window.innerWidth - tip.offsetWidth - 8, e.clientX + 12);
    tip.style.left = Math.max(8, x) + 'px';
    tip.style.top = Math.max(8, e.clientY - 30) + 'px';
  });
})();
</script>
`
}

export function writeReport(resultsDir: string, out: string): void {
  writeFileSync(out, buildReport(readResults(resultsDir)))
}
