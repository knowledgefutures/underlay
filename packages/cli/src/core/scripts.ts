/**
 * Scripts (local-tool.md "Scripts and runs"): any executable in `scripts/`, or a `.ts`,
 * `.js`, `.mjs`, `.py` or `.sh` file, plus the built-in importers' `.toml` files in
 * `scripts/imports/`. A script declares what it writes, reads and takes in a header comment
 *
 *   // underlay: writes underlay.org/mitp/mit-ai, underlay.org/mitp/units
 *   // underlay: reads underlay.org/mitp/rosters
 *   // underlay: takes *.xlsx
 *   // underlay: mode additions          (default: set, the whole collection)
 *
 * or in a `.toml` beside it with the same name (`monthly.ts` → `monthly.toml`):
 * `writes`, `reads`, `takes`, `mode`, `types`, `where`, `run` (a command, `{script}` for its path).
 * A script that writes nothing is a check.
 */
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'

import { TomlFile } from './config.js'
import { CliError } from './env.js'
import type { Workspace } from './workspace.js'

export interface ScriptInfo {
  /** Relative to the workspace: `scripts/mitp/monthly.ts`. */
  path: string
  name: string
  kind: 'script' | 'import' | 'check'
  writes: string[]
  reads: string[]
  takes: string | null
  mode: 'set' | 'additions'
  types?: string[]
  where?: Record<string, unknown>
  /** How to run it; null for an import (run in-process). */
  command: string[] | null
}

const RUNNERS: Record<string, string[]> = {
  '.ts': [process.execPath, '--experimental-strip-types', '--no-warnings'],
  '.mts': [process.execPath, '--experimental-strip-types', '--no-warnings'],
  '.js': [process.execPath],
  '.mjs': [process.execPath],
  '.py': ['python3'],
  '.sh': ['sh'],
}

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

/** Read one script's declaration. */
export function readScript(ws: Workspace, rel: string): ScriptInfo {
  const abs = join(ws.root, rel)
  if (!existsSync(abs)) throw new CliError(`No script ${rel}`)
  const ext = extname(abs)
  const name = rel.replace(/^scripts\//, '').replace(/\.[^./]+$/, '')
  if (ext === '.toml') {
    const t = TomlFile.read(abs).data
    if (typeof t.importer !== 'string') throw new CliError(`${rel}: an import names its importer`)
    return {
      path: rel,
      name,
      kind: 'import',
      writes: typeof t.collection === 'string' ? [t.collection] : [],
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
  const decl: Record<string, unknown> = {}
  const head = readFileSync(abs, 'utf8').split('\n').slice(0, 40)
  for (const line of head) {
    const m = /^\s*(?:\/\/|#|--)\s*underlay:\s*(writes|reads|takes|mode|types)\s+(.+?)\s*$/.exec(
      line,
    )
    if (!m) continue
    if (m[1] === 'writes' || m[1] === 'reads' || m[1] === 'types')
      decl[m[1]] = [...list(decl[m[1]]), ...list(m[2])]
    else decl[m[1]!] = m[2]
  }
  const sidecar = abs.slice(0, -ext.length || undefined) + '.toml'
  if (ext !== '' && existsSync(sidecar)) Object.assign(decl, TomlFile.read(sidecar).data)
  const writes = list(decl.writes)
  const runner = RUNNERS[ext]
  const run = typeof decl.run === 'string' ? decl.run : null
  const command = run
    ? ['sh', '-c', run.replaceAll('{script}', JSON.stringify(abs)) + ' "$@"', 'underlay-script']
    : isExecutable(abs)
      ? [abs]
      : runner
        ? [...runner, abs]
        : null
  if (!command)
    throw new CliError(
      `${rel}: not executable, and no runner for "${ext}" (say run = "..." in a .toml beside it)`,
    )
  return {
    path: rel,
    name,
    kind: writes.length === 0 ? 'check' : 'script',
    writes,
    reads: list(decl.reads),
    takes: typeof decl.takes === 'string' ? decl.takes : null,
    mode: decl.mode === 'additions' ? 'additions' : 'set',
    ...(decl.types ? { types: list(decl.types) } : {}),
    ...(decl.where && typeof decl.where === 'object'
      ? { where: decl.where as Record<string, unknown> }
      : {}),
    command,
  }
}

/** Every script in `scripts/`, sorted by path. Sidecar `.toml` files are not scripts. */
export function listScripts(ws: Workspace): ScriptInfo[] {
  const out: ScriptInfo[] = []
  const walk = (dir: string) => {
    if (!existsSync(dir)) return
    const names = readdirSync(dir)
      .filter((n) => !n.startsWith('.'))
      .sort()
    for (const n of names) {
      const abs = join(dir, n)
      if (statSync(abs).isDirectory()) {
        walk(abs)
        continue
      }
      const ext = extname(n)
      const base = n.slice(0, n.length - ext.length)
      if (
        ext === '.toml' &&
        names.some((o) => o !== n && o.startsWith(base + '.') && !o.endsWith('.toml'))
      )
        continue
      if (ext === '.toml' && !relative(ws.root, abs).startsWith('scripts/imports/')) continue
      if (ext === '.md' || ext === '.json') continue
      try {
        out.push(readScript(ws, relative(ws.root, abs)))
      } catch {
        // Not a script (a helper module, a data file): left out of the list.
      }
    }
  }
  walk(join(ws.root, 'scripts'))
  return out
}

/** A script by path (relative to the workspace or to `scripts/`) or by name. */
export function findScript(ws: Workspace, text: string): ScriptInfo {
  for (const rel of [text, `scripts/${text}`]) {
    const abs = join(ws.root, rel)
    if (existsSync(abs) && statSync(abs).isFile()) return readScript(ws, relative(ws.root, abs))
  }
  const all = listScripts(ws)
  const hits = all.filter((s) => s.name === text || s.name.endsWith('/' + text))
  if (hits.length === 1) return hits[0]!
  if (hits.length > 1)
    throw new CliError(`${text} could be ${hits.map((s) => s.path).join(' or ')}`)
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
