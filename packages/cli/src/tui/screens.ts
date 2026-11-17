import type { RemoteListing } from '../core/collections.js'
import { KEEP_LABEL, KEEP_MARK } from '../core/collections.js'
import type { Keep } from '../core/config.js'
import { ago, bytes, count, duration, shortId } from '../core/format.js'
import type { ImportOptions, Shape } from '../core/importers.js'
import type { RemoteCollection } from '../core/remote.js'
import type { RunRecord } from '../core/runs.js'
/**
 * The terminal UI's panes, as pure functions of what is loaded: each gives a title, its
 * lines and its keys. Layouts follow the mockup's Terminal page.
 */
import type { FileProgress } from '../core/sync.js'
import type { PushPlan } from '../core/sync.js'
import { beside, birdLines, PECK } from './bird.js'
import type { CollectionDetail, CollectionRow, ScriptRow, Snapshot } from './data.js'
import {
  blank,
  C,
  head,
  type Key,
  L,
  type Line,
  markColor,
  P,
  type Pane,
  R,
  rule,
  S,
  wrap,
} from './lines.js'

/** A time in this machine's zone: `14:39`, or `11-16 14:39`. */
export function localTime(iso: string, withDate = false): string {
  const d = new Date(iso)
  const p2 = (n: number) => String(n).padStart(2, '0')
  const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`
  return withDate ? `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${hm}` : hm
}

/** A path with the home folder as `~`. */
const home = (p: string) => {
  const h = process.env.HOME ?? ''
  return h && p.startsWith(h + '/') ? '~' + p.slice(h.length) : p
}

// --- The sidebar ---

export type Item =
  | { kind: 'remote'; name: string }
  | { kind: 'coll'; key: string }
  | { kind: 'script'; path: string }
  | { kind: 'view'; path: string }

export const itemId = (i: Item) =>
  i.kind === 'remote'
    ? `r:${i.name}`
    : i.kind === 'coll'
      ? `c:${i.key}`
      : i.kind === 'script'
        ? `s:${i.path}`
        : `v:${i.path}`

export interface Sidebar {
  remotes: Line[]
  cols: Line[]
  scripts: Line[]
  items: Item[]
  user: string | null
}

const keepColor = (k: Keep) => (k === 'none' ? C.mu : k === 'all' ? C.fg : C.bl)

export function scriptMark(s: ScriptRow): string {
  const st = s.last?.status
  return st === 'ok' ? '✓' : st === 'running' ? '▶' : st === 'paused' ? '‖' : st ? '✗' : ' '
}

export function sidebar(
  snap: Snapshot,
  remotes: Record<string, RemoteListing | { error: string }>,
  behind: Record<string, number>,
  sel: string,
  width: number,
): Sidebar {
  const items: Item[] = []
  const inner = width - 4
  let user: string | null = null
  const remoteLines = snap.remotes.map((r) => {
    const item: Item = { kind: 'remote', name: r.name }
    items.push(item)
    const on = sel === itemId(item)
    const l = remotes[r.name]
    const listing = l && 'orgs' in l ? l : null
    if (listing?.user) user ??= listing.user.name.split(' ')[0]!.toLowerCase()
    const here = snap.collections.filter((c) => c.meta.authority === r.name).length
    const total = listing ? listing.orgs.reduce((n, o) => n + o.collections.length, 0) : null
    const note = !r.signedIn
      ? 'signed out'
      : l && 'error' in l
        ? 'unreachable'
        : total === null
          ? `${here} / …`
          : `${here} / ${total}`
    const mark = r.signedIn ? '●' : '○'
    const nameW = Math.max(8, inner - 3 - 11)
    return L(
      [
        S(on ? '▌' : ' ', C.bl),
        S(mark + ' ', markColor(mark)),
        S(P(r.name.slice(0, nameW), nameW), on ? C.wh : r.signedIn ? C.fg : C.mu, on),
        S(R(note, 11), C.mu),
      ],
      on ? C.sel : undefined,
    )
  })

  const cols: Line[] = []
  const byAuthority = new Map<string, CollectionRow[]>()
  for (const c of snap.collections) {
    const list = byAuthority.get(c.meta.authority) ?? []
    list.push(c)
    byAuthority.set(c.meta.authority, list)
  }
  const nameW = Math.max(8, inner - 4 - 7)
  for (const [authority, list] of byAuthority) {
    cols.push(L([S(authority, C.fg, true)]))
    let org = ''
    for (const c of list) {
      if (c.meta.org !== org) cols.push(L([S('  ' + (org = c.meta.org), C.mu)]))
      const item: Item = { kind: 'coll', key: c.key }
      items.push(item)
      const on = sel === itemId(item)
      const sync = c.meta.isNew
        ? S(' new', C.or)
        : c.running
          ? S(' ▶', C.bl)
          : c.status.unpushed > 0
            ? S(` ↑${c.status.unpushed}`, C.bl)
            : behind[c.key]
              ? S(` ↓${behind[c.key]}`, C.gr)
              : S('')
      const extra = c.running && c.status.unpushed > 0 ? S(` ↑${c.status.unpushed}`, C.bl) : S('')
      cols.push(
        L(
          [
            S(on ? '▌   ' : '    ', C.bl),
            S(P(c.meta.name.slice(0, nameW), nameW), on ? C.wh : C.fg, on),
            S(KEEP_MARK[c.meta.keep], keepColor(c.meta.keep)),
            sync,
            extra,
          ],
          on ? C.sel : undefined,
        ),
      )
    }
  }
  if (snap.collections.length === 0)
    cols.push(L([S('Nothing here yet: + adds from a remote', C.mu)]))

  const scripts: Line[] = []
  const sw = Math.max(8, inner - 4 - 6)
  // Under each script folder's name when there is more than one.
  const folders = new Set(snap.scripts.map((s) => s.source))
  let folder = ''
  for (const s of snap.scripts) {
    if (folders.size > 1 && s.source !== folder) scripts.push(L([S((folder = s.source), C.mu)]))
    const view = s.kind === 'view'
    const item: Item = view ? { kind: 'view', path: s.path } : { kind: 'script', path: s.path }
    items.push(item)
    const on = sel === itemId(item)
    const mark = view ? '◇' : scriptMark(s)
    const when = view
      ? 'view'
      : s.last
        ? s.last.status === 'running'
          ? duration(s.last.startedAt, null)
          : ago(s.last.endedAt ?? s.last.startedAt)
        : s.kind === 'check' || s.kind === 'import'
          ? s.kind
          : ''
    const label = folders.size > 1 ? s.name.slice(s.source.length + 1) : s.name
    scripts.push(
      L(
        [
          S(on ? '▌ ' : '  ', C.bl),
          S(mark + ' ', view ? C.bl : markColor(mark)),
          S(P(label.slice(0, sw), sw), on ? C.wh : C.fg, on),
          S(R(when.replace(' ago', '').replace('just now', 'now'), 6), mark === '▶' ? C.bl : C.mu),
        ],
        on ? C.sel : undefined,
      ),
    )
  }
  if (scripts.length === 0) scripts.push(L([S('No scripts yet: put one in scripts/', C.mu)]))
  return { remotes: remoteLines, cols, scripts, items, user }
}

// --- A collection ---

export const TABS = ['Overview', 'Records', 'Schemas', 'Files', 'Changes', 'Versions'] as const
export type Tab = (typeof TABS)[number]

function tabLine(tab: Tab): Line {
  const segs = [S(' ')]
  for (const t of TABS) segs.push(t === tab ? S(` ${t} `, C.bg, true, C.fg) : S(` ${t} `, C.mu))
  return L(segs)
}

export interface CollectionExtra {
  records?: { type: string; id: string; data: string }[]
  diff?: {
    from: number
    to: number
    rows: { kind: string; type: string; id: string }[]
    byType: Record<string, { added: number; changed: number; removed: number }>
  }
  scripts: ScriptRow[]
  storeRoot: string
  url: string
  behind: number
}

const stat = (st?: { added: number; changed: number; removed: number }) =>
  st
    ? [
        S(R(`+${count(st.added)}`, 7), C.gr),
        S(R(`~${count(st.changed)}`, 7), st.changed ? C.or : C.mu),
        S(R(`−${count(st.removed)}`, 6), st.removed ? C.rd : C.mu),
      ]
    : [S(R('', 20))]

export function collectionPane(
  row: CollectionRow,
  d: CollectionDetail | null,
  tab: Tab,
  x: CollectionExtra,
  width: number,
): Pane {
  const m = row.meta
  const lines: Line[] = [tabLine(tab), blank()]
  const pane: Pane = {
    title: `${m.org}/${m.name}`,
    meta: `on ${m.authority}${m.title ? ` · ${m.title}` : ''} · ${m.access}${m.isNew ? ' · new' : ''}`,
    lines,
    keys: [
      { k: 'p', l: 'push…' },
      { k: 'u', l: 'undo last change' },
      { k: 'k', l: 'keep…' },
      { k: 'l', l: 'pull' },
      { k: 'R', l: 'run a script' },
      { k: '←→', l: 'tabs' },
      { k: 'a', l: 'prompt for an agent' },
      { k: 'o', l: `open on ${m.authority}` },
      { k: '+', l: 'add from a remote' },
    ],
  }
  if (!d) {
    lines.push(L([S('Loading…', C.mu)]))
    return pane
  }
  const touching = x.scripts.filter(
    (s) =>
      s.writes.some((w) => w === row.key || row.key.endsWith('/' + w)) ||
      s.reads.some((w) => w === row.key || row.key.endsWith('/' + w)),
  )
  const unpushed = d.versions.filter((v) => !v.pushed)
  if (tab === 'Overview') {
    if (d.readme) lines.push(...wrap(d.readme, width - 2), blank())
    lines.push(head('HERE'))
    if (d.versions.length === 0)
      lines.push(
        L([
          S('  No versions yet. A run, an import, or ', C.mu),
          S('underlay save', C.fg),
          S(' makes the first.', C.mu),
        ]),
      )
    else if (d.filesHere < d.filesTotal)
      lines.push(
        L([
          S(`  ${KEEP_MARK[m.keep]} `, keepColor(m.keep)),
          S(`${KEEP_LABEL[m.keep]} · ${d.filesHere} of ${d.filesTotal} record files here`),
          S(' · records are fetched when opened', C.mu),
        ]),
      )
    else {
      lines.push(
        L([
          S(`  ${KEEP_MARK[m.keep]} `, keepColor(m.keep)),
          S(
            `${KEEP_LABEL[m.keep]} · ${count(d.records)} records · ${bytes(d.bytes)}${
              d.assets?.length
                ? ` · ${count(d.assets.length)} files, ${count(d.assets.filter((f) => f.here).length)} here`
                : ''
            }`,
          ),
        ]),
      )
      if (d.counts.length)
        lines.push(
          L([
            S(
              '    ' +
                d.counts
                  .slice(0, 6)
                  .map(([t, n]) => `${t} ${count(n)}`)
                  .join('   '),
              C.mu,
            ),
          ]),
        )
    }
    lines.push(blank())
    if (unpushed.length) {
      lines.push(head('NOT PUSHED'))
      for (const v of unpushed.slice(0, 6))
        lines.push(
          L([
            S(`  ${P(v.semver, 8)}`, C.bl),
            S(`${localTime(v.createdAt, true)}  `, C.mu),
            S(P((v.message ?? '').slice(0, 30), 31)),
            ...stat(v.stats),
          ]),
        )
      lines.push(blank())
    }
    lines.push(head('AUTHORITY', 'numbers its versions'))
    const pushed = d.versions.find((v) => v.pushed)
    lines.push(
      L([
        S('  ' + P(m.authority, 24)),
        S(m.isNew ? 'not there yet' : (pushed?.semver ?? 'no versions'), C.fg),
        S(
          m.isNew
            ? ' · its first push creates it'
            : ` · ${m.pushed ? `pushed ${m.pushed.slice(0, 10)}` : 'pulled'} · ${m.access}${x.behind ? ` · ${x.behind} newer there: l pulls` : ' · nothing newer'}`,
          C.mu,
        ),
      ]),
    )
    for (const copy of m.copies)
      lines.push(L([S('  ' + P(copy, 24), C.mu), S('a copy, same ids', C.mu)]))
    lines.push(blank())
    if (touching.length) {
      lines.push(head('SCRIPTS THAT TOUCH IT'))
      for (const s of touching) {
        const writes = s.writes.some((w) => w === row.key || row.key.endsWith('/' + w))
        const last = s.last
          ? `; ${s.last.status === 'ok' ? 'ran' : s.last.status} ${ago(s.last.endedAt ?? s.last.startedAt)}`
          : ''
        lines.push(
          L([S('  ' + P(s.path, 34)), S(`${writes ? 'writes it' : 'reads it'}${last}`, C.mu)]),
        )
      }
      lines.push(blank())
    }
    lines.push(head('IN YOUR HOME'))
    lines.push(L([S(`  collections/${row.key}/`, C.mu)]))
    lines.push(
      L([
        S(
          '    collection.toml  README.md  ' +
            Object.keys(d.schemas)
              .map((t) => `schemas/${t}.json`)
              .join('  '),
        ),
      ]),
    )
    lines.push(L([S(`    its records and files are in ${x.storeRoot} (the store)`, C.mu)]))
  } else if (tab === 'Records') {
    if (!x.records) lines.push(L([S('Loading…', C.mu)]))
    else if (x.records.length === 0) lines.push(L([S('No records', C.mu)]))
    for (const r of x.records ?? [])
      lines.push(
        L([
          S(P(r.type, 12), C.mu),
          S(P(r.id.slice(0, 24), 25)),
          S(r.data.slice(0, Math.max(10, width - 40)), C.mu),
        ]),
      )
    pane.keys = [{ k: '↑↓', l: 'scroll' }, { k: 'n', l: 'next page' }, ...pane.keys.slice(5)]
  } else if (tab === 'Schemas') {
    for (const [t, s] of Object.entries(d.schemas)) {
      const props = (s as { properties?: Record<string, { type?: unknown }> }).properties ?? {}
      const req = new Set((s as { required?: string[] }).required ?? [])
      lines.push(L([S(t, C.fg, true), S(`  schemas/${t}.json`, C.mu)]))
      for (const [k, v] of Object.entries(props))
        lines.push(
          L([
            S('  ' + P(k + (req.has(k) ? '*' : ''), 24)),
            S(JSON.stringify(v.type ?? v).slice(0, 60), C.mu),
          ]),
        )
      lines.push(blank())
    }
    if (!Object.keys(d.schemas).length)
      lines.push(L([S(`No schemas: put them in collections/${row.key}/schemas/<Type>.json`, C.mu)]))
  } else if (tab === 'Files') {
    // Assets: the files the records point to, such as PDFs and images, as on the web.
    const a = d.assets
    if (a === null)
      lines.push(
        L([S('Its records are not here, so neither is its list of files. k keeps more.', C.mu)]),
      )
    else if (a.length === 0)
      lines.push(
        L([
          S('No files. ', C.fg),
          S(`underlay asset add ${m.org}/${m.name} <file> adds one.`, C.mu),
        ]),
      )
    else {
      const here = a.filter((f) => f.here)
      lines.push(
        L([
          S(`${count(a.length)} file${a.length === 1 ? '' : 's'}`, C.fg, true),
          S(
            ` · ${bytes(a.reduce((n, f) => n + f.size, 0))} · ${here.length === a.length ? 'all here' : `${count(here.length)} here`}`,
            C.mu,
          ),
          ...(m.keep !== 'all' && here.length < a.length
            ? [S('  k → everything fetches them', C.mu)]
            : []),
        ]),
        blank(),
      )
      for (const f of a.slice(0, 200))
        lines.push(
          L([
            S(f.here ? '  ✓ ' : '  · ', f.here ? C.gr : C.mu),
            S(P(f.hash.slice(0, 12), 14), C.mu),
            S(P(f.mediaType ?? 'unknown type', 24)),
            S(R(bytes(f.size), 9), C.mu),
          ]),
        )
    }
    lines.push(
      blank(),
      L([
        S(`Records: ${d.filesHere} of ${d.filesTotal} record files here, in ${x.storeRoot}`, C.dim),
      ]),
    )
  } else if (tab === 'Changes') {
    if (!x.diff) lines.push(L([S('Loading…', C.mu)]))
    else {
      lines.push(
        L([
          S(
            `${x.diff.from === x.diff.to ? 'No versions' : `From ${x.diff.from} to ${x.diff.to}`}`,
            C.mu,
          ),
          S(unpushed.length ? '  what a push would send' : '  the newest version', C.mu),
        ]),
      )
      for (const [t, n] of Object.entries(x.diff.byType))
        lines.push(
          L([
            S('  ' + P(t, 20)),
            S(R(`+${count(n.added)}`, 8), C.gr),
            S(R(`~${count(n.changed)}`, 8), C.or),
            S(R(`−${count(n.removed)}`, 8), C.rd),
          ]),
        )
      lines.push(blank())
      for (const r of x.diff.rows)
        lines.push(
          L([
            S(`  ${r.kind} `, r.kind === '+' ? C.gr : r.kind === '-' ? C.rd : C.or),
            S(P(r.id.slice(0, 30), 32)),
            S(r.type, C.mu),
          ]),
        )
    }
  } else {
    // Wide enough for "✓ <server>" and a gap before the date.
    const whereW = Math.max(14, m.authority.length + 4)
    lines.push(
      L([
        S(
          '  ' +
            P('VERSION', 9) +
            R('#', 5) +
            '  ' +
            P('ID', 8) +
            P('WHERE', whereW) +
            P('WHEN', 12) +
            'MESSAGE',
          C.mu,
        ),
      ]),
    )
    for (const v of d.versions)
      lines.push(
        L([
          S('  ' + P(v.semver, 9), v.pushed ? C.fg : C.bl),
          S(R(v.number, 5), C.mu),
          S('  ' + P(shortId(v.id), 8), C.mu),
          S(P(v.pushed ? `✓ ${m.authority}` : 'not pushed', whereW), v.pushed ? C.gr : C.bl),
          S(P(ago(v.createdAt), 12), C.mu),
          S((v.message ?? '').slice(0, 40)),
        ]),
      )
    pane.keys = [
      { k: 'u', l: 'undo newest' },
      { k: 'S', l: 'squash not pushed' },
      { k: 'e', l: 'reword newest' },
      ...pane.keys.slice(5),
    ]
  }
  return pane
}

// --- Runs ---

export function runPane(
  r: RunRecord,
  log: string[],
  scroll: number,
  height: number,
  width: number,
): Pane {
  const live = r.status === 'running' || r.status === 'paused'
  if (!live) return donePane(r, log, width)
  const room = Math.max(3, height - 3)
  const end = Math.max(0, log.length - scroll)
  const shown = log.slice(Math.max(0, end - room), end)
  const lines = shown.map((t) =>
    L([S(t.slice(0, width), /\bwarn|error|fail/i.test(t) ? C.or : C.fg)]),
  )
  return {
    title: r.script,
    meta: `${r.status} ${duration(r.startedAt, null)}${r.args.length ? ' · ' + r.args.join(' ') : ''}`,
    color: C.bl,
    border: C.bl,
    lines,
    footer: [
      rule(width),
      L([
        S(r.status === 'paused' ? '‖ ' : '▶ ', C.bl),
        S(
          `${r.status} ${duration(r.startedAt, null)} · pid ${r.scriptPid ?? '?'} · ${count(log.length)} lines of output`,
        ),
        S(' · nothing is saved until it exits', C.mu),
      ]),
    ],
    keys: [
      { k: 'X', l: 'cancel' },
      { k: 'space', l: r.status === 'paused' ? 'resume' : 'pause' },
      { k: 'R', l: 'restart' },
      { k: '↑↓', l: 'scroll' },
      { k: 'a', l: 'prompt for an agent' },
      { k: 'esc', l: 'back, keeps running' },
    ],
  }
}

export function donePane(r: RunRecord, log: string[], width: number): Pane {
  const ok = r.status === 'ok'
  const lines: Line[] = [L([S('… last lines of its output', C.mu)])]
  for (const t of log.slice(-6)) lines.push(L([S(t.slice(0, width), C.mu)]))
  lines.push(rule(width))
  if (ok) {
    lines.push(
      L([S('SAVED HERE AS NEW VERSIONS', C.fg, true), S('  nothing has left this machine', C.mu)]),
    )
    lines.push(
      L([S('  ' + P('COLLECTION', 32) + R('ADDED', 7) + R('CHANGED', 9) + R('REMOVED', 9), C.mu)]),
    )
    for (const s of r.saved)
      lines.push(
        L([
          S('  ' + P(`${s.collection.split('/').slice(1).join('/')} ${s.semver}`, 32)),
          S(R(`+${count(s.added)}`, 7), C.gr),
          S(R(`~${count(s.changed)}`, 9), s.changed ? C.or : C.mu),
          S(R(`−${count(s.removed)}`, 9), s.removed ? C.rd : C.mu),
        ]),
      )
    for (const u of r.unchanged)
      lines.push(
        L([S('  ' + P(u.split('/').slice(1).join('/'), 32)), S('no changes, nothing saved', C.mu)]),
      )
    if (!r.saved.length && !r.unchanged.length)
      lines.push(L([S('  It wrote no collections: a check, and it passed.', C.mu)]))
  } else
    lines.push(
      L([
        S(`${r.status === 'cancelled' ? 'CANCELLED' : 'FAILED'}`, C.rd, true),
        S(`  ${r.error ?? ''}  nothing was saved`, C.mu),
      ]),
    )
  lines.push(blank(), head('THIS RUN'))
  lines.push(
    L([
      S('  script  ', C.mu),
      S(r.script),
      S(
        r.git
          ? ` at git ${r.git.commit.slice(0, 7)}${r.git.dirty ? ', with uncommitted edits' : ', no uncommitted edits'}`
          : '',
        C.mu,
      ),
    ]),
  )
  for (const i of r.inputs)
    lines.push(
      L([
        S('  reads   ', C.mu),
        S(i.path),
        S(`  ${bytes(i.bytes)} · ${i.sha256.slice(0, 12)}`, C.mu),
      ]),
    )
  lines.push(
    L([
      S('  output  ', C.mu),
      S(home(r.log.replace(/log\.txt$/, ''))),
      S(`  ${count(log.length)} lines`, C.mu),
    ]),
  )
  if (ok && r.saved.length)
    lines.push(
      blank(),
      L([
        S(
          'Until you push, these can be undone or squashed here. Push copies them up as they are.',
          C.mu,
        ),
      ]),
    )
  return {
    title: r.script,
    meta: `${ok ? 'finished' : r.status} ${r.endedAt ? localTime(r.endedAt) : ''} · ${duration(r.startedAt, r.endedAt)} · exit ${r.exitCode ?? '–'}`,
    color: ok ? C.gr : C.rd,
    lines,
    keys: [
      { k: 'p', l: 'push…' },
      { k: 'u', l: 'undo this run' },
      { k: 'enter', l: 'full output' },
      { k: 'R', l: 'run again' },
      { k: 'a', l: 'prompt for an agent' },
      { k: 'esc', l: 'back' },
    ],
  }
}

export function scriptPane(s: ScriptRow, width: number): Pane {
  const lines: Line[] = [
    L([S('  kind    ', C.mu), S(s.kind)]),
    L([S('  file    ', C.mu), S(home(s.path), C.mu)]),
    L([S('  writes  ', C.mu), S(s.writes.join(', ') || 'nothing (a check)')]),
    ...(s.reads.length ? [L([S('  reads   ', C.mu), S(s.reads.join(', '))])] : []),
    ...(s.takes ? [L([S('  takes   ', C.mu), S(s.takes)])] : []),
    L([
      S('  mode    ', C.mu),
      S(
        s.mode === 'set'
          ? 'the whole collection: what it leaves out is removed'
          : 'additions and changes only',
      ),
    ]),
    L([
      S('  runs    ', C.mu),
      S(
        s.command ? s.command.map((p) => p.split('/').pop()).join(' ') : 'the built-in importer',
        C.mu,
      ),
    ]),
    blank(),
    ...wrap(
      'Never run here. r runs it: its output streams here, and when it exits each collection it wrote is compared with its newest version and saved as a new one if anything changed.',
      width - 2,
      C.mu,
    ),
  ]
  return {
    title: s.name,
    meta: s.kind,
    lines,
    keys: [
      { k: 'R', l: 'run' },
      { k: 'h', l: 'all runs' },
      { k: 'esc', l: 'back' },
    ],
  }
}

export function runsPane(runs: RunRecord[], cursor: number): Pane {
  const lines: Line[] = [
    L([S('  ' + P('', 2) + P('RUN', 24) + P('SCRIPT', 32) + R('TOOK', 9) + '   SAVED', C.mu)]),
  ]
  runs.slice(0, 200).forEach((r, i) => {
    const on = i === cursor
    const m =
      r.status === 'ok' ? '✓' : r.status === 'running' ? '▶' : r.status === 'paused' ? '‖' : '✗'
    lines.push(
      L(
        [
          S(on ? '› ' : '  ', C.gr, true),
          S(m + ' ', markColor(m)),
          S(P(r.id, 24), on ? C.wh : C.fg),
          S(P(r.script.replace(/^scripts\//, ''), 32)),
          S(R(duration(r.startedAt, r.endedAt), 9), C.mu),
          S(
            '   ' +
              (r.saved.map((s) => `${s.collection.split('/').pop()} ${s.semver}`).join(', ') ||
                (r.status === 'ok' ? 'no changes' : (r.error ?? ''))),
            C.mu,
          ),
        ],
        on ? C.sel : undefined,
      ),
    )
  })
  if (!runs.length) lines.push(L([S('  No runs yet', C.mu)]))
  return {
    title: 'Runs',
    meta: 'every script, newest first',
    lines,
    keys: [
      { k: '↑↓', l: 'move' },
      { k: 'enter', l: 'open' },
      { k: 'esc', l: 'back' },
    ],
  }
}

// --- Push ---

export interface PushView {
  plans: PushPlan[]
  included: Set<string>
  behind: Record<string, number>
  cursor: number
  typed: string
  progress: string[]
  busy: boolean
  /** The file going up now, while busy. */
  peck?: FileProgress | null
  /** The pecking frame, stepped while busy. */
  frame?: number
  /** Whether to draw the woodpecker beside the bar (the mascot setting). */
  bird?: boolean
}

/** While a push runs: the woodpecker pecking beside what is going up and a bar of how much. */
function peckLines(v: PushView): Line[] {
  const p = v.peck
  if (!v.busy || !p) return []
  const w = 24
  const filled = p.total ? Math.round((p.done / p.total) * w) : w
  const text: Line[] = [
    blank(),
    L([S(`Pushing ${p.key} to ${p.authority}`, C.wh, true)]),
    L([S(p.semver ? `version ${p.semver}` : '', C.mu)]),
    blank(),
    L([
      S('█'.repeat(filled), C.gr),
      S('░'.repeat(w - filled), C.dim),
      S(
        p.done < p.total
          ? `  ${p.done} of ${p.total} files`
          : `  ${p.total} files sent; committing`,
        C.mu,
      ),
    ]),
  ]
  const lines = v.bird ? beside(birdLines(PECK[(v.frame ?? 0) % PECK.length]!), text) : text
  return [...lines, blank()]
}

export function pushPane(v: PushView, user: string | null, width: number): Pane {
  const inc = v.plans.filter((p) => v.included.has(p.coll.key))
  const authorities = [...new Set(v.plans.map((p) => p.coll.meta.authority))]
  const versions = inc.reduce((n, p) => n + p.versions.length, 0)
  const loud = inc.some((p) => p.access === 'public' || p.removed >= 1000)
  const lines: Line[] = peckLines(v)
  if (!v.plans.length) {
    if (v.progress.length)
      lines.push(
        ...v.progress.map((t) =>
          L([S(t, /✓/.test(t) ? C.gr : /fail|first|!/i.test(t) ? C.or : C.fg)]),
        ),
      )
    else lines.push(L([S('Nothing to push: every version here is on its authority.', C.mu)]))
    return { title: 'Push', lines, keys: [{ k: 'esc', l: 'back' }], color: C.or, border: C.or }
  }
  lines.push(
    L([
      S(
        `This changes ${inc.length} collection${inc.length === 1 ? '' : 's'} on ${authorities.join(', ')}. People who can read them will see it.`,
        C.fg,
        true,
      ),
    ]),
    blank(),
  )
  lines.push(
    L([
      S(
        '      ' +
          P('COLLECTION', 24) +
          P('ACCESS', 9) +
          P('THERE', 10) +
          P('AFTER', 9) +
          R('ADDED', 7) +
          R('CHG', 6) +
          R('DEL', 6),
        C.mu,
      ),
    ]),
  )
  v.plans.forEach((p, i) => {
    const on = i === v.cursor
    const there = behindOf(v, p)
    const st = p.versions.reduce(
      (a, x) => ({
        added: a.added + (x.stats?.added ?? 0),
        changed: a.changed + (x.stats?.changed ?? 0),
      }),
      { added: 0, changed: 0 },
    )
    const name = `${p.coll.meta.org}/${p.coll.meta.name}`
    if (there) {
      lines.push(
        L(
          [
            S(on ? '› ' : '  ', C.gr, true),
            S('[ ] ', C.mu),
            S(P(name, 24), C.mu),
            S(
              `${p.coll.meta.authority} has ${there} newer you have not pulled: pull first (l)`,
              C.mu,
            ),
          ],
          on ? C.sel : undefined,
        ),
      )
      return
    }
    const x = v.included.has(p.coll.key)
    lines.push(
      L(
        [
          S(on ? '› ' : '  ', C.gr, true),
          S(x ? '[x] ' : '[ ] ', x ? C.fg : C.mu),
          S(P(name, 24), on ? C.wh : C.fg, on),
          S(P(p.access, 9), p.access === 'public' ? C.or : C.mu),
          S(P(p.from?.semver ?? (p.isNew ? 'new' : '–'), 7), C.mu),
          S(' → ', C.mu),
          S(P(p.versions.at(-1)!.semver, 9), C.fg, true),
          S(R(`+${count(st.added)}`, 7), C.gr),
          S(R(`~${count(st.changed)}`, 6), C.or),
          S(R(`−${count(p.removed)}`, 6), p.removed ? C.rd : C.mu),
        ],
        on ? C.sel : undefined,
      ),
    )
  })
  lines.push(blank(), head('COPIED EXACTLY AS THEY ARE HERE: SAME NUMBERS, SAME CONTENTS'))
  for (const p of inc)
    for (const x of p.versions)
      lines.push(
        L([
          S('  ' + P(`${p.coll.meta.name} ${x.semver}`, 30)),
          S(P(shortId(x.id), 8), C.mu),
          S((x.message ?? '').slice(0, 40), C.mu),
        ]),
      )
  lines.push(blank(), head('CHECKS'))
  const stale = v.plans.filter((p) => behindOf(v, p))
  lines.push(
    stale.length
      ? L([
          S('  ! ', C.or),
          S(`${stale.length} behind their authority: left out until pulled`, C.or),
        ])
      : L([S('  ✓ ', C.gr), S('nothing newer on the authority since your last pull')]),
  )
  lines.push(L([S('  ✓ ', C.gr), S('nothing is renumbered or combined on the way up')]))
  for (const p of inc)
    if (p.removed)
      lines.push(
        L([
          S('  ! ', C.or),
          S(
            `${p.coll.meta.name} removes ${count(p.removed)} record${p.removed === 1 ? '' : 's'}`,
            C.or,
          ),
        ]),
      )
  const pub = inc.filter((p) => p.access === 'public')
  if (pub.length)
    lines.push(
      L([
        S('  ! ', C.or),
        S(
          `${pub.map((p) => p.coll.meta.name).join(' and ')} ${pub.length === 1 ? 'is' : 'are'} public: anyone can read ${pub.length === 1 ? 'it' : 'them'} once pushed`,
          C.or,
        ),
      ]),
    )
  for (const p of inc)
    if (p.isNew)
      lines.push(
        L([
          S('  + ', C.bl),
          S(`${p.coll.meta.name} is created on ${p.coll.meta.authority} by this push`),
        ]),
      )
  if (v.progress.length)
    lines.push(
      blank(),
      ...v.progress
        .slice(-8)
        .map((t) => L([S(t, /✓/.test(t) ? C.gr : /fail|first|!/i.test(t) ? C.or : C.fg)])),
    )
  const footer: Line[] = [rule(width)]
  if (v.busy) footer.push(L([S('Pushing…', C.bl)]))
  else if (!versions)
    footer.push(
      L([
        S(
          v.plans.some((p) => behindOf(v, p))
            ? 'Behind its authority: l pulls first, then this screen shows your versions on top'
            : 'Nothing included: space includes a collection',
          C.mu,
        ),
      ]),
    )
  else if (loud)
    footer.push(
      L([
        S('Type ', C.fg),
        S('push', C.fg, true),
        S(` to copy ${versions} version${versions === 1 ? '' : 's'}:  `),
        S(v.typed, C.wh, true),
        S(' ', C.fg, false, C.fg),
      ]),
    )
  else footer.push(L([S(`y copies ${versions} version${versions === 1 ? '' : 's'}; esc cancels`)]))
  return {
    title: `Push to ${authorities.join(', ')}`,
    meta: user ? `as ${user}` : '',
    color: C.or,
    border: C.or,
    lines,
    footer,
    keys: [
      { k: 'space', l: 'include / leave out' },
      { k: 'd', l: 'changes' },
      { k: 'e', l: 'edit a message' },
      { k: 'S', l: 'squash here first' },
      { k: 'esc', l: 'cancel' },
    ],
  }
}

const behindOf = (v: PushView, p: PushPlan) => v.behind[p.coll.key] ?? 0

// --- Adding from a remote ---

export interface PickView {
  remote: string
  tab: 'orgs' | 'public'
  listing: RemoteListing | { error: string } | null
  public: (RemoteCollection & { here: unknown })[] | null
  open: Set<string>
  selected: Map<string, Keep>
  cursor: number
  search: string
  searching: boolean
  status: string
}

export type PickColl = RemoteCollection & { here: { keep: Keep } | null }

export interface PickRow {
  kind: 'org' | 'coll'
  org: string
  coll?: PickColl
}

export function pickRows(v: PickView): PickRow[] {
  const rows: PickRow[] = []
  if (v.tab === 'public') {
    for (const c of v.public ?? [])
      rows.push({ kind: 'coll', org: c.ownerSlug ?? '', coll: c as PickColl })
    return rows
  }
  if (!v.listing || !('orgs' in v.listing)) return rows
  for (const o of v.listing.orgs) {
    rows.push({ kind: 'org', org: o.slug })
    if (v.open.has(o.slug))
      for (const c of o.collections) rows.push({ kind: 'coll', org: o.slug, coll: c as PickColl })
  }
  return rows
}

export function pickPane(v: PickView, width: number): Pane {
  const l = v.listing && 'orgs' in v.listing ? v.listing : null
  const total = l ? l.orgs.reduce((n, o) => n + o.collections.length, 0) : 0
  const lines: Line[] = [
    L([
      v.tab === 'orgs'
        ? S(` Your orgs ${total} `, C.bg, true, C.fg)
        : S(` Your orgs ${total} `, C.mu),
      S('  '),
      v.tab === 'public'
        ? S(` Public ${v.public?.length ?? ''} `, C.bg, true, C.fg)
        : S(' Public ', C.mu),
      S('   / ', C.fg, true),
      S(
        v.searching || v.search ? v.search + (v.searching ? '▏' : '') : 'search',
        v.searching ? C.wh : C.mu,
      ),
    ]),
    blank(),
  ]
  if (v.listing && 'error' in v.listing) lines.push(L([S(v.listing.error, C.rd)]))
  else if (!l?.signedIn && v.tab === 'orgs')
    lines.push(
      L([
        S(`Not signed in to ${v.remote}: run underlay login ${v.remote}, or tab to Public`, C.mu),
      ]),
    )
  else if (!v.listing && v.tab === 'orgs') lines.push(L([S('Loading…', C.mu)]))
  lines.push(
    L([
      S(
        '      ' +
          P('COLLECTION', 26) +
          P('ACCESS', 9) +
          P('HERE OR ADD', 19) +
          R('RECORDS', 12) +
          R('SIZE', 9),
        C.mu,
      ),
    ]),
  )
  const rows = pickRows(v)
  rows.forEach((r, i) => {
    const on = i === v.cursor
    if (r.kind === 'org') {
      const o = l!.orgs.find((x) => x.slug === r.org)!
      const here = o.collections.filter((c) => c.here).length
      lines.push(
        L(
          [
            S(on ? '› ' : '  ', C.gr, true),
            S(v.open.has(r.org) ? '▾ ' : '▸ ', C.mu),
            S(P(r.org, 30), on ? C.wh : C.fg, true),
            S(`${o.collections.length} · ${here ? `${here} here` : 'none here'}`, C.mu),
          ],
          on ? C.sel : undefined,
        ),
      )
      return
    }
    const c = r.coll!
    const key = `${r.org}/${c.slug}`
    const sel = v.selected.get(key)
    const here = c.here
      ? `${KEEP_MARK[c.here.keep]} ${KEEP_LABEL[c.here.keep]}`
      : sel
        ? `add ${KEEP_LABEL[sel]}`
        : ''
    const name = v.tab === 'public' ? key : c.slug
    lines.push(
      L(
        [
          S(on ? '› ' : '  ', C.gr, true),
          S(c.here ? '    ' : sel ? '[x] ' : '[ ] ', sel ? C.fg : C.mu),
          S(P(name.length > 25 ? name.slice(0, 24) + '…' : name, 26), on ? C.wh : C.fg, on),
          S(P(c.public ? 'public' : 'private', 9), C.mu),
          // What is here, or what will be added, before the counts: it is what this screen is for.
          S(P(here, 19), c.here ? C.fg : sel ? C.bl : C.mu),
          S(R(count(c.recordCount), 12), C.mu),
          S(R(bytes(c.totalBytes), 9), C.mu),
        ],
        on ? C.sel : undefined,
      ),
    )
  })
  const chosen = [...v.selected.entries()]
  const footer: Line[] = [rule(width)]
  if (v.status) footer.push(...wrap(v.status, width - 2, C.bl))
  else if (chosen.length) {
    const at = (level: Keep) => chosen.filter(([, k]) => k === level).map(([n]) => n.split('/')[1])
    const all = at('all')
    const data = at('records')
    const meta = at('none')
    footer.push(
      L([
        S(`Adding ${chosen.length}: `, C.fg, true),
        S(
          [
            all.length ? `${all.join(' and ')} with everything` : '',
            data.length ? `${data.join(' and ')} with data, no assets` : '',
            meta.length ? `${meta.join(' and ')} metadata only` : '',
          ]
            .filter(Boolean)
            .join(', '),
        ),
      ]),
    )
    footer.push(
      L([
        S(
          'Metadata only is schemas, README, and history; records are fetched when you open them.',
          C.mu,
        ),
      ]),
    )
  } else footer.push(L([S('space selects; enter adds what is selected', C.mu)]))
  return {
    title: v.remote,
    meta: `add collections to this machine${l?.user ? ` · signed in as ${l.user.name}` : ''}`,
    color: C.bl,
    border: C.bl,
    lines,
    footer,
    keys: [
      { k: 'space', l: 'select' },
      { k: 'k', l: 'all data / metadata only' },
      { k: '←→', l: 'fold org' },
      { k: 'tab', l: 'your orgs / public' },
      { k: '/', l: 'search' },
      { k: 'enter', l: chosen.length ? `add ${chosen.length}` : 'add' },
      { k: 'esc', l: 'back' },
    ],
  }
}

// --- Settings ---

export interface SettingRow {
  group: string
  key: string
  label: string
  value: string
  from: string
  about: string
  /** The longer text for the About panel; about when absent. */
  help?: string
  /** Values enter steps through, for a setting with a few. */
  choices?: string[]
  kind: 'setting' | 'rule' | 'remote' | 'source' | 'info'
}

// --- A dropped file ---

export interface FileView {
  shape: Shape
  options: ImportOptions | null
  field: number
  status: string
}

export const FILE_FIELDS = ['sheet', 'collection', 'type', 'id', 'missing_id', 'mode'] as const

export function filePane(v: FileView, width: number): Pane {
  const s = v.shape
  const t = s.tables.find((x) => x.name === v.options?.sheet) ?? s.tables[0]
  const best = s.matches[0]
  const lines: Line[] = [
    L([
      S('  sheets ', C.mu),
      S(t?.name ?? '', C.fg, true),
      S(` ${count(t?.rows ?? 0)} rows × ${t?.columns.length ?? 0} columns`, C.mu),
      S(
        s.tables.length > 1
          ? ' · ' +
              s.tables
                .filter((x) => x !== t)
                .map((x) => x.name)
                .join(' · ')
          : '',
        C.mu,
      ),
      ...(best
        ? [
            S('   matches ', C.mu),
            S(best.collection.split('/').slice(1).join('/'), C.bl, true),
            S(` (${count(best.hits)} of ${count(best.of)} ids)`, C.mu),
          ]
        : [S('   no collection here shares its ids', C.mu)]),
    ]),
    blank(),
    head('SCRIPTS THAT TAKE IT'),
    L(
      [
        S('› ', C.gr, true),
        S('● ', C.bl),
        S(P(`${s.format}  built in`, 40), C.wh, true),
        S('a sheet into one type; options below', C.mu),
      ],
      C.sel,
    ),
    ...s.scripts.map((x) =>
      L([
        S('  ○ ', C.mu),
        S(P(x.name, 40)),
        S(x.kind === 'import' ? 'an import you saved' : 'your script', C.mu),
      ]),
    ),
    ...(s.scripts.length
      ? []
      : [
          L([
            S('  ○ ', C.mu),
            S(P('none of yours yet', 40)),
            S('saving this one makes it the first', C.mu),
          ]),
        ]),
    blank(),
    head('OPTIONS', 'filled in from the file and the collection; tab moves, enter changes'),
  ]
  const o = v.options
  if (!o)
    lines.push(
      L([S('    No collection here to import into: add one, or `underlay new` one, first', C.mu)]),
    )
  else {
    const vals: Record<string, [string, string]> = {
      sheet: [
        o.sheet ?? t?.name ?? '',
        s.tables.length > 1 ? `${s.tables.length} in the file` : '',
      ],
      collection: [o.collection, best?.collection === o.collection ? 'matched by id' : ''],
      type: [o.type, ''],
      id: [o.id, t ? `${t.idColumns.includes(o.id) ? 'unique' : 'not unique!'}` : ''],
      missing_id: [o.missing_id === 'hold' ? 'hold the rows' : 'skip the rows', 'rows with no id'],
      mode: [
        o.mode === 'set' ? `the whole set of ${o.type}` : 'additions and changes only',
        o.mode === 'set' ? 'records it lacks are removed' : '',
      ],
    }
    FILE_FIELDS.forEach((f, i) => {
      const on = i === v.field
      lines.push(
        L(
          [
            S(on ? '  › ' : '    ', C.gr, true),
            S(P(f === 'missing_id' ? 'no id' : f, 13), C.mu),
            S(P(vals[f]![0], 36), on ? C.wh : C.fg, on),
            S(vals[f]![1], C.mu),
          ],
          on ? C.sel : undefined,
        ),
      )
    })
    lines.push(L([S('    ' + P('columns', 13), C.mu)]))
    for (const [col, field] of Object.entries(o.columns).slice(0, 10))
      lines.push(
        L([
          S('      ' + P(col.slice(0, 16), 17), C.mu),
          S('→ ', C.mu),
          S(P(field || 'left out', 16), field ? C.fg : C.or),
          S(
            !field && /mail|phone|address|birth/i.test(col) ? 'personal data, off by default' : '',
            C.mu,
          ),
        ]),
      )
    lines.push(
      blank(),
      L([
        S('    ' + P('save as', 13), C.mu),
        S(
          P(
            `scripts/imports/${s.path
              .split('/')
              .pop()!
              .replace(/\.[^.]+$/, '')}.toml`,
            36,
          ),
        ),
        S('runs the built-in with these options', C.mu),
      ]),
    )
  }
  const footer: Line[] = [rule(width)]
  if (v.status) footer.push(...wrap(v.status, width - 2, C.bl))
  else
    footer.push(
      L([
        S('Messier than this? ', C.mu),
        S('C', C.fg, true),
        S(' hands the file to an agent, ', C.mu),
        S('c', C.fg, true),
        S(' copies the prompt; ', C.mu),
        S('x', C.fg, true),
        S(' ejects an editable script.', C.mu),
      ]),
    )
  return {
    title: s.path,
    meta: `${s.format} · ${s.tables.length} sheet${s.tables.length === 1 ? '' : 's'}`,
    color: C.bl,
    border: C.bl,
    lines,
    footer,
    keys: [
      { k: 'enter', l: 'run it' },
      { k: 'tab', l: 'next option' },
      { k: '←→', l: 'change' },
      { k: 'x', l: 'eject to a .ts to edit' },
      { k: 'A', l: 'hand to an agent' },
      { k: 'esc', l: 'back' },
    ],
  }
}

export function viewPane(s: ScriptRow, served: { url: string } | null, width: number): Pane {
  const page = s.view === 'page'
  return {
    title: s.name,
    meta: page ? 'a page' : served ? `serving at ${served.url}` : 'a view that serves',
    lines: [
      ...wrap(
        page
          ? 'A page: v opens it in the browser as it is. It saves choices to files in your home’s inputs/ that a script reads on its next run.'
          : 'A script that serves a page: v starts it with PORT set to a free port, waits until it listens, and opens it. It stops when you press s or close the app.',
        width - 2,
        C.mu,
      ),
      blank(),
      L([S('  ' + home(s.path))]),
      ...(s.reads.length ? [blank(), L([S('  reads   ', C.mu), S(s.reads.join(', '))])] : []),
      ...(served ? [blank(), L([S('  ' + served.url, C.gr)])] : []),
    ],
    keys: [
      { k: 'v', l: served ? 'open again' : 'open in a browser' },
      ...(served ? [{ k: 'X', l: 'stop' }] : []),
      { k: 'esc', l: 'back' },
    ],
  }
}

export function messagePane(
  title: string,
  text: string,
  width: number,
  keys: Key[] = [{ k: 'esc', l: 'back' }],
): Pane {
  return { title, lines: wrap(text, width - 2), keys }
}
