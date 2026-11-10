/**
 * What the bench's steps share: measuring a step (time, CPU, memory, requests),
 * building files on local disk as a client does, and running parts of a job in
 * child processes under the same heap cap.
 */
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { v3 } from '../../packages/protocol/src/index.js'
import { delayMs, wait } from '../src/latency.js'
import { addCounts, type BenchStore, type Counts, costOf, subCounts, zeroCounts } from './store.js'

export const MB = 1024 * 1024
export const GB = 1024 * MB

// --- Logging ---

const started = Date.now()
export function log(message: string, data?: unknown): void {
  const t = ((Date.now() - started) / 1000).toFixed(1)
  console.log(`[${t}s] ${message}${data === undefined ? '' : ' ' + JSON.stringify(data)}`)
}

// --- Memory ---

let peakRss = 0
let peakHeap = 0
function sample(): void {
  const m = process.memoryUsage()
  if (m.rss > peakRss) peakRss = m.rss
  if (m.heapUsed > peakHeap) peakHeap = m.heapUsed
}
setInterval(sample, 100).unref()
export const memory = {
  reset(): void {
    peakRss = 0
    peakHeap = 0
    sample()
  },
  peak(): { rssMb: number; heapMb: number } {
    sample()
    return { rssMb: Math.round(peakRss / MB), heapMb: Math.round(peakHeap / MB) }
  },
}

// --- Measuring ---

export interface Measured {
  seconds: number
  /** CPU seconds, this process and any workers it ran. */
  cpuSeconds: number
  /** The most memory any one process held. */
  peakRssMb: number
  peakHeapMb: number
  requests: Counts
  /** Dollars at R2's prices for the requests. */
  cost: number
}

/** What workers started during a step add to it. */
let workerCpu = 0
let workerRss = 0
let workerHeap = 0
let workerCounts = zeroCounts()

export async function measure<T>(
  store: BenchStore,
  fn: () => Promise<T>,
  /** Leave out what workers report: for a step measured while another step's workers run. */
  own = false,
): Promise<{ value: T; m: Measured }> {
  const before = store.snapshot()
  const cpu0 = process.cpuUsage()
  const t0 = performance.now()
  memory.reset()
  if (!own) {
    workerCpu = 0
    workerRss = 0
    workerHeap = 0
    workerCounts = zeroCounts()
  }
  const value = await fn()
  const cpu = process.cpuUsage(cpu0)
  const mine = memory.peak()
  const requests = subCounts(store.snapshot(), before)
  if (!own) addCounts(requests, workerCounts)
  return {
    value,
    m: {
      seconds: round((performance.now() - t0) / 1000, 3),
      cpuSeconds: round((cpu.user + cpu.system) / 1e6 + (own ? 0 : workerCpu), 3),
      peakRssMb: own ? mine.rssMb : Math.max(mine.rssMb, workerRss),
      peakHeapMb: own ? mine.heapMb : Math.max(mine.heapMb, workerHeap),
      requests,
      cost: costOf(requests),
    },
  }
}

export const round = (n: number, digits = 2): number => {
  const f = 10 ** digits
  return Math.round(n * f) / f
}

// --- A client's local build ---

/**
 * Files built straight into the store's folder, as a client builds them on its
 * own disk and then uploads them. The upload is counted on the store (one put,
 * or a multipart upload in 8 MiB parts) and waits as an upload would.
 */
export function clientTarget(store: BenchStore): v3.FileTarget {
  return {
    async begin() {
      const tmpDir = join(store.dir, 'tmp')
      await mkdir(tmpDir, { recursive: true })
      const tmp = join(tmpDir, `build-${crypto.randomUUID()}.tmp`)
      const out = createWriteStream(tmp, { highWaterMark: 4 * MB })
      let size = 0
      const closed = new Promise<void>((resolve, reject) => {
        out.on('close', resolve)
        out.on('error', reject)
      })
      return {
        async write(chunk) {
          size += chunk.byteLength
          if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', r))
        },
        async keep(id) {
          out.end()
          await closed
          const key = v3.recordKey(id)
          const path = join(store.dir, key)
          const parts = size > 5 * MB ? Math.ceil(size / v3.PART_BYTES) + 2 : 1
          store.counts.classA += parts
          if (existsSync(path)) {
            // Already stored: the server takes the upload and keeps what it has.
            await rm(tmp, { force: true })
          } else {
            await mkdir(join(store.dir, 'records'), { recursive: true })
            await rename(tmp, path)
          }
          store.counts.bytesIn += size
          const ms = delayMs(store.latency.put, size)
          store.counts.waitMs += ms
          await wait(ms)
        },
        async discard() {
          out.destroy()
          await rm(tmp, { force: true })
        },
      }
    },
  }
}

/** Drop what `buildFiles` adds to a file reference, leaving what a commit names. */
export const refOf = (
  f: v3.FileRef & { size?: number; labeled?: boolean; commits?: unknown },
): v3.FileRef => ({
  id: f.id,
  first: f.first,
  last: f.last,
  entries: f.entries,
  records: f.records,
  removals: f.removals,
  bytes: f.bytes,
})

// --- Workers ---

export interface WorkerReport {
  cpuSeconds: number
  peakRssMb: number
  peakHeapMb: number
  requests: Counts
  [more: string]: unknown
}

/** What a worker prints as its last line. */
export function report(store: BenchStore | null, more: Record<string, unknown>): void {
  const cpu = process.cpuUsage()
  const mem = memory.peak()
  const out: WorkerReport = {
    ...more,
    cpuSeconds: round((cpu.user + cpu.system) / 1e6, 3),
    peakRssMb: mem.rssMb,
    peakHeapMb: mem.heapMb,
    requests: store?.snapshot() ?? zeroCounts(),
  }
  process.stdout.write('\n@@report ' + JSON.stringify(out) + '\n')
}

/**
 * Run a job in a child process with this process's own flags (the heap cap
 * among them), and return its report. Its CPU, memory and requests are added to
 * the step being measured.
 */
export function runWorker<T extends WorkerReport>(job: string, spec: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, 'worker', job], {
      stdio: ['pipe', 'pipe', 'inherit'],
    })
    let out = ''
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString()
      // Pass a worker's own log lines through as they come.
      let nl: number
      while ((nl = out.indexOf('\n')) !== -1 && !out.startsWith('@@report ')) {
        const line = out.slice(0, nl)
        out = out.slice(nl + 1)
        if (line.trim()) console.log(`  ${line}`)
      }
    })
    child.on('error', reject)
    child.on('close', (code) => {
      const at = out.lastIndexOf('@@report ')
      if (code !== 0 || at === -1) {
        reject(new Error(`worker ${job} failed (exit ${code}): ${out.slice(-2000)}`))
        return
      }
      const r = JSON.parse(out.slice(at + 9)) as T
      workerCpu += r.cpuSeconds
      workerRss = Math.max(workerRss, r.peakRssMb)
      workerHeap = Math.max(workerHeap, r.peakHeapMb)
      addCounts(workerCounts, r.requests)
      resolve(r)
    })
    child.stdin.end(JSON.stringify(spec))
  })
}

export async function readSpec<T>(): Promise<T> {
  let text = ''
  for await (const chunk of process.stdin) text += String(chunk)
  return JSON.parse(text) as T
}

// --- Arguments ---

export function parseArgs(argv: string[]): {
  _: string[]
  [flag: string]: string | boolean | string[]
} {
  const out: { _: string[]; [flag: string]: string | boolean | string[] } = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    const dashes = a.startsWith('--') ? 2 : /^-[a-zA-Z]/.test(a) ? 1 : 0
    if (dashes > 0) {
      const eq = a.indexOf('=')
      if (eq !== -1) out[a.slice(dashes, eq)] = a.slice(eq + 1)
      else if (i + 1 < argv.length && !/^--?[a-zA-Z]/.test(argv[i + 1]!)) {
        out[a.slice(dashes)] = argv[++i]!
      } else out[a.slice(dashes)] = true
    } else out._.push(a)
  }
  return out
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!
}

export function summary(values: number[]): {
  n: number
  p50: number
  p95: number
  max: number
  mean: number
} {
  const s = [...values].sort((a, b) => a - b)
  return {
    n: s.length,
    p50: round(percentile(s, 50)),
    p95: round(percentile(s, 95)),
    max: round(s[s.length - 1] ?? 0),
    mean: round(s.reduce((a, b) => a + b, 0) / Math.max(1, s.length)),
  }
}
