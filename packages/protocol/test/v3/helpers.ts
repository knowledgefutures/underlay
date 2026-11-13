import { hashRecord, memoryStore, type MemoryStore, v3 } from '../../src/index.js'

export const rec = (type: string, id: string, data: unknown, commit?: number): v3.WriteRow => ({
  kind: 'r',
  type,
  id,
  line: hashRecord(id, type, data).canonical,
  ...(commit === undefined ? {} : { commit }),
})

export const rem = (type: string, id: string, commit?: number): v3.WriteRow => ({
  kind: 'x',
  type,
  id,
  line: v3.removalLine(id, type),
  ...(commit === undefined ? {} : { commit }),
})

export const sortRows = <T extends { type: string; id: string; commit?: number }>(rows: T[]) =>
  rows.sort(
    (a, b) => v3.compareKeys(a.type, a.id, b.type, b.id) || (a.commit ?? 0) - (b.commit ?? 0),
  )

/** Write rows as one file into a memory store at `records/<id>`. */
export async function putFile(
  store: MemoryStore,
  rows: v3.WriteRow[],
  opts: v3.WriterOptions = {},
): Promise<v3.WrittenFile & { key: string }> {
  const f = await v3.writeFileBytes(rows, opts)
  const key = `records/${f.id}`
  await store.put(key, f.bytes)
  return { id: f.id, content: f.content, size: f.size, key }
}

export { memoryStore }

/** A deterministic pseudo-random generator (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const dec = new TextDecoder()
