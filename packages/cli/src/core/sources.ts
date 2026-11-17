/**
 * Script folders (local-tool.md "Home and script folders"): where scripts and views come from.
 *
 *   home      home's own `scripts/`
 *   listed    `[[sources]]` in config.toml, each under the short name its owner gave it
 *   here      the folder holding the working directory, when it has an `underlay.toml`
 *
 * A script folder's `underlay.toml` is optional and says only what belongs to its code:
 *
 *   scripts = ["sources"]          where to look (default: the whole folder)
 *   authority = "underlay.org"     for collections its scripts name as org/name
 *   [runners]                      how to run a file, by extension
 *   ".ts" = "pnpm exec tsx"
 *   [env]                          secrets its scripts need: names only
 *   need = ["ORCID_TOKEN"]
 */
import { existsSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

import { type Settings, TomlFile } from './config.js'
import { CliError, type Env } from './env.js'
import type { Home } from './home.js'

export interface Source {
  /** The short name scripts are listed under: `home`, `scrapers`. */
  name: string
  /** The folder: scripts run here, and git is asked here. */
  root: string
  /** The folders searched for scripts. */
  dirs: string[]
  /** Where script names are taken from: the one searched folder, or the root. */
  namesFrom: string
  /** For collections named org/name in its scripts; null for the default remote. */
  authority: string | null
  /** Extension → command, over the built-in runners. */
  runners: Record<string, string>
  /** Secrets its scripts need. */
  need: string[]
  how: 'home' | 'listed' | 'here'
  /** False when a listed folder is not on this machine. */
  exists: boolean
}

export const SOURCE_FILE = 'underlay.toml'

export const SOURCE_HEADER = `# An Underlay script folder (local-tool.md "Home and script folders"). Optional.
# Scripts here declare themselves in a header comment: // underlay: writes org/name
# (or check, takes *.xlsx, view, serves). Collections and their schemas live in each
# person's home, never here.
`

function readSource(name: string, root: string, how: Source['how'], homeScripts?: string): Source {
  const exists = existsSync(root) && statSync(root).isDirectory()
  if (homeScripts)
    return {
      name,
      root,
      dirs: [homeScripts],
      namesFrom: homeScripts,
      authority: null,
      runners: {},
      need: [],
      how,
      exists,
    }
  const t = exists ? TomlFile.read(join(root, SOURCE_FILE)).data : {}
  const listed = Array.isArray(t.scripts)
    ? t.scripts.map(String)
    : typeof t.scripts === 'string'
      ? [t.scripts]
      : []
  const dirs = listed.length ? listed.map((d) => resolve(root, d)) : [root]
  for (const d of dirs)
    if (relative(root, d).startsWith('..'))
      throw new CliError(`${join(root, SOURCE_FILE)}: scripts must be inside the folder (${d})`)
  const runners: Record<string, string> = {}
  for (const [ext, cmd] of Object.entries((t.runners ?? {}) as Record<string, unknown>))
    if (typeof cmd === 'string') runners[ext.startsWith('.') ? ext : `.${ext}`] = cmd
  return {
    name,
    root,
    dirs,
    namesFrom: dirs.length === 1 ? dirs[0]! : root,
    authority: typeof t.authority === 'string' ? t.authority : null,
    runners,
    need: Array.isArray(t.env?.need) ? t.env.need.map(String) : [],
    how,
    exists,
  }
}

/** The folder holding `from` that has an `underlay.toml`, or null. */
export function sourceRootOf(from: string): string | null {
  let dir = resolve(from)
  for (;;) {
    if (existsSync(join(dir, SOURCE_FILE))) return dir
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

const inside = (dir: string, path: string) => path === dir || path.startsWith(dir + sep)

/** Home's scripts, the listed folders, and the one you're in. */
export function sourcesOf(settings: Settings, home: Home, cwd = process.cwd()): Source[] {
  const out: Source[] = [readSource('home', home.root, 'home', home.scriptsDir)]
  for (const s of settings.sources) out.push(readSource(s.name, s.path, 'listed'))
  const here = sourceRootOf(cwd)
  if (here && !inside(home.root, here) && !out.some((s) => s.root === here)) {
    let name = basename(here)
    if (out.some((s) => s.name === name)) name = `${name}-here`
    out.push(readSource(name, here, 'here'))
  }
  return out
}

/** The secret a key store keeps for a script folder's `need`. */
export const secretKey = (name: string) => `secret:${name}`

/** The values of a script folder's secrets: the environment first, then the key store. */
export function secretsFor(env: Env, need: string[], script: string): Record<string, string> {
  const out: Record<string, string> = {}
  const missing: string[] = []
  for (const n of need) {
    const v = process.env[n] ?? env.keys.get(secretKey(n))
    if (v) out[n] = v
    else missing.push(n)
  }
  if (missing.length)
    throw new CliError(
      `${script} needs ${missing.join(', ')}: underlay secret set ${missing[0]} (or set it in the environment)`,
    )
  return out
}
