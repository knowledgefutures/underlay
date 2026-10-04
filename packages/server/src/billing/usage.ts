/**
 * The usage log (edge-redesign.md, "Metering, and rebuilding the counters"):
 * what requests use, which version data can't tell. API calls and response
 * bytes per collection, and file downloads and their bytes.
 *
 * A request's events travel together (one queue message on Workers; a buffer
 * on Node) and land in immutable `usage/<day>/<id>.ndjson` objects in the
 * internal area, a batch at a time. `usage_rollups` are added to as each batch
 * lands. Delivery is at least once, so a retried batch can count twice there;
 * the log can't, because every event carries its request id and position, and
 * `rebuildUsageDay` recomputes a day's rollups from it. Keep the log for at
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
    await ports.stores.internal.put(
      `${PREFIX}/${day}/${Date.now()}-${crypto.randomUUID()}.ndjson`,
      list.map((e) => JSON.stringify(e)).join('\n') + '\n',
      { contentType: 'application/x-ndjson' },
    )
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

/** Recompute one day's rollups from the log, counting each event once. */
export async function rebuildUsageDay(ports: Ports, day: string): Promise<number> {
  const store = ports.stores.internal
  const seen = new Set<string>()
  const events: UsageEvent[] = []
  let cursor: string | undefined
  do {
    const page = await store.list(`${PREFIX}/${day}/`, cursor)
    for (const key of page.keys) {
      const obj = await store.get(key)
      if (!obj) continue
      for (const line of (await obj.text()).split('\n')) {
        if (!line) continue
        const e = JSON.parse(line) as UsageEvent
        const id = `${e.r}\u0000${e.i}`
        if (seen.has(id)) continue
        seen.add(id)
        events.push(e)
      }
    }
    cursor = page.cursor
  } while (cursor)
  await ports.db.delete(schema.usageRollups).where(eq(schema.usageRollups.day, day))
  await addRollups(ports, day, sum(events))
  return events.length
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
  await rebuildUsageDay(ports, String(job.day))
})
