/**
 * Rewriting v3 collections into the protocol's one spelling (docs/protocol/v3.md, Appendix D;
 * the library's half is `v3.rewriteCollection`). It runs where the collection's commits
 * land (`CommitQueue.rewrite`), so no commit lands meanwhile. Then D1 follows the log: each
 * rewritten version's row takes its new id, and keeps the old one in `former_hash`, which
 * the read API still resolves. The description is brought up to date too (`public`, and the
 * key that now signs every commit).
 *
 * A converted record has a new hash, so a record on the denylist is denied under its new hash
 * too. Mirrors copy the rewritten log again from commit 1, and a rewrite that wrote files
 * again queues a rebuild, since its layout lists every commit's own files.
 *
 * Running it again over a rewritten collection changes nothing, and finishes one that
 * stopped part way. A stewards' route runs it for one collection or queues it for all
 * (api/admin.ts); a v2 collection flipped to v3 is rewritten before its first rebuild.
 */
import { v3 } from '@underlay/protocol'
import { and, eq, sql } from 'drizzle-orm'

import { chunks } from '../db/chunks.js'
import * as schema from '../db/schema.js'
import { registerJob } from '../jobs.js'
import { forgetDenylist } from '../lib/limits.js'
import { collectionMirrors } from '../locations/mirror.js'
import type { Ports } from '../ports.js'
import { syncDescription } from './authority.js'
import { commitsOf } from './queue.js'

/**
 * Most bytes of files read into memory when records must be converted: a Durable Object has
 * 128 MB, and lines held as strings take about twice their bytes.
 */
export const REWRITE_SCAN_BYTES = 24 * 1024 * 1024

/** Versions updated per statement: each is ~150 bytes of one JSON parameter (2 MB at most). */
const VERSIONS_PER_UPDATE = 2_000

export interface RewriteOutcome {
  collectionId: string
  /** Why nothing was done. */
  skipped?: string
  /** What the rewrite refused, and why. */
  error?: string
  /** Commits whose id changed. */
  rewritten?: number
  records?: number
  /** Schemas whose `$file` properties became `$asset`. */
  schemas?: number
  files?: number
  layout?: number | null
  dryRun?: boolean
}

/** Rewrite one collection. Called where its commits land (queue.ts). */
export async function rewriteV3(
  ports: Ports,
  collectionId: string,
  opts: { dryRun?: boolean } = {},
): Promise<RewriteOutcome> {
  const [row] = await ports.db
    .select({ layout: schema.collections.recordLayout })
    .from(schema.collections)
    .where(eq(schema.collections.id, collectionId))
  if (!row) return { collectionId, skipped: 'No such collection' }
  if (row.layout !== 'v3') return { collectionId, skipped: 'Not a v3 collection' }
  const store = ports.stores.v3
  const denied = await ports.db
    .select({ hash: schema.denylist.hash })
    .from(schema.denylist)
    .where(eq(schema.denylist.kind, 'record'))
  let plan: v3.RewritePlan
  try {
    plan = await v3.rewriteCollection(store, collectionId, {
      signer: await ports.signer(),
      maxScanBytes: REWRITE_SCAN_BYTES,
      denied: new Set(denied.map((d) => d.hash)),
      ...(opts.dryRun ? { dryRun: true } : {}),
    })
  } catch (err) {
    if (err instanceof v3.RewriteError) return { collectionId, error: err.message }
    throw err
  }
  const changed = plan.commits.filter((c) => c.before !== c.after)
  const outcome: RewriteOutcome = {
    collectionId,
    rewritten: changed.length,
    records: plan.records,
    schemas: plan.schemas.length,
    files: plan.files,
    layout: plan.layout,
    ...(opts.dryRun ? { dryRun: true } : {}),
  }
  if (opts.dryRun) return outcome

  // A denied record is denied under its new hash too, for the same reason.
  for (const d of plan.denied ?? []) {
    const [row] = await ports.db
      .select({ reason: schema.denylist.reason })
      .from(schema.denylist)
      .where(eq(schema.denylist.hash, d.before))
    await ports.db
      .insert(schema.denylist)
      .values({ hash: d.after, kind: 'record', reason: row?.reason ?? 'Denied before a rewrite' })
      .onConflictDoNothing()
  }
  if (plan.denied?.length) forgetDenylist(ports.db)

  // D1 follows the log, every row by number: a row still spelled `ulv3:` takes `ul:ver:`. One
  // statement a few thousand versions, so a long log stays far inside a Worker's queries.
  for (const part of chunks(plan.commits, VERSIONS_PER_UPDATE)) {
    const rows = JSON.stringify(part.map((c) => ({ n: c.number, b: c.before, a: c.after })))
    const v = schema.versions
    await ports.db
      .update(v)
      .set({
        hash: sql`'ul:ver:' || (SELECT json_extract(j.value, '$.a') FROM json_each(${rows}) j
          WHERE json_extract(j.value, '$.n') = ${v.seq})`,
        formerHash: sql`COALESCE((SELECT 'ul:ver:' || json_extract(j.value, '$.b')
          FROM json_each(${rows}) j WHERE json_extract(j.value, '$.n') = ${v.seq}
            AND json_extract(j.value, '$.b') != json_extract(j.value, '$.a')), ${v.formerHash})`,
      })
      .where(
        and(
          eq(v.collectionId, collectionId),
          sql`${v.seq} IN (SELECT json_extract(value, '$.n') FROM json_each(${rows}))`,
        ),
      )
  }
  // A schema written for `$file` has a new hash: the collection uses it now, and its labels
  // carry over to it.
  for (const s of plan.schemas) {
    await ports.db.insert(schema.schemas).values({ hash: s.after }).onConflictDoNothing()
    await ports.db
      .update(schema.schemaUsage)
      .set({ schemaHash: s.after })
      .where(
        and(
          eq(schema.schemaUsage.collectionId, collectionId),
          eq(schema.schemaUsage.typeSlug, s.type),
          eq(schema.schemaUsage.schemaHash, s.before),
        ),
      )
    const labels = await ports.db
      .select({ label: schema.schemaLabels.label })
      .from(schema.schemaLabels)
      .where(eq(schema.schemaLabels.schemaHash, s.before))
    for (const l of labels) {
      await ports.db
        .insert(schema.schemaLabels)
        .values({ schemaHash: s.after, label: l.label })
        .onConflictDoNothing()
    }
  }
  await syncDescription(ports, collectionId)

  // A mirror holds the old commits: copy the log again from commit 1 (files it has are kept).
  if (changed.length > 0) {
    for (const p of await collectionMirrors(ports, collectionId)) {
      await ports.db
        .update(schema.placements)
        .set({ syncedSeq: 0, cursor: null, state: 'backfilling', updatedAt: new Date() })
        .where(eq(schema.placements.id, p.id))
      if (p.state !== 'paused') {
        await ports.jobs.enqueue({ type: 'mirror.version', placementId: p.id })
      }
    }
  }
  return outcome
}

/** Queue a rewrite of every v3 collection, one job each. */
export async function queueRewrites(ports: Ports, opts: { dryRun?: boolean } = {}) {
  const rows = await ports.db
    .select({ id: schema.collections.id })
    .from(schema.collections)
    .where(eq(schema.collections.recordLayout, 'v3'))
  for (const r of rows) {
    await ports.jobs.enqueue({
      type: 'v3.rewrite',
      collectionId: r.id,
      ...(opts.dryRun ? { dryRun: true } : {}),
    })
  }
  return rows.length
}

const OUTCOMES = 'rewrite/'

/** Keep a rewrite's outcome, for the stewards' list. */
export async function keepRewriteOutcome(ports: Ports, outcome: RewriteOutcome): Promise<void> {
  await ports.stores.internal.put(
    `${OUTCOMES}${outcome.collectionId}.json`,
    JSON.stringify({ ...outcome, at: new Date().toISOString() }),
    { contentType: 'application/json' },
  )
}

/** Every outcome kept, with the collection's owner and slug. */
export async function rewriteOutcomes(ports: Ports) {
  const out: (RewriteOutcome & { at: string; collection: string | null })[] = []
  let cursor: string | undefined
  do {
    const page = await ports.stores.internal.list(OUTCOMES, cursor)
    for (const key of page.keys) {
      const obj = await ports.stores.internal.get(key)
      if (obj)
        out.push({
          ...(JSON.parse(await obj.text()) as RewriteOutcome & { at: string }),
          collection: null,
        })
    }
    cursor = page.cursor
  } while (cursor !== undefined)
  const names = await ports.db
    .select({
      id: schema.collections.id,
      slug: schema.collections.slug,
      owner: schema.organization.slug,
    })
    .from(schema.collections)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.collections.organizationId))
  const byId = new Map(names.map((n) => [n.id, `${n.owner}/${n.slug}`]))
  for (const o of out) o.collection = byId.get(o.collectionId) ?? null
  return out
}

registerJob('v3.rewrite', async (job, ports) => {
  const id = String(job.collectionId)
  const outcome = await commitsOf(ports).rewrite(ports, id, { dryRun: job.dryRun === true })
  await keepRewriteOutcome(ports, outcome)
  console.log(`[v3.rewrite] ${JSON.stringify(outcome)}`)
  // Files written again sit one set a commit; and a flip from v2 asked for its rebuild here.
  if (!outcome.dryRun && ((outcome.files ?? 0) > 0 || job.rebuild === true)) {
    await ports.jobs.enqueue({ type: 'v3.rebuild', collectionId: id })
  }
})
