/**
 * Sorted runs: how push sessions hold uploaded data until commit (the external
 * sort of edge-redesign-build.md finding 11).
 *
 * Each upload batch becomes one run, sorted by (type, id). A run is a list of
 * gzip blocks of about 1 MB raw each, in the platform's internal area:
 *
 *   sessions/<sessionId>/runs/<seq>/<block>.ndjson.gz
 *   sessions/<sessionId>/runs/<seq>/index.json      [{first, last, count}, …] per block
 *
 * Blocks are fetched whole, so a reader holds one block per run, and the index
 * lets a reader skip to the blocks covering one type. Merging is bounded by a
 * fan-in; sessions with more runs are compacted first (compactRuns), merging
 * groups into bigger runs written block by block, so memory never depends on
 * push size.
 */
import { compareUtf8 } from '@underlay/core'
import { gunzipText, gzip, splitLines } from '@underlay/repo'

import type { BlobStore } from '../ports.js'

/** One entry of a run. `k` is the record id, `t` the type. */
export interface RunEntry {
  t: string
  k: string
  /** Record hash (records and manifest runs). */
  h?: string
  /** Format 1 hash the client used, when it differs (negotiate compatibility). */
  lh?: string
  /** Canonical record size in bytes. */
  s?: number
  /** Pushed as private. */
  p?: boolean
  /** The canonical record (records runs). */
  b?: string
  /** A delete (delta deletes runs). */
  x?: boolean
}

export interface RunIndex {
  seq: number
  blocks: { first: string; last: string; count: number }[]
}

export const BLOCK_BYTES = 1024 * 1024
export const MERGE_FAN_IN = 16

/** Sort key: type, then id, by UTF-8 bytes. A NUL separator keeps types apart. */
export const runKey = (e: { t: string; k: string }) => `${e.t}\u0000${e.k}`
export const compareRunKeys = (a: RunEntry, b: RunEntry) =>
  compareUtf8(a.t, b.t) || compareUtf8(a.k, b.k)

const runPrefix = (sessionId: string, seq: number) => `sessions/${sessionId}/runs/${seq}`

/** Writes one run block by block. Entries must arrive sorted. */
export class RunWriter {
  readonly #blocks: RunIndex['blocks'] = []
  #lines: string[] = []
  #first: string | null = null
  #last: string | null = null
  #bytes = 0
  #pending: Promise<void>[] = []

  constructor(
    readonly store: BlobStore,
    readonly sessionId: string,
    readonly seq: number,
  ) {}

  add(e: RunEntry): void {
    const key = runKey(e)
    if (this.#last !== null && compareUtf8(this.#last, key) >= 0) {
      throw new Error(`Run entries out of order at ${JSON.stringify(key)}`)
    }
    const line = JSON.stringify(e)
    this.#first ??= key
    this.#last = key
    this.#lines.push(line)
    this.#bytes += line.length
    if (this.#bytes >= BLOCK_BYTES) this.#flushBlock()
  }

  #flushBlock() {
    if (this.#lines.length === 0) return
    const n = this.#blocks.length
    const text = this.#lines.join('\n') + '\n'
    this.#blocks.push({ first: this.#first!, last: this.#last!, count: this.#lines.length })
    this.#lines = []
    this.#bytes = 0
    this.#first = null
    const key = `${runPrefix(this.sessionId, this.seq)}/${n}.ndjson.gz`
    this.#pending.push(
      gzip(text).then((gz) => this.store.put(key, gz, { contentType: 'application/gzip' })),
    )
  }

  /** Bounded memory: callers writing large runs await this between entries. */
  async drain(): Promise<void> {
    if (this.#pending.length >= 4) await Promise.all(this.#pending.splice(0))
  }

  async finish(): Promise<RunIndex> {
    this.#flushBlock()
    await Promise.all(this.#pending.splice(0))
    const index: RunIndex = { seq: this.seq, blocks: this.#blocks }
    await this.store.put(
      `${runPrefix(this.sessionId, this.seq)}/index.json`,
      JSON.stringify(index),
      {
        contentType: 'application/json',
      },
    )
    return index
  }
}

/** Write an in-memory batch (one upload request) as a run. */
export async function writeRun(
  store: BlobStore,
  sessionId: string,
  seq: number,
  entries: RunEntry[],
) {
  entries.sort(compareRunKeys)
  // Within one batch the last occurrence of a key wins.
  const w = new RunWriter(store, sessionId, seq)
  for (let i = 0; i < entries.length; i++) {
    const next = entries[i + 1]
    if (next && compareRunKeys(entries[i]!, next) === 0) continue
    w.add(entries[i]!)
  }
  return w.finish()
}

export async function readRunIndex(
  store: BlobStore,
  sessionId: string,
  seq: number,
): Promise<RunIndex> {
  const obj = await store.get(`${runPrefix(sessionId, seq)}/index.json`)
  if (!obj) throw new Error(`Run ${seq} of session ${sessionId} is missing`)
  return JSON.parse(await obj.text()) as RunIndex
}

/**
 * Entries of one run in order, optionally limited to one type. Reads one block
 * at a time and fetches the next while the current one is consumed.
 */
export async function* readRun(
  store: BlobStore,
  sessionId: string,
  index: RunIndex,
  type?: string,
): AsyncGenerator<RunEntry> {
  const blocks = index.blocks
    .map((b, i) => ({ ...b, i }))
    .filter(
      (b) =>
        type === undefined ||
        (compareUtf8(b.first.split('\u0000')[0]!, type) <= 0 &&
          compareUtf8(b.last.split('\u0000')[0]!, type) >= 0),
    )
  const load = async (i: number) => {
    const obj = await store.get(`${runPrefix(sessionId, index.seq)}/${i}.ndjson.gz`)
    if (!obj) throw new Error(`Run block ${index.seq}/${i} of session ${sessionId} is missing`)
    return splitLines(await gunzipText(await obj.bytes()))
  }
  let next = blocks[0] ? load(blocks[0].i) : null
  for (let j = 0; j < blocks.length; j++) {
    const lines = await next!
    next = blocks[j + 1] ? load(blocks[j + 1]!.i) : null
    next?.catch(() => {})
    for (const line of lines) {
      const e = JSON.parse(line) as RunEntry
      if (type === undefined || e.t === type) yield e
    }
  }
}

/**
 * K-way merge of runs (at most MERGE_FAN_IN) by (type, id). On equal keys the
 * run with the higher seq wins: later uploads replace earlier ones.
 */
export async function* mergeRuns(
  store: BlobStore,
  sessionId: string,
  indexes: RunIndex[],
  type?: string,
): AsyncGenerator<RunEntry> {
  if (indexes.length > MERGE_FAN_IN)
    throw new Error(`mergeRuns: ${indexes.length} runs; compact first`)
  const cursors = await Promise.all(
    indexes.map(async (ix) => {
      const it = readRun(store, sessionId, ix, type)
      return { seq: ix.seq, it, head: await it.next() }
    }),
  )
  for (;;) {
    let best: (typeof cursors)[number] | null = null
    for (const c of cursors) {
      if (c.head.done) continue
      if (!best) {
        best = c
        continue
      }
      const cmp = compareRunKeys(c.head.value, best.head.value as RunEntry)
      if (cmp < 0 || (cmp === 0 && c.seq > best.seq)) best = c
    }
    if (!best) return
    const winner = best.head.value as RunEntry
    // Advance every cursor sitting on the same key; the winner's entry is emitted.
    for (const c of cursors) {
      while (!c.head.done && compareRunKeys(c.head.value, winner) === 0) c.head = await c.it.next()
    }
    yield winner
  }
}

/**
 * Merge groups of runs until at most MERGE_FAN_IN remain. Returns the new run
 * list. Each merged run takes the highest seq of its group, so "later wins" is
 * preserved; new seqs start at `nextSeq`.
 */
export async function compactRuns(
  store: BlobStore,
  sessionId: string,
  indexes: RunIndex[],
  nextSeq: number,
): Promise<RunIndex[]> {
  let runs = indexes.slice().sort((a, b) => a.seq - b.seq)
  let seq = nextSeq
  while (runs.length > MERGE_FAN_IN) {
    // Group from the newest end, so the only group that can be a lone,
    // unmerged run is the oldest one: it keeps its low seq and still loses to
    // every merged run, which all get fresh seqs in age order.
    const groups: RunIndex[][] = []
    for (let end = runs.length; end > 0; end -= MERGE_FAN_IN) {
      groups.unshift(runs.slice(Math.max(0, end - MERGE_FAN_IN), end))
    }
    const out: RunIndex[] = []
    for (const group of groups) {
      if (group.length === 1) {
        out.push(group[0]!)
        continue
      }
      const w = new RunWriter(store, sessionId, seq++)
      for await (const e of mergeRuns(store, sessionId, group)) {
        w.add(e)
        await w.drain()
      }
      out.push(await w.finish())
    }
    runs = out
  }
  return runs
}
