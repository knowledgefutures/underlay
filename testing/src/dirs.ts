/**
 * The bench folder: everything bulky lives under one directory outside Dropbox
 * (~/underlay-bench, or UL_BENCH_DIR), so deleting it gets all the space back.
 *
 *   inputs/<name>/   generated NDJSON.gz, only when asked for (gen --materialize)
 *   bases/<name>/    loaded collections kept for reuse: db.sqlite, bucket/, base.json
 *   runs/<id>/       one scenario: db.sqlite, bucket/, a clone of a base or empty
 *   results/         small JSON results and report.html
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, statfsSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const GB = 1024 ** 3
export const MB = 1024 ** 2

export function benchDir(): string {
  return resolve(process.env.UL_BENCH_DIR ?? join(homedir(), 'underlay-bench'))
}

/**
 * Make the bench folder, kept out of Time Machine and Spotlight, and refuse one
 * inside Dropbox: a run writes tens of GB that Dropbox would try to sync.
 */
export function ensureBenchDir(): string {
  const dir = benchDir()
  const fresh = !existsSync(dir)
  mkdirSync(dir, { recursive: true })
  const real = realpathSync(dir)
  if (/\/(Dropbox|Library\/CloudStorage)\//.test(`${real}/`) && !process.env.UL_BENCH_ALLOW_SYNCED)
    throw new Error(`${real} is inside a synced folder; set UL_BENCH_DIR elsewhere`)
  for (const sub of ['inputs', 'bases', 'runs', 'results'])
    mkdirSync(join(dir, sub), { recursive: true })
  if (fresh) {
    writeFileSync(join(dir, '.metadata_never_index'), '')
    try {
      execFileSync('tmutil', ['addexclusion', dir], { stdio: 'ignore' })
    } catch {
      // Not macOS, or Time Machine isn't set up: nothing to exclude from.
    }
    writeFileSync(
      join(dir, 'README.txt'),
      'Underlay scale bench data (underlay repo, testing/). Safe to delete: rm -rf this folder.\n' +
        'Rebuild with the same bench commands; the generator is deterministic.\n',
    )
  }
  return dir
}

export const runsDir = () => join(benchDir(), 'runs')
export const basesDir = () => join(benchDir(), 'bases')
export const resultsDir = () => join(benchDir(), 'results')
export const inputsDir = () => join(benchDir(), 'inputs')

export function freeBytes(dir = ensureBenchDir()): number {
  const s = statfsSync(dir)
  return Number(s.bavail) * Number(s.bsize)
}

/** Refuse to start work expected to need more disk than is free (keeping a margin). */
export function guardDisk(needBytes: number, what: string): void {
  const free = freeBytes()
  const margin = Math.max(20 * GB, free * 0.05)
  if (needBytes > free - margin) {
    throw new Error(
      `${what} needs about ${(needBytes / GB).toFixed(0)} GB; ${(free / GB).toFixed(0)} GB is free ` +
        `(keeping ${(margin / GB).toFixed(0)} GB back). Free space, or run smaller.`,
    )
  }
}

/** Copy a directory as an APFS clone: instant, and it shares blocks until either side writes. */
export function cloneDir(from: string, to: string): void {
  if (existsSync(to)) throw new Error(`${to} exists`)
  try {
    execFileSync('cp', ['-cR', from, to])
  } catch {
    execFileSync('cp', ['-R', from, to])
  }
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

/** Bytes a directory takes, as du reports them (a clone's blocks count in full, shared or not). */
export function duBytes(dir: string): number {
  if (!existsSync(dir)) return 0
  const out = execFileSync('du', ['-sk', dir]).toString()
  return Number(out.split(/\s/)[0]) * 1024
}
