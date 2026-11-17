/**
 * Where API keys are kept: the macOS keychain (`security`), or a 0600 file per remote in
 * the config folder elsewhere. A key in the environment (`UNDERLAY_KEY`, or
 * `UNDERLAY_KEY_<REMOTE>` with the remote's address in capitals and `_` for anything else)
 * wins over both, for CI and scripts.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface KeyStore {
  /** Where keys are kept, as `config.toml` names it: `keychain` or `file`. */
  readonly kind: 'keychain' | 'file' | 'env'
  get(remote: string): string | null
  set(remote: string, key: string): void
  delete(remote: string): void
}

const SERVICE = 'underlay-cli'
const envName = (remote: string) =>
  `UNDERLAY_KEY_${remote.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`

export function fileKeys(dir: string): KeyStore {
  const path = (remote: string) => join(dir, 'keys', remote.replace(/[^A-Za-z0-9._-]/g, '_'))
  return {
    kind: 'file',
    get(remote) {
      try {
        return readFileSync(path(remote), 'utf8').trim() || null
      } catch {
        return null
      }
    },
    set(remote, key) {
      mkdirSync(join(dir, 'keys'), { recursive: true, mode: 0o700 })
      writeFileSync(path(remote), key + '\n', { mode: 0o600 })
    },
    delete(remote) {
      rmSync(path(remote), { force: true })
    },
  }
}

export function keychainKeys(): KeyStore {
  return {
    kind: 'keychain',
    get(remote) {
      try {
        const out = execFileSync(
          'security',
          ['find-generic-password', '-s', SERVICE, '-a', remote, '-w'],
          { stdio: ['ignore', 'pipe', 'ignore'] },
        )
        return out.toString().trim() || null
      } catch {
        return null
      }
    },
    set(remote, key) {
      // -U updates a key already there. The key goes as an argument: `security` reads no
      // stdin for -w, and the argument is visible only to this user's processes.
      execFileSync(
        'security',
        ['add-generic-password', '-U', '-s', SERVICE, '-a', remote, '-w', key],
        {
          stdio: 'ignore',
        },
      )
    },
    delete(remote) {
      try {
        execFileSync('security', ['delete-generic-password', '-s', SERVICE, '-a', remote], {
          stdio: 'ignore',
        })
      } catch {
        // Not there.
      }
    },
  }
}

/** The keychain on macOS, files elsewhere (or with `UNDERLAY_KEYS=file`); the environment first. */
export function keychainOrFile(configDir: string, vars: NodeJS.ProcessEnv): KeyStore {
  const base =
    process.platform === 'darwin' && vars.UNDERLAY_KEYS !== 'file'
      ? keychainKeys()
      : fileKeys(configDir)
  return {
    kind: base.kind,
    get: (remote) => vars[envName(remote)] ?? vars.UNDERLAY_KEY ?? base.get(remote),
    set: (remote, key) => base.set(remote, key),
    delete: (remote) => base.delete(remote),
  }
}
