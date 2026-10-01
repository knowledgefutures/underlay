import { generateDDL } from './sqlite-gen.js'

/**
 * Single-flight: concurrent callers with the same key share one in-flight
 * promise instead of each doing the work. The entry is dropped when it settles,
 * so a failure is not remembered.
 */
export function createSingleFlight<T>() {
  const inflight = new Map<string, Promise<T>>()
  return (key: string, run: () => Promise<T>): Promise<T> => {
    const existing = inflight.get(key)
    if (existing) return existing
    const promise = run().finally(() => inflight.delete(key))
    inflight.set(key, promise)
    return promise
  }
}

/** DDL for every type, each followed by its sample row as a comment (for LLM context). */
export function ddlWithSamples(
  schemasMap: Record<string, any>,
  sampleRows: Record<string, Record<string, unknown>>,
): string {
  return Object.entries(schemasMap)
    .map(([name, s]) => {
      const tableDdl = generateDDL(name, s)
      const sample = sampleRows[name]
      return sample ? tableDdl + `\n-- Example row: ${JSON.stringify(sample)}` : tableDdl
    })
    .join('\n\n')
}
