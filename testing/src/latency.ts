/**
 * How long storage and database calls take, simulated. A local SSD answers in
 * microseconds, which hides exactly what makes commits slow on Workers: a merge
 * that reads leaves one at a time waits on R2 for each. So every call waits as
 * R2 or D1 would, from a Worker in the same region.
 *
 * `r2` is a first guess from published measurements, not ours; tier 2 of the
 * plan (scale-testing.md) measures the real distribution and replaces it.
 */

export interface OpModel {
  /** Median time to first byte, ms, and the spread (lognormal sigma). */
  ms: number
  sigma: number
  /** Transfer rate for the body, MB/s per request (0: instant). */
  mbps: number
}

export interface Profile {
  name: string
  get: OpModel
  head: OpModel
  put: OpModel
  list: OpModel
  delete: OpModel
  /** One D1 statement, or one batch (a round trip), plus `perStatement` ms for each in a batch. */
  d1: OpModel
  d1PerStatement: number
}

const zero: OpModel = { ms: 0, sigma: 0, mbps: 0 }

export const PROFILES: Record<string, Profile> = {
  none: {
    name: 'none',
    get: zero,
    head: zero,
    put: zero,
    list: zero,
    delete: zero,
    d1: zero,
    d1PerStatement: 0,
  },
  r2: {
    name: 'r2',
    get: { ms: 25, sigma: 0.5, mbps: 150 },
    head: { ms: 15, sigma: 0.4, mbps: 0 },
    put: { ms: 45, sigma: 0.5, mbps: 100 },
    list: { ms: 35, sigma: 0.4, mbps: 0 },
    delete: { ms: 15, sigma: 0.4, mbps: 0 },
    d1: { ms: 6, sigma: 0.6, mbps: 0 },
    d1PerStatement: 0.3,
  },
  /** R2 on a bad day, or from a Worker far from the bucket. */
  'r2-slow': {
    name: 'r2-slow',
    get: { ms: 60, sigma: 0.7, mbps: 60 },
    head: { ms: 40, sigma: 0.6, mbps: 0 },
    put: { ms: 110, sigma: 0.7, mbps: 40 },
    list: { ms: 80, sigma: 0.6, mbps: 0 },
    delete: { ms: 40, sigma: 0.6, mbps: 0 },
    d1: { ms: 20, sigma: 0.7, mbps: 0 },
    d1PerStatement: 0.5,
  },
}

export function profile(name: string): Profile {
  const p = PROFILES[name]
  if (!p) throw new Error(`Unknown latency profile "${name}": ${Object.keys(PROFILES).join(', ')}`)
  return p
}

const normal = () =>
  Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random())

/** Milliseconds one call takes: lognormal time to first byte plus the body at the model's rate. */
export function delayMs(m: OpModel, bytes = 0): number {
  if (m.ms === 0 && m.mbps === 0) return 0
  const first = m.ms * Math.exp(m.sigma * normal())
  return first + (m.mbps > 0 ? (bytes / (m.mbps * 1024 * 1024)) * 1000 : 0)
}

/**
 * Wait `ms`. Timers resolve to whole milliseconds, so waits under one are
 * carried over and taken together rather than rounded up each time.
 */
let owed = 0
export async function wait(ms: number): Promise<void> {
  if (ms <= 0) return
  owed += ms
  if (owed < 1) return
  const now = Math.floor(owed)
  owed -= now
  await new Promise((r) => setTimeout(r, now))
}
