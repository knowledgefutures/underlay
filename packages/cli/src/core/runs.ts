/**
 * Runs (local-tool-build.md phase 2). `underlay run <script> [args]` gives the script an
 * output folder, streams its output to a run log, and when it exits 0 compares each
 * collection's NDJSON with the head and saves a version for each that changed. The run is
 * recorded: script, git commit, inputs, output, and the versions it saved.
 *
 * A run holds a lock on each collection it writes, so two runs never save the same one at
 * once. Its record is in the workspace (`.underlay/runs/<id>.json`); its log and output are
 * in the store. A run started from the terminal UI runs detached, so closing the UI doesn't
 * stop it: its process id is in the record, for pause, resume and cancel.
 */
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { v3 } from '@underlay/protocol'

import { openColl, storeAt, type Ctx } from './context.js'
import { CliError } from './env.js'
import { type ScriptInfo } from './scripts.js'
import { saveVersion } from './versions.js'
import { keyOf, parseRef } from './workspace.js'

export interface SavedVersion {
  collection: string
  number: number
  semver: string
  id: string
  change: string
  added: number
  changed: number
  removed: number
}

export interface RunRecord {
  id: string
  script: string
  args: string[]
  startedAt: string
  endedAt: string | null
  status: 'running' | 'paused' | 'ok' | 'failed' | 'cancelled'
  exitCode: number | null
  /** The `underlay run` process, and the script's (its own process group). */
  pid: number | null
  scriptPid: number | null
  git: { commit: string; dirty: boolean } | null
  inputs: { path: string; sha256: string; bytes: number }[]
  log: string
  out: string
  saved: SavedVersion[]
  /** Collections the script wrote that nothing changed in. */
  unchanged: string[]
  error: string | null
}

const runsDir = (ctx: Ctx) => join(ctx.ws.stateDir, 'runs')
const recordPath = (ctx: Ctx, id: string) => join(runsDir(ctx), `${id}.json`)

export function readRun(ctx: Ctx, id: string): RunRecord {
  const p = recordPath(ctx, id)
  if (!existsSync(p)) throw new CliError(`No run ${id}`)
  return JSON.parse(readFileSync(p, 'utf8')) as RunRecord
}

function writeRun(ctx: Ctx, r: RunRecord) {
  mkdirSync(runsDir(ctx), { recursive: true })
  const p = recordPath(ctx, r.id)
  writeFileSync(`${p}.tmp`, JSON.stringify(r, null, 1))
  renameSync(`${p}.tmp`, p)
}

const alive = (pid: number | null) => {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Every run, newest first. A run whose process died without saying so is marked failed. */
export function listRuns(ctx: Ctx): RunRecord[] {
  const dir = runsDir(ctx)
  if (!existsSync(dir)) return []
  const out: RunRecord[] = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    try {
      const r = JSON.parse(readFileSync(join(dir, f), 'utf8')) as RunRecord
      if ((r.status === 'running' || r.status === 'paused') && !alive(r.pid)) {
        r.status = 'failed'
        r.error ??= 'The run stopped without finishing (its process is gone)'
      }
      out.push(r)
    } catch {
      // A record being written.
    }
  }
  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

export const newRunId = (now: Date) =>
  now.toISOString().replace(/[-:]/g, '').replace(/\..*/, '') + '-' + crypto.randomUUID().slice(0, 6)

// --- Locks ---

const lockPath = (ctx: Ctx, key: string) =>
  join(ctx.ws.stateDir, 'locks', key.replaceAll('/', '__') + '.lock')

/** Take the lock on a collection for this process; a lock whose process is gone is taken over. */
export function lock(ctx: Ctx, key: string, run: string): () => void {
  const p = lockPath(ctx, key)
  mkdirSync(join(ctx.ws.stateDir, 'locks'), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(p, 'wx')
      writeSync(fd, JSON.stringify({ pid: process.pid, run }))
      closeSync(fd)
      return () => rmSync(p, { force: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      const held = JSON.parse(readFileSync(p, 'utf8') || '{}') as { pid?: number; run?: string }
      if (alive(held.pid ?? null) && held.pid !== process.pid)
        throw new CliError(`${key} is being written by run ${held.run} (process ${held.pid})`)
      rmSync(p, { force: true })
    }
  }
  throw new CliError(`Could not lock ${key}`)
}

/** The run, if any, holding a collection's lock. */
export function lockedBy(ctx: Ctx, key: string): string | null {
  const p = lockPath(ctx, key)
  if (!existsSync(p)) return null
  const held = JSON.parse(readFileSync(p, 'utf8') || '{}') as { pid?: number; run?: string }
  return alive(held.pid ?? null) ? (held.run ?? null) : null
}

// --- Running ---

function gitOf(root: string): RunRecord['git'] {
  try {
    const commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
    const dirty =
      execFileSync('git', ['-C', root, 'status', '--porcelain', '--', 'scripts'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim() !== ''
    return { commit, dirty }
  } catch {
    return null
  }
}

function inputsOf(ctx: Ctx, args: string[]): RunRecord['inputs'] {
  const out: RunRecord['inputs'] = []
  for (const a of args) {
    const p = resolve(ctx.ws.root, a)
    if (!existsSync(p) || !statSync(p).isFile()) continue
    const bytes = readFileSync(p)
    out.push({
      path: relative(ctx.ws.root, p),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.byteLength,
    })
  }
  return out
}

/** The output files a run wrote: `<out>/<authority>/<org>/<name>.ndjson`. */
function outputsOf(out: string): string[] {
  const found: string[] = []
  const walk = (dir: string, depth: number) => {
    if (!existsSync(dir)) return
    for (const n of readdirSync(dir)) {
      const abs = join(dir, n)
      if (statSync(abs).isDirectory()) {
        if (depth < 2) walk(abs, depth + 1)
      } else if (depth === 2 && n.endsWith('.ndjson'))
        found.push(relative(out, abs).slice(0, -'.ndjson'.length))
    }
  }
  walk(out, 0)
  return found.sort()
}

async function* fileRows(path: string) {
  yield* v3.parseUpload(createReadStream(path) as AsyncIterable<Uint8Array>)
}

export interface RunOptions {
  /** Called with each chunk of the script's output, as it comes. */
  onOutput?: (text: string) => void
  /** Use this id (a detached run's record was made by the process that started it). */
  id?: string
  /** For an import: the built-in importer (importers.ts), which writes the output itself. */
  importer?: (
    info: ScriptInfo,
    args: string[],
    out: string,
    log: (line: string) => void,
  ) => Promise<{ mode?: 'additions' }>
}

/**
 * Run a script to the end: its output to the log, then a version for each collection it
 * changed. Returns the run's record.
 */
export async function runScript(
  ctx: Ctx,
  info: ScriptInfo,
  args: string[],
  opts: RunOptions = {},
): Promise<RunRecord> {
  const now = ctx.env.now()
  const id = opts.id ?? newRunId(now)
  const store = storeAt(ctx.settings.storePath)
  const dir = store.runDir(id)
  const out = join(dir, 'out')
  mkdirSync(out, { recursive: true })
  const record: RunRecord = {
    id,
    script: info.path,
    args,
    startedAt: now.toISOString(),
    endedAt: null,
    status: 'running',
    exitCode: null,
    pid: process.pid,
    scriptPid: null,
    git: gitOf(ctx.ws.root),
    inputs: inputsOf(ctx, args),
    log: join(dir, 'log.txt'),
    out,
    saved: [],
    unchanged: [],
    error: null,
  }
  const writes = info.writes.map((w) => keyOf(parseRef(w, ctx.settings.defaultRemote)))
  for (const w of writes) ctx.ws.collection(parseRef(w, ctx.settings.defaultRemote))
  const releases: (() => void)[] = []
  try {
    for (const w of writes) releases.push(lock(ctx, w, id))
  } catch (err) {
    releases.forEach((r) => r())
    throw err
  }
  writeRun(ctx, record)
  const log = createWriteStream(record.log, { flags: 'a' })
  const emit = (text: string) => {
    log.write(text)
    opts.onOutput?.(text)
  }
  try {
    let code: number | null
    let mode = info.mode
    if (info.kind === 'import') {
      if (!opts.importer) throw new CliError('Imports run through the built-in importers')
      try {
        mode = (await opts.importer(info, args, out, (line) => emit(line + '\n'))).mode ?? mode
        code = 0
      } catch (err) {
        emit(`${(err as Error).message}\n`)
        code = 1
      }
    } else {
      code = await new Promise<number | null>((done, fail) => {
        const child = spawn(info.command![0]!, [...info.command!.slice(1), ...args], {
          cwd: ctx.ws.root,
          env: {
            ...process.env,
            UNDERLAY_OUT: out,
            UNDERLAY_WORKSPACE: ctx.ws.root,
            UNDERLAY_RUN: id,
            ...(record.inputs[0]
              ? { UNDERLAY_INPUT: join(ctx.ws.root, record.inputs[0].path) }
              : {}),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        })
        record.scriptPid = child.pid ?? null
        writeRun(ctx, record)
        child.stdout.on('data', (b: Buffer) => emit(b.toString()))
        child.stderr.on('data', (b: Buffer) => emit(b.toString()))
        child.on('error', fail)
        child.on('close', (c, signal) => done(signal ? null : c))
      })
    }
    record.exitCode = code
    const cancelled = existsSync(join(dir, 'cancelled'))
    if (code !== 0) {
      record.status = cancelled ? 'cancelled' : 'failed'
      record.error = cancelled ? 'Cancelled' : `Exited with ${code ?? 'a signal'}`
    } else {
      // Each collection it wrote, compared with the head.
      for (const key of outputsOf(out)) {
        const ref = parseRef(key, ctx.settings.defaultRemote)
        const meta = ctx.ws.readCollection(ref)
        if (!meta) {
          emit(
            `underlay: ${key} is not in this workspace; its output is left in ${relative(ctx.ws.root, out) || out}\n`,
          )
          continue
        }
        if (!writes.includes(key)) releases.push(lock(ctx, key, id))
        const c = openColl(ctx, meta)
        const res = await saveVersion(c, {
          rows: fileRows(join(out, `${key}.ndjson`)),
          mode,
          ...(info.types ? { types: info.types } : {}),
          ...(info.where ? { where: info.where } : {}),
          schemas: ctx.ws.schemas(meta),
          message: `${info.name}${args.length ? ' ' + args.join(' ') : ''}`,
          run: id,
          now: ctx.env.now(),
        })
        if (!res.version) {
          record.unchanged.push(key)
          continue
        }
        const v = res.version
        record.saved.push({
          collection: key,
          number: v.commit.number,
          semver: v.commit.semver,
          id: v.id,
          change: c.store.state(meta.id).versions[v.id]!.change,
          ...{ added: res.stats.added, changed: res.stats.changed, removed: res.stats.removed },
        })
      }
      record.status = 'ok'
    }
  } catch (err) {
    record.status = 'failed'
    record.error = (err as Error).message
    emit(`underlay: ${record.error}\n`)
  } finally {
    releases.forEach((r) => r())
    record.endedAt = ctx.env.now().toISOString()
    record.pid = null
    writeRun(ctx, record)
    await new Promise<void>((r) => log.end(r))
  }
  return record
}

/** Pause, resume or cancel a run's script (its whole process group). */
export function signalRun(ctx: Ctx, id: string, what: 'pause' | 'resume' | 'cancel'): RunRecord {
  const r = readRun(ctx, id)
  if (!r.scriptPid || (r.status !== 'running' && r.status !== 'paused'))
    throw new CliError(`Run ${id} is ${r.status}`)
  if (what === 'cancel') writeFileSync(join(r.out, '..', 'cancelled'), '')
  const signal = what === 'pause' ? 'SIGSTOP' : what === 'resume' ? 'SIGCONT' : 'SIGTERM'
  try {
    process.kill(-r.scriptPid, signal)
    if (what === 'cancel') process.kill(-r.scriptPid, 'SIGCONT')
  } catch {
    process.kill(r.scriptPid, signal)
  }
  if (what !== 'cancel') {
    r.status = what === 'pause' ? 'paused' : 'running'
    writeRun(ctx, r)
  }
  return r
}

/** Start a run in its own process, detached: it outlives the terminal UI. Its id. */
export function startDetached(ctx: Ctx, script: string, args: string[]): string {
  const id = newRunId(ctx.env.now())
  const cli = process.argv[1]!
  const child = spawn(process.execPath, [cli, 'run', script, ...args, '--run-id', id, '--quiet'], {
    cwd: ctx.ws.root,
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  child.unref()
  return id
}

/** A run's log, from a byte offset: for following it. */
export function readLog(r: RunRecord, from = 0): { text: string; next: number } {
  if (!existsSync(r.log)) return { text: '', next: from }
  const size = statSync(r.log).size
  if (size <= from) return { text: '', next: from }
  const fd = openSync(r.log, 'r')
  const buf = Buffer.alloc(size - from)
  try {
    readSync(fd, buf, 0, buf.length, from)
  } finally {
    closeSync(fd)
  }
  return { text: buf.toString(), next: size }
}
