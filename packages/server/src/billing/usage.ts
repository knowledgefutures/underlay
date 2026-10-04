/**
 * The usage log (edge-redesign.md, "Metering, and rebuilding the counters"):
 * what requests use, which version data can't tell. API calls and response
 * bytes per collection, and file downloads and their bytes.
 *
 * An isolate's events travel together (a queue message every few seconds on
 * Workers; a buffer on Node) and land in immutable `usage/<day>/<hash>.ndjson`
 * objects in the internal area, a batch at a time. An object is named by the
 * hash of its contents, so a redelivered batch rewrites the same object and the
 * log never counts it twice. `usage_rollups` are added to as each batch lands;
 * there a redelivered batch can count twice, until `usage.rebuild` recomputes
 * the day from the log, a page of log objects per job. Keep the log for at
 * least the billing dispute window.
 */
import { and, eq, sql } from 'drizzle-orm'

import * as schema from '../db/schema.js'
import { registerJob } from '../jobs.js'
import type { Ports } from '../ports.js'

export type UsageMetric = 'api_calls' | 'response_bytes' | 'file_downloads' | 'file_bytes'

/** One event: request id and position (the dedupe key), time, who is billed, what for. */
export interface UsageEvent {
  r: string
  i: number
  t: number
  /** The account billed: the organization owning the collection. */
  a: string
  c: string | null
  m: UsageMetric
  n: number
}

/** A request's usage while it runs: who it bills, and its events so far. */
export interface Meter {
  requestId: string
  /** The collection a route resolved (requireCollection), and its owning account. */
  collection: { id: string; accountId: string } | null
  events: UsageEvent[]
  /**
   * Set by a route whose body is compressed storage (records.ndjson.gz): the
   * uncompressed bytes it sent, billed instead of the wire bytes, so the same
   * data costs the same whichever form it's read in.
   */
  logicalBytes?: number
}

export const newMeter = (): Meter => ({
  requestId: crypto.randomUUID(),
  collection: null,
  events: [],
})

/** Add an event to a request's meter, billed to `on` (default: the request's collection). */
export function meter(
  m: Meter,
  metric: UsageMetric,
  n: number,
  on: { id: string; accountId: string } | null = m.collection,
): void {
  if (!on || n <= 0) return
  m.events.push({
    r: m.requestId,
    i: m.events.length,
    t: Date.now(),
    a: on.accountId,
    c: on.id,
    m: metric,
    n,
  })
}

/** Where a request's events go. */
export interface UsageSink {
  record(events: UsageEvent[]): void
}

const PREFIX = 'usage'
const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10)

/** Write one batch of events: a log object per day it spans, then rollup increments. */
export async function writeUsage(ports: Ports, events: UsageEvent[]): Promise<void> {
  if (events.length === 0) return
  const byDay = new Map<string, UsageEvent[]>()
  for (const e of events) {
    const d = dayOf(e.t)
    byDay.set(d, [...(byDay.get(d) ?? []), e])
  }
  for (const [day, list] of byDay) {
    // Log first: a rollup never counts what the log lacks.
    const body = list.map((e) => JSON.stringify(e)).join('\n') + '\n'
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
    await ports.stores.internal.put(`${PREFIX}/${day}/${hash}.ndjson`, body, {
      contentType: 'application/x-ndjson',
    })
    await addRollups(ports, day, sum(list))
  }
}

type Totals = Map<
  string,
  { accountId: string; collectionId: string; metric: string; amount: number }
>

function sum(events: UsageEvent[]): Totals {
  const out: Totals = new Map()
  for (const e of events) {
    const k = `${e.a}\u0000${e.c ?? ''}\u0000${e.m}`
    const cur = out.get(k) ?? { accountId: e.a, collectionId: e.c ?? '', metric: e.m, amount: 0 }
    cur.amount += e.n
    out.set(k, cur)
  }
  return out
}

async function addRollups(ports: Ports, day: string, totals: Totals) {
  const { db } = ports
  const rows = [...totals.values()]
  // 5 bound parameters a row: 20 rows a statement stays under D1's 100.
  for (let i = 0; i < rows.length; i += 20) {
    await db
      .insert(schema.usageRollups)
      .values(rows.slice(i, i + 20).map((r) => ({ day, ...r })))
      .onConflictDoUpdate({
        target: [
          schema.usageRollups.day,
          schema.usageRollups.accountId,
          schema.usageRollups.collectionId,
          schema.usageRollups.metric,
        ],
        set: { amount: sql`${schema.usageRollups.amount} + excluded.amount` },
      })
  }
}

/** A day's rebuild in progress: where the listing is, and the totals so far. */
interface RebuildState {
  step: number
  cursor: string | null
  events: number
  totals: [string, { accountId: string; collectionId: string; metric: string; amount: number }][]
}

const rebuildKey = (day: string) => `usage-rebuild/${day}.json`

/**
 * One job of a day's rebuild: a page of log objects (a listing page, up to
 * 1,000) summed into the running totals, kept in the internal area between
 * jobs. Memory holds the totals (one per account, collection and metric), not
 * the events. The last page replaces the day's rollups. Returns the next step,
 * or null when done.
 */
export async function rebuildUsageStep(
  ports: Ports,
  day: string,
  step: number,
): Promise<number | null> {
  const store = ports.stores.internal
  const saved = step === 0 ? null : await store.get(rebuildKey(day))
  const state: RebuildState = saved
    ? (JSON.parse(await saved.text()) as RebuildState)
    : { step: 0, cursor: null, events: 0, totals: [] }
  if (state.step !== step) return null // a duplicate delivery
  const totals: Totals = new Map(state.totals)
  const page = await store.list(`${PREFIX}/${day}/`, state.cursor ?? undefined)
  for (const key of page.keys) {
    const obj = await store.get(key)
    if (!obj) continue
    const events = (await obj.text())
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as UsageEvent)
    state.events += events.length
    for (const [k, t] of sum(events)) {
      const cur = totals.get(k)
      if (cur) cur.amount += t.amount
      else totals.set(k, t)
    }
  }
  if (page.cursor) {
    const next: RebuildState = {
      step: step + 1,
      cursor: page.cursor,
      events: state.events,
      totals: [...totals],
    }
    await store.put(rebuildKey(day), JSON.stringify(next), { contentType: 'application/json' })
    return step + 1
  }
  await ports.db.delete(schema.usageRollups).where(eq(schema.usageRollups.day, day))
  await addRollups(ports, day, totals)
  await store.delete(rebuildKey(day)).catch(() => {})
  return null
}

/** Recompute one day's rollups from the log, all its steps in this call (tests, small days). */
export async function rebuildUsageDay(ports: Ports, day: string): Promise<number> {
  let events = 0
  const store = ports.stores.internal
  let cursor: string | undefined
  do {
    const page = await store.list(`${PREFIX}/${day}/`, cursor)
    for (const key of page.keys) {
      const obj = await store.get(key)
      if (obj) events += (await obj.text()).split('\n').filter(Boolean).length
    }
    cursor = page.cursor
  } while (cursor)
  for (let step: number | null = 0; step !== null;) step = await rebuildUsageStep(ports, day, step)
  return events
}

/** A day's rollups for an account (or every account). */
export async function usageFor(ports: Ports, day: string, accountId?: string) {
  return ports.db
    .select()
    .from(schema.usageRollups)
    .where(
      and(
        eq(schema.usageRollups.day, day),
        accountId ? eq(schema.usageRollups.accountId, accountId) : undefined,
      ),
    )
}

export const usageBatch = {
  /** How long an isolate holds events before sending them. */
  flushMs: 5_000,
  /** Events that go at once (a queue message is at most 128 KB; an event is ~150 bytes). */
  maxEvents: 400,
}

/** An isolate's unsent events (Workers): module state, shared by its requests. */
export interface UsageBuffer {
  events: UsageEvent[]
  scheduled: boolean
}

export const newUsageBuffer = (): UsageBuffer => ({ events: [], scheduled: false })

/**
 * Workers: an isolate's events go out together, one queue message per few
 * seconds instead of one per request. The first event into an empty buffer
 * schedules a send `flushMs` later on its request's waitUntil; a full buffer
 * goes at once. A send that fails is retried, then written straight to the log
 * (`fallback`), so a queue outage doesn't lose usage. An isolate evicted with
 * events still waiting loses them: at most `flushMs` of one isolate's.
 */
export function isolateUsageSink(
  buffer: UsageBuffer,
  waitUntil: (p: Promise<unknown>) => void,
  send: (events: UsageEvent[]) => Promise<void>,
  fallback: (events: UsageEvent[]) => Promise<void>,
): UsageSink {
  const flush = async () => {
    const out = buffer.events.splice(0, usageBatch.maxEvents)
    if (out.length === 0) return
    try {
      await send(out).catch(() => send(out))
    } catch (err) {
      console.error('[usage] send failed twice; writing the batch directly', err)
      await fallback(out).catch((e: unknown) => console.error('[usage] batch lost', e))
    }
  }
  return {
    record(events) {
      if (events.length === 0) return
      buffer.events.push(...events)
      if (buffer.events.length >= usageBatch.maxEvents) {
        waitUntil(flush())
      } else if (!buffer.scheduled) {
        buffer.scheduled = true
        waitUntil(
          new Promise((r) => setTimeout(r, usageBatch.flushMs)).then(async () => {
            buffer.scheduled = false
            while (buffer.events.length) await flush()
          }),
        )
      }
    },
  }
}

/**
 * Node: events buffered in the process and written every few seconds (or when
 * the buffer fills). A crash loses at most the unwritten buffer.
 */
export function bufferedUsageSink(ports: () => Ports, flushMs = 10_000, max = 5_000): UsageSink {
  let buf: UsageEvent[] = []
  const flush = async () => {
    if (buf.length === 0) return
    const out = buf
    buf = []
    try {
      await writeUsage(ports(), out)
    } catch (err) {
      console.error('[usage] write failed; events kept for the next flush', err)
      buf = [...out, ...buf]
    }
  }
  setInterval(() => void flush(), flushMs).unref?.()
  return {
    record(events) {
      buf.push(...events)
      if (buf.length >= max) void flush()
    },
  }
}

registerJob('usage.rebuild', async (job, ports) => {
  const day = String(job.day)
  const next = await rebuildUsageStep(ports, day, Number(job.step ?? 0))
  if (next !== null) await ports.jobs.enqueue({ type: 'usage.rebuild', day, step: next })
})
