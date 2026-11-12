/**
 * The report page, built from the results folder: what held, the measured
 * numbers beside layout F's, and each suite's detail. The words (verdict,
 * findings, limits) are in findings.ts; edit them there, not in the HTML.
 *
 *   node --import tsx v3/bench.ts report --out /path/underlay-v3-bench.html
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { F_NUMBERS, FINDINGS, GROUPS_FIX, LAYOUT_F } from './findings.js'

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
/** A record count in a few characters: 100k, 1M, 12M. */
const short = (v: number) =>
  v >= 1e6 ? `${+(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${Math.round(v / 1e3)}k` : String(v)
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

/**
 * How many groups of files a read looked in: a group is one rebuild's output or one
 * commit's own files, and a read checks one sorted-record-file for each. (Results made
 * before the word was dropped call this `runs`.)
 */
const groupsOf = (p: R | undefined): number | null => p?.groups ?? p?.runs ?? null
/** The same for a named result, with the bench's known miscounts put right. */
const groupsAt = (x: R | undefined, p: R | undefined): number | null =>
  (x && GROUPS_FIX[`${x.suite}/${x.scenario}/${x.label ?? ''}`]) ?? groupsOf(p)

const SIZES: [suite: string, label: string][] = [
  ['quick', '100k'],
  ['1m', '1M'],
  ['5m', '5M'],
  ['12m', '12M'],
  ['crossref', 'Crossref'],
]

/** The sizes with a detail section: every size, and the sample of Crossref tried before the whole. */
const DETAILS: [suite: string, label: string][] = [
  ...SIZES.slice(0, 4),
  ['crossref-mid', 'Crossref sample (2,000 of the dump’s 36,626 files)'],
  ['crossref', 'Crossref (171.8M of its 179.5M records, then the rest)'],
]

/** Where the same 1,000-change upload was committed, smallest collection first. */
const FIXED: [suite: string, label: string][] = [
  ['quick', '100k'],
  ['1m', '1M'],
  ['5m', '5M'],
  ['12m', '12M'],
  ['fork-edit', ''],
]

/** A reads step's name, from its label. */
function readName(label: string): string {
  const fixed = READ_STATES.find(([l]) => l === label)?.[1]
  if (fixed) return fixed
  const m = /^(\d+)-since-rebuild$/.exec(label)
  return m ? `${m[1]} commits later` : label
}

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
  const ends: { x: number; y: number; text: string }[] = []
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
      ends.push({ x: p[0] + 9, y: p[1] + 4, text: unit(s.values[lastIndex]!) })
    }
  })
  // End labels: one for each distinct value, moved apart where the lines end together.
  ends.sort((a, b) => a.y - b.y)
  let lastY = -Infinity
  const shown = new Set<string>()
  for (const e of ends) {
    if (shown.has(`${e.x}/${e.text}`)) continue
    shown.add(`${e.x}/${e.text}`)
    const yy = Math.max(e.y, lastY + 12)
    lastY = yy
    marks += `<text x="${e.x}" y="${yy}" class="val">${esc(e.text)}</text>`
  }
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
      ? '<span class="pill wait">not measured yet</span>'
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
  // The same upload at each size is the fair test: a day's upload grows with the collection.
  const fixed = FIXED.map(([s, label]) => {
    const d = r.get(s, 'daily', 'fixed-1000')
    return d ? ([label || short(d.records), d] as const) : null
  }).filter(Boolean) as (readonly [string, R])[]
  const flat = fixed.length >= 2
  const first = fixed[0]?.[1]
  const last = fixed[fixed.length - 1]?.[1]
  const heap = Math.max(0, ...r.all.filter((x) => x.suite !== 'gate').flatMap((x) => peaks(x)))
  const many = r.many()
  const rows = [
    row(
      'A commit costs the same whatever the collection holds',
      flat
        ? last!.serverRequests.p50 <= first!.serverRequests.p50 + 3 &&
            last!.serverSeconds.p50 <= first!.serverSeconds.p50 * 1.5 + 0.2
        : null,
      flat
        ? `the same 1,000-change upload: ${fixed.map(([l, d]) => `${l}: ${num(d.serverRequests.p50)} requests, ${secs(d.serverSeconds.p50)}`).join('; ')}`
        : dailies.length > 0
          ? `a day’s upload, which grows with the collection: ${dailies.map(([l, d]) => `${l}: ${num(d!.serverRequests.p50)} requests`).join('; ')}. The same upload at each size comes in the next round`
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
        .sort((a, b) => a.writers - b.writers)
        .map(
          (x) =>
            `${x.writers} writers to one collection: ${n0(x.commits)} commits, each number won once, ${num(x.commitsPerSecond)} a second`,
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
    return '<p class="muted">The 5M, 12M, and 20,000-collection results have not landed yet.</p>'
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
      'Checking the files and creating the commit, with the rebuild policy on. A day is the same share of the collection at every size, so the upload grows with each column; the requests barely do.',
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
  ['after-policy', 'more days, policy on'],
]

function readsChart(
  r: Results,
  opts: { sizes?: [string, string][]; only?: 'requests' } = {},
): string {
  const series: Series[] = []
  const checked: Series[] = []
  for (const [suite, label] of opts.sizes ?? SIZES) {
    const values = READ_STATES.map(
      ([l]) => r.get(suite, 'reads', l)?.r2?.pointWarm?.requests?.mean ?? null,
    )
    if (values.every((v) => v === null)) continue
    if (series.length < 4) {
      series.push({ name: label, values })
      checked.push({
        name: label,
        values: READ_STATES.map(([l]) => {
          const x = r.get(suite, 'reads', l)
          return groupsAt(x, x?.r2)
        }),
      })
    }
  }
  if (series.length === 0) return ''
  const cats = READ_STATES.map(([, n]) => n)
  if (opts.only === 'requests') {
    return lines(
      'Requests for one record, footers cached, as commits pile up and are rebuilt',
      cats,
      series,
      (v) => num(v, 1),
      'Mean over 200 records. With no rebuild, every commit is one more request; the rebuild brings it back down.',
    )
  }
  return (
    lines(
      'Requests for one record, footers cached, as commits pile up and are rebuilt',
      cats,
      series,
      (v) => num(v, 1),
      'Mean over 200 records. Each file whose key range covers the record costs a key block, then the record block. A small file’s key blocks come with its footer (the last 64 KB, read once and cached), so below about 1,000 changes a day a day’s file costs nothing more. Above that it costs a request, which is why the larger sizes climb until the rebuild.',
    ) +
    lines(
      'Sorted-record-files a read of one record checks',
      cats,
      checked,
      (v) => num(v, 0),
      'The files one rebuild wrote, or one commit’s own, have key ranges that don’t overlap, so a read checks one sorted-record-file from each such group.',
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
        'Files a read checks, mean',
        'Most',
        'Lines rewritten a day',
        'Stored a day (¼ of lines)',
        'Rewrites of each byte',
        'Largest single merge',
      ],
      (p.ratios as R[]).map((x) => [
        x.ratio,
        num(x.meanGroups ?? x.meanRuns),
        x.maxGroups ?? x.maxRuns,
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
        'Files a read checks, mean',
        'Most',
        'At the end',
        'Stored bytes rewritten a day',
        'Requests for one record, warm',
      ],
      (y.ratios as R[]).map((x) => [
        x.ratio,
        num(x.meanGroups ?? x.meanRuns),
        x.maxGroups ?? x.maxRuns,
        x.groupsAtEnd ?? x.runsAtEnd,
        bytes(x.rewrittenStoredBytesPerDay),
        num(x.warmRequests.mean),
      ]),
    )
  }
  return out
}

/** Fork, edit one record, rebuild: what the fork costs to store, by target file size. */
function forkEdit(r: Results): string {
  const all = r.all
    .filter((q) => q.scenario === 'fork-edit' && q.suite !== 'gate')
    .sort((a, b) => a.records - b.records)
  if (all.length === 0) return ''
  let out = ''
  for (const x of all) {
    const near = (x.targets as R[]).some((t) => t.near)
    const rows = (x.targets as R[]).map((t) => [
      `${num(t.targetMb)} MB`,
      n0(t.files),
      bytes(t.meanFileBytes),
      `${bytes(t.tiered.extraBytes)}; a read checks ${t.tiered.forkGroups ?? t.tiered.forkRuns} files`,
      `${bytes(t.folded.extraBytes)}; a read checks ${t.folded.forkGroups ?? t.folded.forkRuns}`,
      `${n0(t.files - t.fold.kept)} of ${n0(t.files)}`,
      secs(t.fold.seconds),
      ...(near
        ? [
            t.near
              ? `${bytes(t.near.extraBytes)} for an edit of ${bytes(t.near.editBytes)}; ${n0(t.files - t.near.kept)} of the parent’s files rewritten`
              : '',
          ]
        : []),
    ])
    out +=
      `<h3>Fork, edit one record, rebuild (${n0(x.records)} records, ${bytes(x.targets[0].storedBytes)} stored)</h3>` +
      table(
        [
          'Target file size',
          'Files',
          'Mean file',
          'Fork adds, tier rule alone',
          'Fork adds, once merged back together',
          'Of the parent’s files, rewritten',
          'Merge time',
          ...(near ? ['Fork adds: 1% edited side by side, merged'] : []),
        ],
        rows,
      )
    // How sharing fades over days, by policy.
    const fades = (x.targets as R[]).flatMap((t) =>
      (
        [
          ['fadeTier', 'tier rule'],
          ['fadeKeep', 'merge all daily, keep untouched files'],
        ] as const
      )
        .filter(([k]) => t[k])
        .map(([k, name]) => ({ t, f: t[k] as R, name })),
    )
    if (fades.length > 0) {
      const days = [...new Set(fades.flatMap(({ f }) => (f.track as R[]).map((p) => p.day)))].sort(
        (a, b) => a - b,
      )
      out +=
        `<h3>Share of a fork still stored once with its parent (${n0(x.records)} records; 1% edited on day 0, then a day’s changes to both)</h3>` +
        table(
          [
            'Target file size',
            'Rebuild',
            ...days.map((d) => `Day ${d}`),
            'Rewritten a day',
            'Files a read checks at the end',
          ],
          fades.map(({ t, f, name }) => {
            const track = f.track as R[]
            const last = track[track.length - 1]!
            return [
              `${num(t.targetMb)} MB`,
              name,
              ...days.map((d) => {
                const p = track.find((q) => q.day === d)
                return p ? `${num(p.sharedShare * 100)}%` : ''
              }),
              bytes(f.rewrittenBytes / Math.max(1, f.days)),
              last.forkGroups,
            ]
          }),
        )
    }
  }
  return out + `<p class="note">${FINDINGS.forkEdit}</p>`
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
    reads.sort((a, b) => String(a.at).localeCompare(String(b.at)))
    for (const x of reads) {
      const name = readName(x.label)
      for (const profile of ['r2', 'r2-slow', 'none']) {
        const p = x[profile] as R | undefined
        if (!p) continue
        const cell = (s: R | undefined) => (s ? `${num(s.requests.p50)} · ${ms(s.ms.p50)}` : '')
        rows.push([
          esc(`${name} (${profile})`),
          groupsAt(x, p) ?? '',
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
        'Files checked',
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
          esc(readName(x.label)),
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
      'The rebuild policy, catching up on the commits so far',
      m.merges > 0
        ? `${secs(m.seconds)}: ${m.merges} merges of ${m.filesIn} files into ${m.filesOut}, ${bytes(m.written)} written; files a read checks, ${m.groupsBefore ?? m.runsBefore} to ${groupsAt(m, m)}; most heap ${n0(m.peakHeapMb)} MB`
        : `${secs(m.seconds)}: nothing to merge yet (fewer than ten groups of files at one tier), so one layout file listing them all; files a read checks, ${m.groups ?? m.runs}`,
    ])
  const rest = r.get(suite, 'load', 'rest')
  if (rest) {
    const rm = r.get(suite, 'maintain', 'rest')
    const rr = r.get(suite, 'reads', 'with-rest')?.r2
    rows.push([
      'The rest of the dump, as one upload onto the collection',
      `${n0(rest.records)} records from ${n0(rest.dumpFiles)} dump files, ${bytes(rest.storedBytes)} stored in ${n0(rest.files)} files: built in ${secs(rest.build.seconds)}, verified in ${secs(rest.verify.seconds)}, committed in ${secs(rest.commit.seconds)} and ${n0(rest.commit.classA + rest.commit.classB)} requests` +
        (rm
          ? `. The rebuild policy then merged ${n0(rm.filesIn)} files into ${n0(rm.filesOut)} in ${secs(rm.seconds)} on one process (${bytes(rm.written)} written, ${n0(rm.peakHeapMb)} MB of heap)`
          : '') +
        (rr
          ? `. One record after that: ${num(rr.pointWarm.requests.p50)} requests warm (${ms(rr.pointWarm.ms.p50)}), ${num(rr.pointCold.requests.p50)} cold`
          : ''),
    ])
  }
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
      `relaxing: ${secs(sc.relaxed.seconds)}, no records read. Tightening: ${secs(sc.stricter.seconds)} to scan ${n0(sc.stricter.scanned)} records of ${esc(sc.type)} (${n0(sc.stricter.recordsPerSecond)} a second${sc.stricter.mbPerCpuSecond === undefined ? '' : `, ${num(sc.stricter.mbPerCpuSecond)} MB a CPU second`}, one process)`,
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

function suitesTable(r: Results): string {
  const bySuite = new Map<string, R[]>()
  for (const x of r.all) {
    if (x.suite === 'gate') continue
    bySuite.set(x.suite, [...(bySuite.get(x.suite) ?? []), x])
  }
  return table(
    ['Suite', 'Machine', 'Commit', 'Latency', 'Heap cap', 'Finished (UTC)', 'Command'],
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

// --- The summary ---

interface Pair {
  label: string
  /** The same unit for both. */
  v3: number
  f: number
  show: (v: number) => string
  /** Layout F's value as text, where it was two days' numbers. */
  fText?: string
  /** What less of it is: faster, fewer. */
  word: string
}

const times = (x: number) => (x >= 10 ? n0(x) : num(x, 1))

/** Hours and minutes, for a time people plan around. */
function hm(seconds: number): string {
  if (seconds < 3600) return secs(seconds)
  const m = Math.round(seconds / 60)
  return `${Math.floor(m / 60)} h ${m % 60} min`
}

/** Pairs of bars, v3 over layout F, each pair on a scale of its own, with how many times less. */
function compare(title: string, pairs: Pair[]): string {
  if (pairs.length === 0) return ''
  const rows = pairs.map((p) => {
    const max = Math.max(p.v3, p.f)
    const w = (v: number) => Math.max(0.6, (v / max) * 100).toFixed(1)
    const fText = p.fText ?? p.show(p.f)
    const gain = p.f / p.v3
    return `<div class="cmp-row">
<div class="cmp-label">${p.label}</div>
<div class="cmp-bars">
<div class="cmp-bar" data-tip="${esc(`v3: ${p.show(p.v3)}`)}"><span class="track"><i class="bar v3" style="width:${w(p.v3)}%"></i></span><span class="cmp-val">${esc(p.show(p.v3))}</span></div>
<div class="cmp-bar" data-tip="${esc(`Layout F: ${fText}`)}"><span class="track"><i class="bar f" style="width:${w(p.f)}%"></i></span><span class="cmp-val f">${esc(fText)}</span></div>
</div>
<div class="cmp-gain">${gain >= 1.05 ? `<b>${times(gain)}×</b> ${p.word}` : 'about the same'}</div>
</div>`
  })
  return `<h3>${title}</h3>${rows.join('')}`
}

function hero(r: Results): string {
  const mid = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length
  const size = r.get('12m', 'load') ? '12m' : r.get('5m', 'load') ? '5m' : null
  let out = ''
  if (size) {
    const f = F_NUMBERS[size]
    const load = r.get(size, 'load')!
    const daily = r.get(size, 'daily', 'f-rate-2')
    const reads = r.get(size, 'reads', 'after-policy')?.r2
    const rebuilt = r.get(size, 'reads', 'rebuilt')
    const pairs: Pair[] = [
      {
        label: 'First load, upload to readable',
        v3: load.build.seconds + load.verify.seconds + load.commit.seconds,
        f: f.loadSeconds,
        show: secs,
        word: 'faster',
      },
    ]
    if (daily) {
      pairs.push(
        {
          label: 'A day’s commit, server time',
          v3: daily.serverSeconds.p50,
          f: mid(f.dailySeconds),
          show: secs,
          fText: `${f.dailySeconds[0]} and ${f.dailySeconds[1]} s`,
          word: 'faster',
        },
        {
          label: 'A day’s commit, storage requests',
          v3: daily.serverRequests.p50,
          f: mid(f.dailyRequests),
          show: n0,
          fText: `${n0(f.dailyRequests[0]!)} and ${n0(f.dailyRequests[1]!)}`,
          word: 'fewer',
        },
      )
    }
    if (reads) {
      pairs.push({
        label: 'One record, footers cached',
        v3: reads.pointWarm.ms.p50,
        f: f.warmMs,
        show: (v) => `${n0(v)} ms`,
        word: 'faster',
      })
      if (reads.diffPage500Before) {
        pairs.push({
          label: 'A diff page of 500, with what each record was before',
          v3: reads.diffPage500Before.ms.p50 / 1000,
          f: f.diffSeconds,
          show: secs,
          word: 'faster',
        })
      }
    }
    if (rebuilt?.export) {
      pairs.push({
        label: `Full export <span class="muted">v3 on ${rebuilt.export.parts} processes, F on one</span>`,
        v3: rebuilt.export.seconds,
        f: f.exportSeconds,
        show: secs,
        word: 'faster',
      })
    }
    out += compare(`${size === '12m' ? '12M' : '5M'} records`, pairs)
  }
  const many = r.many()
  if (many && many.collections >= 20_000) {
    const f = F_NUMBERS.many
    out += compare(`${n0(many.collections)} collections`, [
      {
        label: 'Loading them all',
        v3: many.load.seconds,
        f: f.loadSeconds,
        show: secs,
        word: 'faster',
      },
      {
        label: `A burst of ${n0(many.burst.commits)} commits at once`,
        v3: many.burst.seconds,
        f: f.burstSeconds,
        show: secs,
        word: 'faster',
      },
    ])
  }
  if (!out) return ''
  return `<div class="cmp"><div class="legend"><span><i class="sw v3"></i>v3</span><span><i class="sw f"></i>Layout F with deltas</span></div>${out}</div>`
}

/** The few numbers that say how v3 does at Crossref's size. */
/** Millions to one place, whatever the size: 171.8, 7.8. */
const millions = (v: number) => (v / 1e6).toFixed(1)

function tiles(r: Results): string {
  const load = r.get('crossref', 'load')
  if (!load) return ''
  const tile = (label: string, value: string, sub: string) =>
    `<div class="tile"><div class="tile-label">${label}</div><div class="tile-value">${value}</div><div class="tile-sub">${sub}</div></div>`
  const daily = r.like('crossref', 'daily', 'first-')
  const rebuilt = r.get('crossref', 'reads', 'rebuilt')?.r2
  const after = r.get('crossref', 'reads', 'after-policy')?.r2
  const heap = Math.max(0, ...r.all.filter((x) => x.suite !== 'gate').flatMap((x) => peaks(x)))
  const total = load.build.seconds + load.verify.seconds + load.commit.seconds
  // The first load stopped short of the dump's last files; they went on as a second upload.
  const rest = r.get('crossref', 'load', 'rest')
  const records = load.records + (rest?.records ?? 0)
  const stored = load.storedBytes + (rest?.storedBytes ?? 0)
  const lineBytes = load.lineBytes + (rest?.lineBytes ?? 0)
  const out = [
    tile(
      'Records',
      `${millions(records)}M`,
      rest
        ? `all of Crossref: ${millions(load.records)}M in the first load, ${millions(rest.records)}M in a second upload`
        : `real Crossref records, ${num((load.records / F_NUMBERS.crossrefRecords) * 100)}% of the dump`,
    ),
    tile(
      'Stored',
      bytes(stored),
      `${num((stored / lineBytes) * 100)}% of the records’ ${bytes(lineBytes)}`,
    ),
    tile(
      'Upload to readable',
      hm(total),
      `the first ${millions(load.records)}M; layout F on staging: ${F_NUMBERS.crossrefLoad}`,
    ),
  ]
  if (daily) {
    out.push(
      tile(
        'A day’s commit',
        secs(daily.serverSeconds.p50),
        `${n0(daily.changesPerDay.mean)} real changes, ${n0(daily.serverRequests.p50)} requests, ${n0(daily.serverPeakHeapMb)} MB of heap`,
      ),
    )
  }
  if (rebuilt) {
    out.push(
      tile(
        'One record',
        `${num(rebuilt.pointWarm.requests.p50)} requests`,
        `${ms(rebuilt.pointWarm.ms.p50)} once rebuilt, footers cached; ${after ? `${num(after.pointWarm.requests.p50)} requests five days on; ` : ''}${num(rebuilt.pointCold.requests.p50)} cold`,
      ),
    )
  }
  out.push(tile('Most heap, any process', `${n0(heap)} MB`, 'under a 120 MB cap; a Worker has 128'))
  return `<div class="tiles">${out.join('')}</div>`
}

function card(n: number, c: { head: string; body: string; todo: string }, inner: string): string {
  return `<section class="finding"><div class="tag">Finding ${n}</div><h3>${c.head}</h3><p>${c.body}</p>${inner}<p class="do"><b>To do:</b> ${c.todo}</p></section>`
}

function policyCard(r: Results): string {
  const p = r.all.find((x) => x.scenario === 'policy' && x.suite !== 'gate')
  const y = r.all.find((x) => x.scenario === 'policy-year' && x.suite !== 'gate')
  let inner = readsChart(r, { sizes: SIZES.slice(2), only: 'requests' })
  if (p) {
    const rows = [10, 4].flatMap((ratio) => {
      const a = (p.ratios as R[]).find((x) => x.ratio === ratio)
      const b = (y?.ratios as R[] | undefined)?.find((x) => x.ratio === ratio)
      if (!a) return []
      return [
        [
          `${ratio}${ratio === 10 ? ' (in force)' : ''}`,
          `${num(a.meanGroups ?? a.meanRuns)}, at most ${a.maxGroups ?? a.maxRuns}`,
          b ? `${num(b.meanGroups ?? b.meanRuns)}, at most ${b.maxGroups ?? b.maxRuns}` : '',
          bytes(a.rewrittenLineBytesPerDay),
        ],
      ]
    })
    inner += table(
      [
        'Ratio',
        'Files a read checks, by arithmetic (Crossref, 3 years)',
        'Files a read checks, measured (a year at 50,000 records)',
        'Rewritten a day at Crossref’s size',
      ],
      rows,
    )
  }
  return card(1, FINDINGS.cards.policy, inner)
}

function forksCard(r: Results): string {
  const all = r.all
    .filter((q) => q.scenario === 'fork-edit' && q.suite !== 'gate')
    .sort((a, b) => a.records - b.records)
  const withKeep = all.find((x) => (x.targets as R[]).some((t) => t.fadeKeep))
  const big = all[all.length - 1]
  const rows: string[][] = []
  const share = (t: R, k: string) => {
    const track = t[k].track as R[]
    return track[track.length - 1]!
  }
  if (withKeep) {
    const ts = (withKeep.targets as R[]).filter((t) => t.fadeTier && t.fadeKeep)
    const range = (vs: number[]) => {
      const lo = Math.min(...vs)
      const hi = Math.max(...vs)
      return num(lo) === num(hi) ? `${num(lo)}%` : `${num(lo)} to ${num(hi)}%`
    }
    rows.push(
      [
        `Tier rule (in force), ${n0(withKeep.records)} records`,
        `${range(ts.map((t) => share(t, 'fadeTier').sharedShare * 100))} on day ${share(ts[0]!, 'fadeTier').day}`,
        bytes(Math.max(...ts.map((t) => t.fadeTier.rewrittenBytes / t.fadeTier.days))),
      ],
      [
        `Merge everything daily, keep untouched files, ${n0(withKeep.records)} records`,
        `${range(ts.map((t) => share(t, 'fadeKeep').sharedShare * 100))} on day ${share(ts[0]!, 'fadeKeep').day}`,
        `${bytes(Math.max(...ts.map((t) => t.fadeKeep.rewrittenBytes / t.fadeKeep.days)))}, twice the collection`,
      ],
    )
  }
  if (big && big !== withKeep) {
    const ts = (big.targets as R[]).filter((t) => t.fadeTier)
    if (ts.length > 0) {
      rows.push([
        `Tier rule (in force), ${n0(big.records)} records`,
        `${num(share(ts[0]!, 'fadeTier').sharedShare * 100)}% on day ${share(ts[0]!, 'fadeTier').day}`,
        bytes(ts[0]!.fadeTier.rewrittenBytes / ts[0]!.fadeTier.days),
      ])
    }
  }
  let inner = ''
  if (rows.length > 0) {
    inner += table(
      [
        'A fork edited by 1%, then daily changes to it and its parent',
        'Fork still stored once with its parent',
        'Rewritten a day',
      ],
      rows,
    )
  }
  if (big) {
    const t = (big.targets as R[])[0]!
    const narrow = [
      [
        'One record edited, fork merged back together',
        `${n0(t.files - t.fold.kept)} of ${n0(t.files)} files rewritten`,
        bytes(t.folded.extraBytes),
      ],
    ]
    if (t.near) {
      narrow.push([
        '1% of the records edited side by side in key order, merged',
        `${n0(t.files - t.near.kept)} of ${n0(t.files)} files rewritten`,
        bytes(t.near.extraBytes),
      ])
    }
    inner += table(
      [
        `A narrow edit on a fork of ${n0(big.records)} records (${num(t.targetMb)} MB files)`,
        'With untouched files kept',
        'The fork adds',
      ],
      narrow,
    )
  }
  return card(2, FINDINGS.cards.forks, inner)
}

function racingCard(r: Results): string {
  const racing = r.all
    .filter((x) => x.scenario === 'racing' && x.suite !== 'gate')
    .sort((a, b) => a.writers - b.writers)
  const many = r.many()
  const rows = racing.map((x) => [
    `${x.writers} to one collection`,
    `${n0(x.commits)}, one for each number, ${x.lostUploads === 0 ? 'none lost' : `${x.lostUploads} lost`}`,
    num(x.commitsPerSecond),
    x.requestsPerCommit === undefined ? '' : n0(x.requestsPerCommit),
    x.refused === undefined ? '' : n0(x.refused),
  ])
  if (many) {
    rows.push([
      `${n0(many.burst.commits)} to ${n0(many.burst.commits)} collections`,
      `${n0(many.burst.commits)}, ${many.burst.failed} failed`,
      n0(many.burst.commitsPerSecond),
      n0((many.burst.classA + many.burst.classB) / many.burst.commits),
      '0',
    ])
  }
  const inner =
    rows.length > 0
      ? table(
          [
            'Writers at once',
            'Commits',
            'A second',
            'Requests a commit',
            'Refused after 50 lost tries, sent again',
          ],
          rows,
        )
      : ''
  return card(3, FINDINGS.cards.racing, inner)
}

const more = (title: string, hint: string, body: string) =>
  body.trim()
    ? `<details class="more"><summary>${title} <span>${hint}</span></summary>${body}</details>`
    : ''

export function buildReport(results: R[]): string {
  const r = new Results(results)
  const details = DETAILS.map(([s, l]) => suiteDetail(r, s, l)).join('')
  return `<title>Underlay v3 Scale Bench</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>
/* Layout: one plain column, dense tables, charts first in each section; an internal review page. */
:root {
  --bg: #f9f9f7; --surface: #fcfcfb; --fg: #0b0b0b; --fg2: #52514e; --muted: #898781;
  --line: #e1e0d9; --base: #c3c2b7; --accent: #2a78d6; --fbar: #b0aea3;
  --s1: #2a78d6; --s2: #eb6834; --s3: #1baf7a; --s4: #eda100;
  --ok: #006300; --ok-bg: #e4f3e2; --bad: #b02a2a; --bad-bg: #fbe6e4; --wait-bg: #eeede8;
  --sans: system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #0d0d0d; --surface: #1a1a19; --fg: #f0efec; --fg2: #c3c2b7; --muted: #898781;
    --line: #2c2c2a; --base: #383835; --accent: #3987e5; --fbar: #62615a;
    --s1: #3987e5; --s2: #d95926; --s3: #199e70; --s4: #c98500;
    --ok: #0ca30c; --ok-bg: #12290f; --bad: #e66767; --bad-bg: #331615; --wait-bg: #262624;
    color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --bg: #0d0d0d; --surface: #1a1a19; --fg: #f0efec; --fg2: #c3c2b7; --muted: #898781;
  --line: #2c2c2a; --base: #383835; --accent: #3987e5; --fbar: #62615a;
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
.finding td:first-child { min-width: 7em; }
.finding th { white-space: normal; }
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
.lead { font-size: 16px; line-height: 1.45; max-width: 72ch; }
.cmp { display: grid; }
.cmp h3 { margin: 14px 0 2px; }
.cmp .legend { margin: 0; }
.cmp-row { display: grid; grid-template-columns: minmax(150px, 1fr) minmax(0, 2.2fr) 8em; gap: 4px 16px; align-items: center; padding: 7px 0; border-bottom: 1px solid var(--line); }
.cmp-label { font-weight: 600; font-size: 13.5px; }
.cmp-label .muted { font-weight: 400; display: block; font-size: 12.5px; }
.cmp-bars { display: grid; gap: 3px; min-width: 0; }
.cmp-bar { display: grid; grid-template-columns: minmax(0, 1fr) 9.5em; gap: 8px; align-items: center; }
.track { display: block; height: 10px; }
.bar { display: block; height: 10px; min-width: 3px; border-radius: 0 4px 4px 0; }
.bar.v3, .sw.v3 { background: var(--s1); }
.bar.f, .sw.f { background: var(--fbar); }
.cmp-val { font-size: 12.5px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.cmp-val.f { color: var(--fg2); }
.cmp-gain { font-size: 13px; color: var(--fg2); white-space: nowrap; }
.cmp-gain b { color: var(--fg); font-size: 16px; font-variant-numeric: tabular-nums; }
@media (max-width: 620px) {
  .cmp-row { grid-template-columns: minmax(0, 1fr) auto; }
  .cmp-bars { grid-column: 1 / -1; grid-row: 2; }
  .cmp-bar { grid-template-columns: minmax(0, 1fr) 8em; }
}
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
.tile { background: var(--surface); border: 1px solid var(--line); border-radius: 4px; padding: 10px 12px; min-width: 0; }
.tile-label { font-size: 12.5px; color: var(--fg2); }
.tile-value { font-size: 22px; font-weight: 650; line-height: 1.3; font-variant-numeric: tabular-nums; }
.tile-sub { font-size: 12.5px; color: var(--fg2); }
.findings { display: grid; gap: 12px; }
.finding { background: var(--surface); border: 1px solid var(--line); border-radius: 4px; padding: 14px 16px; display: grid; gap: 8px; min-width: 0; }
.finding > * { min-width: 0; }
.finding h3 { margin: 0; font-size: 15px; text-wrap: balance; }
.finding .tag { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
.finding .chart { border: 0; padding: 0; background: none; max-width: 640px; }
.do { border-left: 3px solid var(--accent); padding-left: 10px; }
ol { margin: 0; padding-left: 22px; display: grid; gap: 6px; }
details.more { border-top: 1px solid var(--line); padding: 9px 0; }
details.more:last-of-type { border-bottom: 1px solid var(--line); }
details.more > summary { cursor: pointer; font-weight: 600; font-size: 14px; }
details.more > summary span { font-weight: 400; color: var(--fg2); font-size: 13px; }
details.more[open] > summary { margin-bottom: 10px; }
details.more > * + * { margin-top: 10px; }
#tip { position: fixed; pointer-events: none; background: var(--fg); color: var(--bg); font-size: 12.5px; padding: 3px 8px; border-radius: 3px; z-index: 5; max-width: 280px; }
</style>
<main>
  <div class="meta">kf/underlay · protocol v3 · ${esc(FINDINGS.date)}</div>
  <h1>Underlay v3 Scale Bench</h1>
  <p class="lead">${FINDINGS.bottomLine}</p>

  <h2>v3 beside layout F</h2>
  ${hero(r)}
  <p class="note">The same simulated R2 latency for both. Layout F ran through its HTTP server, queue, and database; v3 is driven as a library, so its times leave out HTTP and queue hops. Each pair of bars has a scale of its own.</p>

  <h2>At Crossref’s size</h2>
  ${tiles(r) || '<p class="muted">The Crossref load has not landed yet.</p>'}

  <h2>What the design claims, and whether it held</h2>
  ${claims(r)}

  <h2>Three findings</h2>
  <div class="findings">
  ${policyCard(r)}
  ${forksCard(r)}
  ${racingCard(r)}
  </div>

  <h2>What to do next</h2>
  ${FINDINGS.next}

  <h2>The rest of the measurements</h2>
  <div>
  ${more('Commits by collection size', 'requests and server time for a day’s commit', `<div class="charts">${commitChart(r)}</div>`)}
  ${more('Reads at every size', 'requests for one record, and files checked', `<div class="charts">${readsChart(r)}</div>${FINDINGS.reads}`)}
  ${more('The rebuild policy, every ratio', 'by arithmetic and over a real year', `${policy(r)}${FINDINGS.policy}`)}
  ${more('The fork test, every target size', '8, 32, and 128 MB files', `<div class="charts">${forkChart(r)}</div>${forkEdit(r)}`)}
  ${more('Many collections', 'loading, a burst, and the sweep', `<div class="charts">${manyChart(r)}</div>${manyDetail(r)}`)}
  ${more('Beside layout F, every row', '5M, 12M, and 20,000 collections', `${besideF(r)}<p class="note">${FINDINGS.besideF}</p>`)}
  ${more('The 32 MB cut for uploads', 'added after these measurements; what it costs', FINDINGS.cut)}
  ${more('Against R2’s documented limits', 'and what R2 does not spell out', FINDINGS.r2)}
  ${more('Not built, and what to change first', '', FINDINGS.open)}
  ${more('Each size in detail', 'loads, daily commits, reads, exports', details)}
  ${more('What was measured, where, and how', 'machines, commits, commands', `<p class="note">${FINDINGS.status}</p>${suitesTable(r)}<p class="note">${FINDINGS.method}</p>`)}
  </div>
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
