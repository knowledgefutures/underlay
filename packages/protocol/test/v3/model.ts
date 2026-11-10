/**
 * A simple in-memory model of a collection, and a checker that every read the
 * engine offers agrees with it at every version. The model is the rule itself:
 * a version is its commits applied in order, the newest row for a key winning.
 */
import { expect } from 'vitest'

import { sha256Hex, type Store, v3 } from '../../src/index.js'
import { dec } from './helpers.js'

export interface ModelRow {
  kind: 'r' | 'x'
  type: string
  id: string
  line: string
  hash: string | null
  commit: number
}

const keyOf = (r: { type: string; id: string }) => JSON.stringify([r.type, r.id])

export class Model {
  /** Each commit's rows, by key. Index 0 is commit 1. */
  readonly commits: Map<string, ModelRow>[] = []

  add(rows: v3.LineRow[]): number {
    const commit = this.commits.length + 1
    const m = new Map<string, ModelRow>()
    for (const r of rows) {
      m.set(keyOf(r), {
        kind: r.kind,
        type: r.type,
        id: r.id,
        line: r.line,
        hash: r.kind === 'r' ? sha256Hex(r.line) : null,
        commit,
      })
    }
    this.commits.push(m)
    return commit
  }

  get head(): number {
    return this.commits.length
  }

  /** The newest row for each key at a version, removals included. */
  rowsAt(version: number): Map<string, ModelRow> {
    const out = new Map<string, ModelRow>()
    for (let c = 0; c < version; c++) for (const [k, r] of this.commits[c]!) out.set(k, r)
    return out
  }

  /** The records of a version, in key order. */
  recordsAt(version: number): ModelRow[] {
    return [...this.rowsAt(version).values()].filter((r) => r.kind === 'r').sort(v3.compareKey)
  }

  history(type: string, id: string, version: number): ModelRow[] {
    const out: ModelRow[] = []
    for (let c = version - 1; c >= 0; c--) {
      const r = this.commits[c]!.get(keyOf({ type, id }))
      if (r) out.push(r)
    }
    return out
  }

  /** Keys with a row in commits (since, version], with their row at `version`. */
  touched(since: number, version: number): ModelRow[] {
    const keys = new Set<string>()
    for (let c = since; c < version; c++) for (const k of this.commits[c]!.keys()) keys.add(k)
    const now = this.rowsAt(version)
    return [...keys].map((k) => now.get(k)!).sort(v3.compareKey)
  }

  allKeys(): { type: string; id: string }[] {
    const seen = new Map<string, { type: string; id: string }>()
    for (const m of this.commits) for (const [k, r] of m) seen.set(k, { type: r.type, id: r.id })
    return [...seen.values()].sort(v3.compareKey)
  }
}

const asModel = (r: v3.RecordRead) => ({
  type: r.type,
  id: r.id,
  hash: r.hash,
  commit: r.commit,
  line: r.line ? dec.decode(r.line) : null,
})
const wanted = (r: ModelRow) => ({
  type: r.type,
  id: r.id,
  hash: r.hash,
  commit: r.commit,
  line: r.line,
})

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of it) out.push(x)
  return out
}

export interface CheckOptions {
  /** Versions to check; default every one. */
  versions?: number[]
  /** Keys looked up one by one at each version; default every key ever written. */
  keys?: { type: string; id: string }[]
  cache?: v3.FileCache
  /** Rows the engine withholds: their lines read as null. */
  withheld?: (r: ModelRow) => boolean
}

/** Every read, at every version, against the model. */
export async function checkReads(
  store: Store,
  collection: string,
  model: Model,
  rand: () => number,
  opts: CheckOptions = {},
): Promise<void> {
  const cache = opts.cache ?? new v3.FileCache()
  const ro = { cache }
  const keys = opts.keys ?? model.allKeys()
  const want = (r: ModelRow) => (opts.withheld?.(r) ? { ...wanted(r), line: null } : wanted(r))
  const versions = opts.versions ?? Array.from({ length: model.head }, (_, i) => i + 1)
  const newest = await v3.openView(store, collection)
  expect(newest.head).toBe(model.head)
  for (const version of versions) {
    const view = await v3.openView(store, collection, { version })
    const records = model.recordsAt(version)
    const what = `version ${version}`

    // Export: every record, in key order.
    expect((await collect(v3.exportAll(store, view, {}, ro))).map(asModel), what).toEqual(
      records.map(want),
    )

    // Point reads: every key, present or not, and one that never existed.
    const rows = model.rowsAt(version)
    for (const k of keys) {
      const r = rows.get(keyOf(k))
      const got = await v3.getRecord(store, view, k.type, k.id, ro)
      expect(got ? asModel(got) : null, `${what} ${keyOf(k)}`).toEqual(
        r && r.kind === 'r' ? want(r) : null,
      )
    }
    expect(await v3.getRecord(store, view, 'none', 'none', ro)).toBe(null)

    // Pages: from a key, after a key, within a type, with a limit.
    for (let i = 0; i < 4; i++) {
      const pivot = keys[Math.floor(rand() * keys.length)] ?? { type: 'a', id: '' }
      const limit = 1 + Math.floor(rand() * 12)
      const from = records.filter((r) => v3.compareKey(r, pivot) >= 0).slice(0, limit)
      expect((await v3.page(store, view, { from: pivot, limit }, ro)).map(asModel), what).toEqual(
        from.map(want),
      )
      const after = records.filter((r) => v3.compareKey(r, pivot) > 0).slice(0, limit)
      expect((await v3.page(store, view, { after: pivot, limit }, ro)).map(asModel), what).toEqual(
        after.map(want),
      )
      const typed = records.filter((r) => r.type === pivot.type)
      expect(
        (await v3.page(store, view, { type: pivot.type, limit: 1_000_000 }, ro)).map(asModel),
        what,
      ).toEqual(typed.map(want))
      const typedAfter = typed.filter((r) => v3.compareKey(r, pivot) > 0).slice(0, limit)
      expect(
        (await v3.page(store, view, { type: pivot.type, after: pivot, limit }, ro)).map(asModel),
        what,
      ).toEqual(typedAfter.map(want))
    }

    // Counts per type.
    const counted = new Map<string, v3.TypeCount>()
    for (const r of records) {
      const t = counted.get(r.type) ?? { records: 0, bytes: 0 }
      t.records++
      t.bytes += new TextEncoder().encode(r.line).length
      counted.set(r.type, t)
    }
    expect(await v3.counts(store, view, {}, ro), what).toEqual(counted)

    // History of a few keys.
    for (let i = 0; i < 4 && keys.length > 0; i++) {
      const k = keys[Math.floor(rand() * keys.length)]!
      expect(await v3.history(store, view, k.type, k.id, ro), `${what} ${keyOf(k)}`).toEqual(
        model.history(k.type, k.id, version).map((r) => ({
          commit: r.commit,
          kind: opts.withheld?.(r) ? 'w' : r.kind,
          hash: r.hash,
          size: new TextEncoder().encode(r.line).length,
        })),
      )
    }

    // Changes since older versions: the keys touched, and with `before`, the real differences.
    const sinces = new Set([0, version - 1, Math.floor(rand() * version)])
    for (const since of sinces) {
      if (since < 0 || since >= version) continue
      if (since > 0 && opts.versions && !opts.versions.includes(since)) continue
      const touched = model.touched(since, version)
      const got = await collect(v3.changes(store, view, since, {}, ro))
      expect(
        got.map((c) => [c.type, c.id, c.after?.hash ?? null, c.after?.commit ?? null]),
        `${what} since ${since}`,
      ).toEqual(touched.map((r) => [r.type, r.id, r.hash, r.kind === 'r' ? r.commit : null]))
      for (const c of got.slice(0, 3)) {
        const line = await c.line()
        const r = touched.find((t) => t.type === c.type && t.id === c.id)!
        expect(line ? dec.decode(line) : null).toEqual(
          r.kind === 'r' && !opts.withheld?.(r) ? r.line : null,
        )
      }
      const before = model.rowsAt(since)
      const differ = touched
        .map((r) => {
          const b = before.get(keyOf(r))
          return [r.type, r.id, b && b.kind === 'r' ? b.hash : null, r.hash] as const
        })
        .filter(([, , b, a]) => a !== b)
      const diff = await collect(v3.changes(store, view, since, { before: true }, ro))
      expect(
        diff.map((c) => [c.type, c.id, c.before?.hash ?? null, c.after?.hash ?? null]),
        `${what} diff since ${since}`,
      ).toEqual(differ)
    }
  }
}

/** Random uploads over a small universe of keys, so commits overlap. */
export function randomUpload(rand: () => number, opts: { keys?: number; rows?: number } = {}) {
  const keys = opts.keys ?? 40
  const n = 1 + Math.floor(rand() * (opts.rows ?? 20))
  const rows = new Map<string, v3.LineRow>()
  for (let i = 0; i < n; i++) {
    const type = ['a', 'b', 'é', 'zz'][Math.floor(rand() * 4)]!
    const id = `k${String(Math.floor(rand() * keys)).padStart(3, '0')}`
    const roll = rand()
    const line =
      roll < 0.2
        ? JSON.stringify({ id, type, removed: true })
        : JSON.stringify({
            id,
            type,
            // Few distinct values, so some rows rewrite a record unchanged.
            data: { v: Math.floor(rand() * 4), pad: 'p'.repeat(Math.floor(rand() * 5) * 40) },
          })
    const row = v3.parseInputLine(line)
    rows.set(keyOf(row), { kind: row.kind, type: row.type, id: row.id, line: row.line })
  }
  return [...rows.values()].sort(v3.compareKey)
}

/** Build rows into files and commit them: one upload. */
export async function commitRows(
  store: Store,
  collection: string,
  rows: v3.LineRow[],
  opts: v3.BuildOptions = {},
): Promise<v3.StoredCommit> {
  const files = await v3.buildFiles(rows, v3.storeTarget(store), opts)
  return v3.createCommit(store, collection, {
    files: files.map(({ size: _s, labeled: _l, commits: _c, ...ref }) => ref),
    bump: 'minor',
  })
}
