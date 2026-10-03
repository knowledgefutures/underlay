/**
 * A byte-budgeted LRU for the isolate (or process). Holds immutable, hash-keyed
 * things — roots, interior nodes, decoded leaves — so a busy collection's upper
 * tree stays in memory across requests.
 */
export class Lru<V> {
  readonly #map = new Map<string, { value: V; size: number }>()
  #bytes = 0

  constructor(
    readonly budget: number,
    readonly sizeOf: (v: V) => number,
  ) {}

  get(key: string): V | undefined {
    const hit = this.#map.get(key)
    if (!hit) return undefined
    this.#map.delete(key)
    this.#map.set(key, hit)
    return hit.value
  }

  set(key: string, value: V): void {
    const size = this.sizeOf(value)
    if (size > this.budget / 4) return // never let one item flush the cache
    const old = this.#map.get(key)
    if (old) {
      this.#bytes -= old.size
      this.#map.delete(key)
    }
    this.#map.set(key, { value, size })
    this.#bytes += size
    while (this.#bytes > this.budget) {
      const oldest = this.#map.keys().next().value as string
      this.#bytes -= this.#map.get(oldest)!.size
      this.#map.delete(oldest)
    }
  }

  get bytes(): number {
    return this.#bytes
  }
}
