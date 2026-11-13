/**
 * An external sort of plain lines, for jobs that work across a whole location
 * (the sweep). Lines are sorted in chunks that fit in memory, spilled to a
 * scratch store, and merged. Order is JavaScript string order, which for ASCII
 * is byte order, the order a store lists keys in.
 */
import { chunkLines, gunzipStream } from '../repo/gzip.js'
import { putFromParts, readParts, type Store } from '../repo/types.js'
import { gzipMember } from './gz.js'
import { equalParts, mergeSorted } from './util.js'

const enc = new TextEncoder()
const MEMBER = 1024 * 1024

/** Lines as gzip members of about 1 MiB of text each. */
export async function* gzipLines(
  lines: AsyncIterable<string> | Iterable<string>,
): AsyncGenerator<Uint8Array> {
  let held: string[] = []
  let n = 0
  for await (const line of lines) {
    held.push(line)
    n += line.length + 1
    if (n >= MEMBER) {
      yield await gzipMember(enc.encode(held.join('\n') + '\n'), 1)
      held = []
      n = 0
    }
  }
  if (held.length > 0) yield await gzipMember(enc.encode(held.join('\n') + '\n'), 1)
}

/** Write lines to an object, gzipped; an empty object for no lines. */
export async function writeLines(
  store: Store,
  key: string,
  lines: AsyncIterable<string> | Iterable<string>,
): Promise<void> {
  await putFromParts(store, key, equalParts(gzipLines(lines)))
}

/** Read the lines `writeLines` wrote, a part at a time; nothing if the object is absent. */
export async function* readLines(
  store: Store,
  key: string,
  partBytes = 1024 * 1024,
): AsyncGenerator<string> {
  const head = await store.head(key)
  if (!head || head.size === 0) return
  yield* chunkLines(gunzipStream(readParts(store, key, head.size, partBytes)))
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** Sort lines with bounded memory. Equal lines are all kept. */
export async function* sortLines(
  lines: AsyncIterable<string> | Iterable<string>,
  scratch: Store,
  opts: { memoryBytes?: number; fanIn?: number; prefix?: string } = {},
): AsyncGenerator<string> {
  const budget = opts.memoryBytes ?? 32 * 1024 * 1024
  const fanIn = Math.max(2, opts.fanIn ?? 48)
  const prefix = opts.prefix ?? `tmp/sort-${crypto.randomUUID()}/`
  let chunks: string[] = []
  let made = 0
  let held: string[] = []
  let weight = 0
  const spill = async (sorted: AsyncIterable<string> | Iterable<string>) => {
    const key = `${prefix}${String(made++).padStart(8, '0')}`
    await writeLines(scratch, key, sorted)
    return key
  }
  const merged = async function* (keys: string[]) {
    const part = Math.max(65_536, Math.floor((16 * 1024 * 1024) / keys.length))
    const streams = keys.map((k) => readLines(scratch, k, part))
    try {
      for await (const [line] of mergeSorted(streams, cmp)) yield line
    } finally {
      for (const s of streams) await s.return(undefined)
    }
  }
  try {
    for await (const line of lines) {
      held.push(line)
      weight += line.length * 2 + 50
      if (weight >= budget) {
        chunks.push(await spill(held.sort()))
        held = []
        weight = 0
      }
    }
    if (chunks.length === 0) {
      yield* held.sort()
      return
    }
    if (held.length > 0) chunks.push(await spill(held.sort()))
    held = []
    while (chunks.length > fanIn) {
      const next: string[] = []
      for (let i = 0; i < chunks.length; i += fanIn) {
        const group = chunks.slice(i, i + fanIn)
        next.push(group.length === 1 ? group[0]! : await spill(merged(group)))
        if (group.length > 1) for (const k of group) await scratch.delete(k)
      }
      chunks = next
    }
    yield* merged(chunks)
  } finally {
    for (const k of chunks) await scratch.delete(k).catch(() => {})
  }
}
