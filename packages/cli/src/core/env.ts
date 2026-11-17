/**
 * What the library needs from the machine, in one place so tests can give their own:
 * where the personal config and the default store live, how to reach a remote, where
 * keys are kept, and the time.
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { type KeyStore, keychainOrFile } from './keys.js'

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>

export interface Env {
  home: string
  /** `~/.config/underlay`: config.toml, and keys kept in files. */
  configDir: string
  /** `~/.local/share/underlay`: the default store. */
  dataDir: string
  /** `UNDERLAY_HOME`: home, over what config.toml says. */
  homeDir?: string | null
  fetch: Fetch
  keys: KeyStore
  now(): Date
}

export class CliError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliError'
  }
}

/** The environment of this process: XDG paths, and `UNDERLAY_*` overrides for tests and CI. */
export function defaultEnv(vars: NodeJS.ProcessEnv = process.env): Env {
  const home = vars.HOME ?? homedir()
  const configDir =
    vars.UNDERLAY_CONFIG_DIR ?? join(vars.XDG_CONFIG_HOME ?? join(home, '.config'), 'underlay')
  const dataDir =
    vars.UNDERLAY_DATA_DIR ?? join(vars.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'underlay')
  return {
    home,
    configDir,
    dataDir,
    homeDir: vars.UNDERLAY_HOME ? resolve(vars.UNDERLAY_HOME) : null,
    fetch: (url, init) => fetch(url, init),
    keys: keychainOrFile(configDir, vars),
    now: () => new Date(),
  }
}

/** `~/x` and relative paths, made absolute. */
export function expandPath(env: Pick<Env, 'home'>, p: string, from = process.cwd()): string {
  if (p === '~') return env.home
  if (p.startsWith('~/')) return join(env.home, p.slice(2))
  return resolve(from, p)
}

/** An absolute path shown with `~` for the home directory. */
export function tildePath(env: Pick<Env, 'home'>, p: string): string {
  return p === env.home ? '~' : p.startsWith(env.home + '/') ? '~' + p.slice(env.home.length) : p
}
