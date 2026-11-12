/**
 * Schema scans (v3-deploy-plan.md, Phase 2): when a change tightens a type's schema, every
 * record the head carries over into the change must satisfy the new one (protocol-v3 4.5).
 * The scan runs before landing, so landing stays short (it no longer scans: the head it
 * lands on is the one scanned). A scan of up to `inlineRecords` runs in the job preparing
 * the change; a larger one is cut into key ranges of the type, a `v3.scanUnit` job each,
 * and the change goes on when the last unit passes.
 *
 * A scan's state is `v3-scans/<id>.json` in the internal area, its units' results beside
 * it. What happens when it passes is `then`: land a push session's change and settle the
 * session, or count toward a client upload's verification.
 */
import { createObject, hashSchema, schemaRelaxes, v3 } from '@underlay/protocol'

import { registerJob } from '../jobs.js'
import type { Ports } from '../ports.js'
import { schemasOf } from './catalog.js'

export const scanConfig = {
  /** Records a preparing job scans itself; above this, the scan is cut into units. */
  inlineRecords: 200_000,
  /** Records a unit scans. */
  unitRecords: 250_000,
}

/** A type whose records the change keeps must be checked against: its new schema, or null. */
export interface Tightened {
  type: string
  schema: unknown | null
}

/** The types a change tightens: a schema that is new and does not only relax, or removed. */
export async function tightenedTypes(
  ports: Ports,
  view: v3.View | null,
  after: Record<string, unknown>,
): Promise<Tightened[]> {
  if (!view) return []
  const before = await schemasOf(ports.stores.v3, view)
  const out: Tightened[] = []
  for (const [type, body] of Object.entries(before)) {
    const next = after[type]
    if (next === undefined) out.push({ type, schema: null })
    else if (hashSchema(next) !== hashSchema(body) && !schemaRelaxes(body, next))
      out.push({ type, schema: next })
  }
  return out
}

/** A unit of a scan: one type, one stretch of its ids. */
export interface ScanUnit {
  type: string
  schema: unknown | null
  from?: string
  to?: string
}

/** Cut each type into stretches of about `unitRecords`, by its key blocks' first ids. */
export async function scanUnits(
  ports: Ports,
  view: v3.View,
  types: Tightened[],
): Promise<ScanUnit[]> {
  const store = ports.stores.v3
  const cache = new v3.FileCache(16 * 1024 * 1024)
  const units: ScanUnit[] = []
  for (const t of types) {
    const marks: { id: string; entries: number }[] = []
    for (const f of view.files) {
      if (!f.first || !f.last) continue
      if (
        v3.compareKeys(f.first[0], '', t.type, '') > 0 ||
        v3.compareKeys(t.type, '', f.last[0], '') > 0
      )
        continue
      const file = await cache.open(store, f.id)
      for (const b of file.content.keyBlocks)
        if (b[0] === t.type) marks.push({ id: b[1], entries: b[3] })
    }
    marks.sort((a, b) => v3.compareKeys(t.type, a.id, t.type, b.id))
    let from: string | undefined
    let acc = 0
    for (const m of marks) {
      if (acc >= scanConfig.unitRecords && (from === undefined || m.id > from)) {
        units.push({
          type: t.type,
          schema: t.schema,
          ...(from !== undefined ? { from } : {}),
          to: m.id,
        })
        from = m.id
        acc = 0
      }
      acc += m.entries
    }
    units.push({ type: t.type, schema: t.schema, ...(from !== undefined ? { from } : {}) })
  }
  return units
}

/** Scan units here, one after another; the problems found, if any. */
export async function scanInline(
  ports: Ports,
  view: v3.View,
  upload: { files: v3.FileRef[]; session: string },
  units: ScanUnit[],
): Promise<string[]> {
  const problems: string[] = []
  const cache = new v3.FileCache(16 * 1024 * 1024)
  for (const u of units) {
    const r = await scanOne(ports, view, upload, u, cache)
    problems.push(...r)
    if (problems.length >= 20) break
  }
  return problems
}

async function scanOne(
  ports: Ports,
  view: v3.View,
  upload: { files: v3.FileRef[]; session: string },
  u: ScanUnit,
  cache: v3.FileCache,
): Promise<string[]> {
  const r = await v3.scanUnderSchema(
    ports.stores.v3,
    view,
    { files: upload.files, locate: (id) => v3.uploadKey(upload.session, id) },
    u.type,
    u.schema,
    {
      ...(u.from !== undefined ? { from: u.from } : {}),
      ...(u.to !== undefined ? { to: u.to } : {}),
    },
    { cache },
  )
  return r.problems
}

/** What a passed (or failed) scan leads to. */
export type ScanThen =
  | { kind: 'push'; sessionId: string }
  | { kind: 'upload'; uploadId: string; head: string | null }

export interface ScanState {
  id: string
  collectionId: string
  /** The version scanned: the head the change is prepared against. */
  version: number
  upload: { files: v3.FileRef[]; session: string }
  units: ScanUnit[]
  then: ScanThen
}

const stateKey = (id: string) => `v3-scans/${id}.json`
const unitKey = (id: string, i: number) => `v3-scans/${id}/unit-${String(i).padStart(5, '0')}.json`

export async function readScan(ports: Ports, id: string): Promise<ScanState | null> {
  const obj = await ports.stores.internal.get(stateKey(id))
  return obj ? (JSON.parse(await obj.text()) as ScanState) : null
}

/** Start a scan in units: its state, then a job for each unit. */
export async function startScan(ports: Ports, state: ScanState): Promise<void> {
  await ports.stores.internal.put(stateKey(state.id), JSON.stringify(state))
  await ports.jobs.enqueueBatch(
    state.units.map((_, unit) => ({ type: 'v3.scanUnit', scanId: state.id, unit })),
  )
}

/** The problems each finished unit found, or null while any is still running. */
export async function scanResults(ports: Ports, state: ScanState): Promise<string[] | null> {
  const problems: string[] = []
  for (let i = 0; i < state.units.length; i++) {
    const obj = await ports.stores.internal.get(unitKey(state.id, i))
    if (!obj) return null
    problems.push(...(JSON.parse(await obj.text()) as { problems: string[] }).problems)
  }
  return problems
}

/** Forget a finished scan. */
export async function dropScan(ports: Ports, state: ScanState): Promise<void> {
  const internal = ports.stores.internal
  await v3.inParallel(
    state.units.map((_, i) => () => internal.delete(unitKey(state.id, i))),
    8,
  )
  await internal.delete(stateKey(state.id))
}

/** Handlers for a finished scan, by `then.kind`: set by the push and upload modules. */
export const scanFinished: Partial<
  Record<ScanThen['kind'], (ports: Ports, state: ScanState, problems: string[]) => Promise<void>>
> = {}

registerJob('v3.scanUnit', async (job, ports) => {
  const state = await readScan(ports, String(job.scanId))
  if (!state) return
  const i = Number(job.unit)
  const key = unitKey(state.id, i)
  if (!(await ports.stores.internal.head(key))) {
    const view = await v3.openView(ports.stores.v3, state.collectionId, { version: state.version })
    const problems = await scanOne(
      ports,
      view,
      state.upload,
      state.units[i]!,
      new v3.FileCache(16 * 1024 * 1024),
    )
    // Written once: the job that writes it is the one that may finish the scan.
    if (!(await createObject(ports.stores.internal, key, JSON.stringify({ problems })))) return
  }
  const problems = await scanResults(ports, state)
  if (problems === null) return
  // Every unit is in; exactly one job gets here first and takes the finish.
  if (!(await createObject(ports.stores.internal, `v3-scans/${state.id}/finished`, '1'))) return
  await scanFinished[state.then.kind]?.(ports, state, problems)
  await dropScan(ports, state)
  await ports.stores.internal.delete(`v3-scans/${state.id}/finished`)
})
