/**
 * Updates, for a CLI installed with `<origin>/cli/install.sh`. The install script keeps the
 * CLI as one file, `underlay.js`, with an `origin` file beside it naming the deployment it
 * came from (staging or www), so an update comes from the same place.
 *
 * A newer CLI is one whose published SHA-256 (`<origin>/cli/underlay.js.sha256`) differs from
 * this file's: no version numbers to bump, no new route. The check asks at most once a day,
 * remembered in `~/.config/underlay/update.json`, and a failure (offline) waits a day too.
 * `underlay update` downloads the file, checks it against its SHA-256, and swaps it in.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { CliError, type Env } from './env.js'

const DAY = 24 * 3600_000

export interface Installed {
  /** The running CLI's file. */
  file: string
  /** The deployment it was installed from: `https://staging.underlay.org`. */
  origin: string
}

/** The running CLI, if install.sh put it there; null for a build run from source. */
export function installed(file: string | undefined = process.argv[1]): Installed | null {
  if (!file) return null
  let real: string
  try {
    real = realpathSync(file)
  } catch {
    return null
  }
  const at = join(dirname(real), 'origin')
  if (!existsSync(at)) return null
  const origin = readFileSync(at, 'utf8').trim()
  try {
    return { file: real, origin: new URL(origin).origin }
  } catch {
    return null
  }
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

interface State {
  checkedAt: string
  origin: string
  /** The published SHA-256, or null when the check failed. */
  latest: string | null
}

const statePath = (env: Env) => join(env.configDir, 'update.json')

function readState(env: Env): State | null {
  try {
    return JSON.parse(readFileSync(statePath(env), 'utf8')) as State
  } catch {
    return null
  }
}

function writeState(env: Env, s: State) {
  try {
    writeFileSync(statePath(env), JSON.stringify(s) + '\n')
  } catch {
    // No config folder yet: ask again next time.
  }
}

async function publishedSum(env: Env, origin: string, timeoutMs: number): Promise<string> {
  const url = `${origin}/cli/underlay.js.sha256`
  const res = await env.fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new CliError(`${url}: ${res.status}`)
  const sum = (await res.text()).trim().split(/\s+/)[0] ?? ''
  if (!/^[0-9a-f]{64}$/.test(sum)) throw new CliError(`${url}: not a SHA-256`)
  return sum
}

export interface Available {
  origin: string
}

/**
 * Whether a newer CLI is out than the one running. Null when it isn't, when this CLI wasn't
 * installed by install.sh, when `UNDERLAY_NO_UPDATE_CHECK` is set, or when the check failed.
 */
export async function checkForUpdate(
  env: Env,
  opts: { file?: string; force?: boolean; vars?: NodeJS.ProcessEnv } = {},
): Promise<Available | null> {
  if ((opts.vars ?? process.env).UNDERLAY_NO_UPDATE_CHECK) return null
  const inst = installed(opts.file)
  if (!inst) return null
  let state = readState(env)
  const now = env.now().getTime()
  const fresh =
    state && state.origin === inst.origin && now - Date.parse(state.checkedAt) < DAY && !opts.force
  if (!fresh) {
    let latest: string | null = null
    try {
      latest = await publishedSum(env, inst.origin, 2000)
    } catch {
      // Offline, or the server is down: try again tomorrow.
    }
    state = { checkedAt: new Date(now).toISOString(), origin: inst.origin, latest }
    writeState(env, state)
  }
  if (!state?.latest) return null
  return state.latest !== sha256(readFileSync(inst.file)) ? { origin: inst.origin } : null
}

/** Download the newest CLI from where this one came from, check it, and swap it in. */
export async function update(
  env: Env,
  file: string | undefined = process.argv[1],
): Promise<{ origin: string; file: string; changed: boolean }> {
  const inst = installed(file)
  if (!inst)
    throw new CliError(
      'This CLI wasn’t installed by install.sh, or was installed before it could update itself. Run the install line again: curl -fsSL https://www.underlay.org/cli/install.sh | sh (staging: https://staging.underlay.org/cli/install.sh)',
    )
  const want = await publishedSum(env, inst.origin, 15_000)
  if (want === sha256(readFileSync(inst.file)))
    return { origin: inst.origin, file: inst.file, changed: false }
  const url = `${inst.origin}/cli/underlay.js`
  const res = await env.fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!res.ok) throw new CliError(`${url}: ${res.status}`)
  const body = new Uint8Array(await res.arrayBuffer())
  if (sha256(body) !== want)
    throw new CliError(`${url} doesn’t match its checksum; nothing was changed`)
  // Written beside it and renamed over it, so a failure never leaves half a file.
  const tmp = `${inst.file}.new`
  writeFileSync(tmp, body)
  renameSync(tmp, inst.file)
  writeState(env, { checkedAt: env.now().toISOString(), origin: inst.origin, latest: want })
  return { origin: inst.origin, file: inst.file, changed: true }
}
