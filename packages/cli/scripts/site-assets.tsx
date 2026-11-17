/**
 * What underlay.org/cli shows of the CLI, made from the CLI itself at every web build
 * (packages/web/scripts/cli-assets.ts), so the page never shows an older CLI than it serves:
 *
 *   screenshot-collection.svg, screenshot-run.svg, screenshot-push.svg
 *       the terminal UI, rendered by Ink into a fake terminal over a small made-up workspace
 *       (a campus library and a field station; no real organizations), at a fixed clock
 *   cli-reference.json
 *       every command, its arguments, description and options, from src/program.ts
 *
 *   tsx scripts/site-assets.tsx <dir for the SVGs> <path of the reference JSON>
 */
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { v3 as V3 } from '@underlay/protocol'

// Colours on, before Ink and chalk load; and a clock that starts at a fixed moment, so the
// screenshots say "2h ago" whenever they are made.
process.env.FORCE_COLOR = '3'
process.env.TZ = 'America/New_York'
const RealDate = Date
const T0 = RealDate.now()
const NOW = RealDate.parse('2026-11-16T15:20:00Z')
class FixedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(NOW + (RealDate.now() - T0))
    else super(...(args as [string]))
  }
  static override now() {
    return NOW + (RealDate.now() - T0)
  }
}
globalThis.Date = FixedDate as DateConstructor

const [svgDir, referencePath] = process.argv.slice(2)
if (!svgDir || !referencePath) throw new Error('usage: site-assets.tsx <svg dir> <reference json>')

const { v3 } = await import('@underlay/protocol')
const { render } = await import('ink')
const { newCollection } = await import('../src/core/collections.js')
const { TomlFile } = await import('../src/core/config.js')
const { openColl, openCtx } = await import('../src/core/context.js')
const { fileKeys } = await import('../src/core/keys.js')
const { readRun, runScript } = await import('../src/core/runs.js')
const { findScript } = await import('../src/core/scripts.js')
const { saveVersion } = await import('../src/core/versions.js')
const { Workspace } = await import('../src/core/workspace.js')
const { program } = await import('../src/program.js')
const { App } = await import('../src/tui/App.js')
const { C } = await import('../src/tui/lines.js')
const { frameToSvg } = await import('./ansi-svg.js')

// --- The command reference ---

const GROUPS: [string, string[]][] = [
  ['Set up', ['init', 'config', 'login', 'logout', 'remotes']],
  ['Collections', ['ls', 'add', 'new', 'keep', 'forget', 'status']],
  ['Scripts and runs', ['run', 'runs', 'pause', 'resume', 'cancel']],
  ['Versions', ['log', 'diff', 'export', 'save', 'undo', 'squash', 'reword']],
  ['Files and imports', ['add-file', 'import', 'read', 'eject']],
  ['Pull and push', ['pull', 'push']],
]
const commands = program.commands.filter((c) => !(c as unknown as { _hidden: boolean })._hidden)
const describe = (c: (typeof commands)[number], prefix = '') => ({
  name: prefix + c.name(),
  // Commander puts [options] in every usage; only commands with options show it here.
  usage:
    `underlay ${prefix}${c.name()} ${c.options.length ? c.usage() : c.usage().replace(/\[options\]\s*/, '')}`.trim(),
  description: c.description(),
  options: c.options
    .filter((o) => !o.hidden)
    .map((o) => ({ flags: o.flags, description: o.description })),
})
const reference = {
  version: program.version(),
  groups: GROUPS.map(([title, names]) => ({
    title,
    commands: names.flatMap((n) => {
      const c = commands.find((x) => x.name() === n)
      if (!c) return []
      // A command with subcommands is listed by them (config set, config rule add).
      return c.commands.length
        ? [
            ...c.commands.flatMap((s) =>
              s.commands.length
                ? s.commands.map((t) => describe(t, `${c.name()} ${s.name()} `))
                : [describe(s, `${c.name()} `)],
            ),
          ]
        : [describe(c)]
    }),
  })),
}
const listed = new Set(GROUPS.flatMap(([, n]) => n))
const missing = commands.map((c) => c.name()).filter((n) => !listed.has(n) && n !== 'help')
if (missing.length)
  throw new Error(`site-assets.tsx: put these commands in a group: ${missing.join(', ')}`)
mkdirSync(dirname(referencePath), { recursive: true })
writeFileSync(referencePath, JSON.stringify(reference, null, 1) + '\n')

// --- A made-up workspace ---

const home = mkdtempSync(join(tmpdir(), 'ul-site-'))
try {
  process.env.HOME = home
  const configDir = join(home, '.config', 'underlay')
  const keys = fileKeys(configDir)
  keys.set('underlay.org', 'demo-key')
  const ok = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  const coll = (
    slug: string,
    name: string,
    pub: boolean,
    records: number,
    bytes: number,
    v: string,
  ) => ({
    id: slug,
    slug,
    name,
    public: pub,
    description: null,
    latestVersion: v,
    recordCount: records,
    totalBytes: bytes,
    lastPushAt: null,
  })
  // underlay.org as the screenshots' remote, answering only what the UI asks.
  const remote = async (url: string) => {
    const u = new URL(url)
    if (u.pathname === '/api/accounts/me')
      return ok({
        id: 'u',
        name: 'Sam Rivera',
        email: 'sam@example.org',
        orgs: [
          { organizationId: 'o1', role: 'owner', slug: 'campus-library', name: 'Campus Library' },
          { organizationId: 'o2', role: 'member', slug: 'field-station', name: 'Field Station' },
        ],
      })
    if (u.pathname === '/api/accounts/campus-library/collections')
      return ok([
        coll('theses', 'Theses and dissertations', true, 1840, 3_900_000, 'v1.1.0'),
        coll('departments', 'Departments', true, 48, 41_000, 'v1.1.0'),
        coll('staff-roster', 'Staff roster', false, 212, 160_000, 'v1.0.0'),
        coll('grants', 'Grants', true, 930, 1_200_000, 'v2.3.0'),
        coll('events', 'Events', true, 412, 380_000, 'v1.8.0'),
      ])
    if (u.pathname === '/api/accounts/field-station/collections')
      return ok([
        coll('observations', 'Bird observations', true, 268_311, 96_000_000, 'v4.2.0'),
        coll('sites', 'Survey sites', true, 63, 52_000, 'v1.0.0'),
      ])
    const heads: Record<string, number> = {
      departments: 2,
      theses: 2,
      'staff-roster': 1,
      observations: 1,
    }
    const m = /\/api\/collections\/[^/]+\/([^/]+)\/commits$/.exec(u.pathname)
    if (m)
      return ok({
        collection: { id: m[1], authority: 'underlay.org' },
        head: heads[m[1]!] ?? 0,
        commits: [],
        more: false,
      })
    return new Response('{"error":"Not found"}', { status: 404 })
  }
  const env = {
    home,
    configDir,
    dataDir: join(home, '.local', 'share', 'underlay'),
    fetch: remote,
    keys,
    now: () => new Date(),
  }
  const ws = Workspace.init(join(home, 'Underlay'))
  const conf = TomlFile.read(join(ws.root, 'underlay.toml'))
  conf.data.remotes = { 'localhost:3000': { url: 'http://localhost:3000' } }
  conf.write()
  const ctx = openCtx(env, () => {}, ws.root)

  const Thesis = {
    type: 'object',
    properties: {
      title: { type: 'string' },
      author: { type: 'string' },
      department: { type: 'string' },
      year: { type: 'integer' },
    },
    required: ['title', 'author', 'year'],
  }
  const Person = {
    type: 'object',
    properties: { name: { type: 'string' }, orcid: { type: 'string' } },
    required: ['name'],
  }
  const Department = {
    type: 'object',
    properties: { name: { type: 'string' }, school: { type: 'string' } },
    required: ['name'],
  }
  const Observation = {
    type: 'object',
    properties: {
      species: { type: 'string' },
      site: { type: 'string' },
      count: { type: 'integer' },
    },
  }

  const DEPTS = [
    'Biology',
    'Chemistry',
    'Economics',
    'History',
    'Linguistics',
    'Physics',
    'Sociology',
  ]
  const WORDS = [
    'Coastal',
    'Migration',
    'Archives',
    'Signals',
    'Networks',
    'Memory',
    'Soil',
    'Light',
    'Language',
    'Markets',
    'Cities',
    'Rivers',
  ]
  let seed = 7
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!
  const theses = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `t${String(i + 1).padStart(5, '0')}`,
      type: 'Thesis',
      data: {
        title: `${pick(WORDS)} and ${pick(WORDS).toLowerCase()}`,
        author: `Author ${i + 1}`,
        department: pick(DEPTS),
        year: 2010 + (i % 16),
      },
    }))
  const rowsOf = (records: { id: string; type: string; data: unknown }[]) =>
    records.map((r) => v3.rowFromRecord(r.id, r.type, r.data))

  /** A collection with versions saved at given times, the first `pushed` of them on underlay.org. */
  async function make(
    key: string,
    o: {
      access?: 'public' | 'private'
      title: string
      schemas: Record<string, unknown>
      versions: [string, string, V3.LineRow[]][]
      pushed: number
      keep?: 'all' | 'none'
      readme: string
    },
  ) {
    const meta = newCollection(ctx, key, { access: o.access ?? 'public', title: o.title })
    ws.writeSchemas(meta, o.schemas)
    const c = openColl(ctx, meta)
    const saved: V3.StoredCommit[] = []
    for (const [at, message, rows] of o.versions) {
      const r = await saveVersion(c, {
        rows,
        mode: 'set',
        schemas: o.schemas,
        message,
        now: new Date(at),
      })
      if (r.version) saved.push(r.version)
    }
    const last = saved[o.pushed - 1]
    if (last) {
      const state = c.store.state(meta.id)
      state.remote = { number: last.commit.number, id: last.id, semver: last.commit.semver }
      c.store.setState(meta.id, state)
      ws.writeCollection({
        ...meta,
        isNew: false,
        keep: o.keep ?? 'all',
        pushed: last.commit.createdAt,
        pulled: '2026-11-16T09:12:00.000Z',
      })
    }
    writeFileSync(join(ws.collectionDir(meta), 'README.md'), `# ${o.title}\n\n${o.readme}\n`)
    if (o.keep === 'none')
      for (const s of saved)
        for (const f of v3.commitFiles(s.commit)) await c.store.fs.delete(v3.recordKey(f.id))
    return meta
  }

  const t = theses(1840)
  await make('underlay.org/campus-library/theses', {
    title: 'Theses and dissertations',
    readme:
      'Theses and dissertations deposited with the library since 2010, with their authors and departments.',
    schemas: { Thesis, Person },
    versions: [
      ['2026-09-02T14:00:00Z', 'First load from the repository', rowsOf(t.slice(0, 1700))],
      ['2026-10-14T14:00:00Z', 'monthly', rowsOf(t.slice(0, 1786))],
    ],
    pushed: 2,
  })
  await make('underlay.org/campus-library/departments', {
    title: 'Departments',
    readme: 'The departments theses are filed under.',
    schemas: { Department },
    versions: [
      [
        '2026-08-20T10:00:00Z',
        'Departments from the catalog',
        rowsOf(
          DEPTS.map((d, i) => ({
            id: `d${i + 1}`,
            type: 'Department',
            data: { name: d, school: i < 4 ? 'Sciences' : 'Humanities' },
          })),
        ),
      ],
    ],
    pushed: 1,
  })
  await make('underlay.org/campus-library/staff-roster', {
    access: 'private',
    title: 'Staff roster',
    readme: 'Library staff, from the HR export.',
    schemas: { Person },
    versions: [
      [
        '2026-11-02T16:00:00Z',
        'staff-roster',
        rowsOf(
          Array.from({ length: 212 }, (_, i) => ({
            id: `p${i + 1}`,
            type: 'Person',
            data: { name: `Staff ${i + 1}` },
          })),
        ),
      ],
    ],
    pushed: 1,
  })
  await make('underlay.org/field-station/observations', {
    title: 'Bird observations',
    readme: 'Counts from the station’s survey sites.',
    schemas: { Observation },
    versions: [
      [
        '2026-10-30T08:00:00Z',
        'nightly',
        rowsOf(
          Array.from({ length: 300 }, (_, i) => ({
            id: `o${i + 1}`,
            type: 'Observation',
            data: {
              species: pick(['Heron', 'Plover', 'Tern', 'Egret']),
              site: `S${(i % 9) + 1}`,
              count: (i % 7) + 1,
            },
          })),
        ),
      ],
    ],
    pushed: 1,
    keep: 'none',
  })
  newCollection(ctx, 'localhost:3000/sam/scratch', { title: 'Scratch' })

  // Scripts: a monthly runner, an import, and a check.
  mkdirSync(join(ws.root, 'scripts', 'library'), { recursive: true })
  mkdirSync(join(ws.root, 'scripts', 'checks'), { recursive: true })
  mkdirSync(join(ws.root, 'views', 'held-rows'), { recursive: true })
  writeFileSync(
    join(ws.root, 'views', 'held-rows', 'index.html'),
    '<!doctype html><title>Held rows</title>\n',
  )
  writeFileSync(
    join(ws.root, 'records.json'),
    JSON.stringify(
      t
        .map((r, i) => (i === 12 ? { ...r, data: { ...r.data, department: 'Linguistics' } } : r))
        .filter((_, i) => i !== 40),
    ),
  )
  writeFileSync(
    join(ws.root, 'scripts', 'library', 'monthly.mjs'),
    `// underlay: writes underlay.org/campus-library/theses
// underlay: reads underlay.org/campus-library/departments
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
const out = process.env.UNDERLAY_OUT + '/underlay.org/campus-library'
mkdirSync(out, { recursive: true })
const records = JSON.parse(readFileSync('records.json', 'utf8'))
console.log('repository  harvesting since 2026-10-14')
console.log('repository  page 1 … 19')
console.log('repository  ' + records.length.toLocaleString('en-US') + ' theses')
console.log('warn        t00041 withdrawn upstream; left out')
console.log('authors     matched 1,792 of 1,839 to ORCID')
writeFileSync(out + '/theses.ndjson', records.map((r) => JSON.stringify(r)).join('\\n') + '\\n')
console.log('done')
`,
  )
  writeFileSync(
    join(ws.root, 'scripts', 'checks', 'departments.sh'),
    '# underlay: reads underlay.org/campus-library/departments\necho "2 theses name a department that is not in departments"; exit 1\n',
  )
  const imp = TomlFile.read(join(ws.root, 'scripts', 'imports', 'staff-roster.toml'))
  imp.data = {
    importer: 'xlsx',
    takes: '*.xlsx',
    file: 'inputs/staff-roster.xlsx',
    collection: 'underlay.org/campus-library/staff-roster',
    type: 'Person',
    id: 'staff_id',
    missing_id: 'hold',
    mode: 'set',
    columns: { full_name: 'name' },
  }
  imp.write()

  const run = await runScript(ctx, findScript(ws, 'library/monthly'), [])
  if (run.status !== 'ok' || !run.saved.length)
    throw new Error(`site-assets.tsx: the demo run did not save: ${run.error}`)
  // As a real harvest takes: four minutes, finished 41 minutes ago.
  const rec = readRun(ctx, run.id)
  const end = NOW - 41 * 60_000
  writeFileSync(
    join(ws.stateDir, 'runs', `${run.id}.json`),
    JSON.stringify({
      ...rec,
      startedAt: new Date(end - 252_000).toISOString(),
      endedAt: new Date(end).toISOString(),
    }),
  )
  const check = await runScript(ctx, findScript(ws, 'checks/departments.sh'), [])
  const crec = readRun(ctx, check.id)
  writeFileSync(
    join(ws.stateDir, 'runs', `${check.id}.json`),
    JSON.stringify({
      ...crec,
      startedAt: new Date(NOW - 26 * 3600_000).toISOString(),
      endedAt: new Date(NOW - 26 * 3600_000 + 2000).toISOString(),
    }),
  )

  // --- The screenshots ---

  const COLUMNS = 132
  const ROWS = 34
  class Stdout extends EventEmitter {
    columns = COLUMNS
    rows = ROWS
    isTTY = true
    last = ''
    write = (frame: string) => {
      this.last = frame
      return true
    }
  }
  class Stdin extends EventEmitter {
    isTTY = true
    data: string | null = null
    write = (d: string) => {
      this.data = d
      this.emit('readable')
      this.emit('data', d)
    }
    setEncoding() {}
    setRawMode() {}
    resume() {}
    pause() {}
    ref() {}
    unref() {}
    read = () => {
      const d = this.data
      this.data = null
      return d
    }
  }
  const strip = (s: string) =>
    s.replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '')
  async function shoot(name: string, sel: string, wants: string[], keys: string[] = []) {
    const stdout = new Stdout()
    const stdin = new Stdin()
    const app = render(<App ctx={ctx} initial={{ sel }} />, {
      stdout: stdout as never,
      stdin: stdin as never,
      stderr: new Stdout() as never,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    })
    const until = async (texts: string[]) => {
      const t0 = RealDate.now()
      while (!texts.every((x) => strip(stdout.last).includes(x))) {
        if (RealDate.now() - t0 > 15_000)
          throw new Error(
            `site-assets.tsx: ${name} never showed ${texts.join(', ')}:\n${strip(stdout.last)}`,
          )
        await new Promise((r) => setTimeout(r, 50))
      }
    }
    await until(['underlay.org', 'campus-library'])
    for (const k of keys) {
      stdin.write(k)
      await new Promise((r) => setTimeout(r, 200))
    }
    await until(wants)
    // The remotes' counts and behind arrows arrive a moment after.
    await until(['4 / 7'])
    await new Promise((r) => setTimeout(r, 300))
    const frame = stdout.last
    app.unmount()
    writeFileSync(
      join(svgDir!, `screenshot-${name}.svg`),
      frameToSvg(frame, {
        title: 'underlay — ~/Underlay',
        columns: COLUMNS,
        rows: ROWS,
        background: C.bg,
        foreground: C.fg,
      }),
    )
  }
  mkdirSync(svgDir, { recursive: true })
  await shoot('collection', 'c:underlay.org/campus-library/theses', [
    'NOT PUSHED',
    'AUTHORITY',
    'SCRIPTS THAT TOUCH IT',
  ])
  await shoot('run', 's:scripts/library/monthly.mjs', ['SAVED HERE AS NEW VERSIONS', 'THIS RUN'])
  await shoot(
    'push',
    'c:underlay.org/campus-library/theses',
    ['COPIED EXACTLY AS THEY ARE HERE'],
    ['p'],
  )
  console.log(
    `site-assets: 3 screenshots and the command reference (underlay ${reference.version})`,
  )
} finally {
  rmSync(home, { recursive: true, force: true })
}
process.exit(0)
