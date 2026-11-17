/**
 * Scripts (local-tool.md "Scripts and runs"): files in home's `scripts/` or a script folder
 * (sources.ts) that declare themselves in a header comment,
 *
 *   // underlay: writes underlay.org/mitp/mit-ai, mitp/units
 *   // underlay: reads mitp/rosters
 *   // underlay: takes *.xlsx
 *   // underlay: mode additions          (default: set, the whole collection)
 *   // underlay: check                   (writes nothing; fails on a problem)
 *   // underlay: serves                  (a view: serves a page on $PORT)
 *   <!-- underlay: view -->              (in an .html file: a page)
 *
 * with `#` or `--` for other languages, several on one line with commas
 * (`// underlay: check, reads mitp/rosters`), or in a `.toml` beside it with the same name
 * (`monthly.ts` → `monthly.toml`): `writes`, `reads`, `takes`, `mode`, `types`, `where`,
 * `check`, `serves`, `run` (a command, `{script}` for its path). A `.toml` with `importer` is
 * a built-in import. Files that declare nothing (helpers, data) aren't scripts.
 *
 * What a script is follows from what it declares, not where it sits. Each is named
 * `<folder>/<path without extension>`: `home/try-orcid`, `scrapers/mitp/monthly`.
 */
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
} from 'node:fs'
import { extname, join, relative, resolve, sep } from 'node:path'

import { TomlFile } from './config.js'
import { CliError } from './env.js'
import { keyOf, parseRef } from './home.js'
import { type Source, SOURCE_FILE } from './sources.js'

export interface ScriptInfo {
  /** `<folder>/<path without extension>`: `scrapers/mitp/monthly`. */
  name: string
  /** The script folder it is in. */
  source: string
  /** The file, absolute. */
  path: string
  /** Where it runs: its script folder. */
  cwd: string
  kind: 'script' | 'import' | 'check' | 'view'
  /** A view: a page opened as it is, or a script that serves one on $PORT. */
  view: 'page' | 'server' | null
  /** Collections, as authority/org/name. */
  writes: string[]
  reads: string[]
  takes: string | null
  mode: 'set' | 'additions'
  types?: string[]
  where?: Record<string, unknown>
  /** How to run it; null for an import (run in-process) or a page. */
  command: string[] | null
  /** Secrets its folder says its scripts need. */
  need: string[]
}

/** What finding scripts needs: the script folders, and the remote for org/name. */
export interface ScriptScope {
  sources: Source[]
  settings: { defaultRemote: string }
}

const RUNNERS: Record<string, string[]> = {
  '.ts': [process.execPath, '--experimental-strip-types', '--no-warnings'],
  '.mts': [process.execPath, '--experimental-strip-types', '--no-warnings'],
  '.js': [process.execPath],
  '.mjs': [process.execPath],
  '.py': ['python3'],
  '.sh': ['sh'],
}

/** Files that may be scripts; others (and files without a header) are left alone. */
const CANDIDATES = new Set([...Object.keys(RUNNERS), '.html', '.toml'])
const SKIP_DIRS = new Set(['node_modules'])

const isExecutable = (p: string) => {
  try {
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

const list = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.map(String)
    : typeof v === 'string'
      ? v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : []

/** The first few KB of a file: where a header is. */
function head(path: string): string {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(8192)
    const n = readSync(fd, buf, 0, buf.length, 0)
    return buf.subarray(0, n).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

const HEADER = /^\s*(?:\/\/|#|--|<!--)\s*underlay:\s*(.*?)\s*(?:-->)?\s*$/
const LISTS = new Set(['writes', 'reads', 'types'])
const FLAGS = new Set(['check', 'view', 'serves'])
const WORDS = new Set([...LISTS, ...FLAGS, 'takes', 'mode'])

/** A script's header lines, as a declaration. Null when it has none. */
export function readHeader(text: string): Record<string, unknown> | null {
  const decl: Record<string, unknown> = {}
  let found = false
  for (const line of text.split('\n').slice(0, 40)) {
    const m = HEADER.exec(line)
    if (!m) continue
    found = true
    let at: string | null = null
    for (const part of m[1]!.split(',')) {
      const p = part.trim()
      if (!p) continue
      const [word, ...rest] = p.split(/\s+/)
      const value = rest.join(' ')
      if (WORDS.has(word!)) {
        at = word!
        if (FLAGS.has(at)) decl[at] = true
        else if (LISTS.has(at)) decl[at] = [...list(decl[at]), ...(value ? [value] : [])]
        else decl[at] = value
      } else if (at && LISTS.has(at)) decl[at] = [...list(decl[at]), p]
      else if (at === 'takes') decl.takes = `${decl.takes}, ${p}`
    }
  }
  return found ? decl : null
}

function nameOf(source: Source, abs: string) {
  return `${source.name}/${relative(source.namesFrom, abs).replace(/\.[^./]+$/, '')}`
}

/** One file's declaration, or null when it declares nothing. */
export function readScript(scope: ScriptScope, source: Source, abs: string): ScriptInfo | null {
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new CliError(`No script ${abs}`)
  const ext = extname(abs)
  const authority = source.authority ?? scope.settings.defaultRemote
  const refs = (v: unknown) => list(v).map((w) => keyOf(parseRef(w, authority)))
  const base = {
    name: nameOf(source, abs),
    source: source.name,
    path: abs,
    cwd: source.root,
    need: source.need,
  }
  if (ext === '.toml') {
    if (abs === join(source.root, SOURCE_FILE)) return null
    const t = TomlFile.read(abs).data
    if (typeof t.importer !== 'string') return null
    return {
      ...base,
      kind: 'import',
      view: null,
      writes: typeof t.collection === 'string' ? refs(t.collection) : [],
      reads: [],
      takes: typeof t.takes === 'string' ? t.takes : null,
      mode: t.mode === 'additions' ? 'additions' : 'set',
      ...(Array.isArray(t.types)
        ? { types: t.types.map(String) }
        : typeof t.type === 'string'
          ? { types: [t.type] }
          : {}),
      ...(t.where && typeof t.where === 'object' ? { where: t.where } : {}),
      command: null,
    }
  }
  const declared = readHeader(head(abs))
  const sidecar = ext ? abs.slice(0, -ext.length) + '.toml' : null
  const side = sidecar && existsSync(sidecar) ? TomlFile.read(sidecar).data : null
  if (!declared && !side) return null
  const decl: Record<string, unknown> = { ...declared, ...side }
  const writes = refs(decl.writes)
  const page = ext === '.html'
  const server = !page && decl.serves === true
  let command: string[] | null = null
  if (!page) {
    const run = typeof decl.run === 'string' ? decl.run : null
    const runner = source.runners[ext]
    command = run
      ? ['sh', '-c', run.replaceAll('{script}', JSON.stringify(abs)) + ' "$@"', 'underlay-script']
      : runner
        ? ['sh', '-c', `${runner} "$@"`, 'underlay-script', abs]
        : isExecutable(abs)
          ? [abs]
          : RUNNERS[ext]
            ? [...RUNNERS[ext]!, abs]
            : null
    if (!command)
      throw new CliError(
        `${abs}: not executable, and no runner for "${ext}" (say run = "..." in a .toml beside it)`,
      )
  }
  return {
    ...base,
    kind: page || server ? 'view' : writes.length > 0 ? 'script' : 'check',
    view: page ? 'page' : server ? 'server' : null,
    writes,
    reads: refs(decl.reads),
    takes: typeof decl.takes === 'string' && decl.takes ? decl.takes : null,
    mode: decl.mode === 'additions' ? 'additions' : 'set',
    ...(decl.types ? { types: list(decl.types) } : {}),
    ...(decl.where && typeof decl.where === 'object'
      ? { where: decl.where as Record<string, unknown> }
      : {}),
    command,
  }
}

/** Every script in every script folder, sorted by name. Sidecar `.toml` files are not scripts. */
export function listScripts(scope: ScriptScope): ScriptInfo[] {
  const out: ScriptInfo[] = []
  const seen = new Set<string>()
  for (const source of scope.sources) {
    if (!source.exists) continue
    const walk = (dir: string, depth: number) => {
      if (!existsSync(dir) || depth > 8) return
      const names = readdirSync(dir)
        .filter((n) => !n.startsWith('.'))
        .sort()
      for (const n of names) {
        const abs = join(dir, n)
        let st
        try {
          st = statSync(abs)
        } catch {
          continue
        }
        if (st.isDirectory()) {
          if (!SKIP_DIRS.has(n)) walk(abs, depth + 1)
          continue
        }
        const ext = extname(n)
        if (ext ? !CANDIDATES.has(ext) || n.endsWith('.d.ts') : !isExecutable(abs)) continue
        const base = n.slice(0, n.length - ext.length)
        if (
          ext === '.toml' &&
          names.some((o) => o !== n && o.startsWith(base + '.') && !o.endsWith('.toml'))
        )
          continue
        if (seen.has(abs)) continue
        seen.add(abs)
        try {
          const s = readScript(scope, source, abs)
          if (s) out.push(s)
        } catch {
          // Unreadable, or no way to run it: left out of the list.
        }
      }
    }
    for (const d of source.dirs) walk(d, 0)
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

const inside = (dir: string, path: string) => path === dir || path.startsWith(dir + sep)

/** The script folder a file is in: the most specific one. */
export function sourceOfFile(scope: ScriptScope, abs: string): Source | null {
  let best: Source | null = null
  for (const s of scope.sources)
    if (s.dirs.some((d) => inside(d, abs)) && (!best || s.root.length > best.root.length)) best = s
  return best
}

/**
 * A script by name (`scrapers/mitp/monthly`, `mitp/monthly`, `monthly` when that is unique)
 * or by its file's path.
 */
export function findScript(scope: ScriptScope, text: string): ScriptInfo {
  const all = listScripts(scope)
  const exact = all.find((s) => s.name === text)
  if (exact) return exact
  // A path: from here, from home (`scripts/x.sh`), or within a script folder (`mitp/x.ts`).
  const paths = [
    resolve(text),
    ...scope.sources.flatMap((s) => [
      resolve(s.root, text),
      ...s.dirs.map((d) => resolve(d, text)),
    ]),
  ]
  for (const abs of new Set(paths)) {
    if (!existsSync(abs) || !statSync(abs).isFile()) continue
    const source = sourceOfFile(scope, abs)
    if (!source)
      throw new CliError(
        `${text} isn’t in your home’s scripts/ or a script folder (underlay sources add <folder>)`,
      )
    const s = readScript(scope, source, abs)
    if (!s)
      throw new CliError(
        `${text} declares nothing: add a header such as // underlay: writes org/name (or check)`,
      )
    return s
  }
  const short = (s: ScriptInfo) => s.name.slice(s.source.length + 1)
  const hits = all.filter(
    (s) => short(s) === text || s.name.endsWith('/' + text) || short(s).endsWith('/' + text),
  )
  const unique = [...new Map(hits.map((s) => [s.path, s])).values()]
  if (unique.length === 1) return unique[0]!
  if (unique.length > 1)
    throw new CliError(`${text} could be ${unique.map((s) => s.name).join(' or ')}: say which`)
  throw new CliError(`No script ${text} (scripts: ${all.map((s) => s.name).join(', ') || 'none'})`)
}

/** Does a file name match a `takes` pattern (`*.xlsx`, `roster-*.csv`)? */
export function takesFile(pattern: string | null, file: string): boolean {
  if (!pattern) return false
  const base = file.split('/').pop()!
  const re = new RegExp(
    '^(?:' +
      pattern
        .split(',')
        .map((p) =>
          p
            .trim()
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.'),
        )
        .join('|') +
      ')$',
    'i',
  )
  return re.test(base)
}
