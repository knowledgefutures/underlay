/** Tiny in-process TTL cache. Entries expire `ttlMs` after being set; the map is bounded. */
export function createTtlCache<V>(ttlMs: number, maxEntries = 1000, now: () => number = Date.now) {
  const entries = new Map<string, { value: V; expires: number }>()
  return {
    get(key: string): V | undefined {
      const hit = entries.get(key)
      if (!hit) return undefined
      if (hit.expires <= now()) {
        entries.delete(key)
        return undefined
      }
      return hit.value
    },
    set(key: string, value: V) {
      if (entries.size >= maxEntries && !entries.has(key)) {
        const t = now()
        for (const [k, e] of entries) if (e.expires <= t) entries.delete(k)
        // Still full: drop the oldest insertion.
        if (entries.size >= maxEntries) entries.delete(entries.keys().next().value!)
      }
      entries.set(key, { value, expires: now() + ttlMs })
    },
    delete(key: string) {
      entries.delete(key)
    },
  }
}
