/** Small pieces the v3 jobs share: parallel work, merging sorted streams, equal upload parts. */

/** Run jobs with at most `n` in flight; results in job order. */
export async function inParallel<T>(jobs: (() => Promise<T>)[], n: number): Promise<T[]> {
  const out = Array.from<T>({ length: jobs.length })
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(n, jobs.length) }, async () => {
      while (next < jobs.length) {
        const i = next++
        out[i] = await jobs[i]!()
      }
    }),
  )
  return out
}

/** A binary min-heap. */
export class Heap<T> {
  readonly #items: T[] = []
  constructor(readonly less: (a: T, b: T) => boolean) {}
  get size(): number {
    return this.#items.length
  }
  peek(): T | undefined {
    return this.#items[0]
  }
  push(item: T): void {
    const a = this.#items
    let i = a.length
    a.push(item)
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (!this.less(a[i]!, a[parent]!)) break
      ;[a[i], a[parent]] = [a[parent]!, a[i]!]
      i = parent
    }
  }
  pop(): T | undefined {
    const a = this.#items
    const top = a[0]
    const last = a.pop()
    if (a.length > 0 && last !== undefined) {
      a[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < a.length && this.less(a[l]!, a[m]!)) m = l
        if (r < a.length && this.less(a[r]!, a[m]!)) m = r
        if (m === i) break
        ;[a[i], a[m]] = [a[m]!, a[i]!]
        i = m
      }
    }
    return top
  }
}

/**
 * Merge sorted streams into one sorted stream of [item, index of its stream].
 * Ties come out in stream order. Memory: one item per stream.
 */
export async function* mergeSorted<T>(
  streams: AsyncIterator<T>[],
  compare: (a: T, b: T) => number,
): AsyncGenerator<[T, number]> {
  const heap = new Heap<{ item: T; src: number }>((a, b) => {
    const c = compare(a.item, b.item)
    return c < 0 || (c === 0 && a.src < b.src)
  })
  for (let i = 0; i < streams.length; i++) {
    const r = await streams[i]!.next()
    if (!r.done) heap.push({ item: r.value, src: i })
  }
  while (heap.size > 0) {
    const top = heap.pop()!
    yield [top.item, top.src]
    const r = await streams[top.src]!.next()
    if (!r.done) heap.push({ item: r.value, src: top.src })
  }
}

/** The size of every upload part but the last. R2 wants them equal; S3 wants at least 5 MiB. */
export const PART_BYTES = 8 * 1024 * 1024

/** Re-cut chunks into parts of exactly `size` bytes; the last may be shorter. */
export async function* equalParts(
  chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  size = PART_BYTES,
): AsyncGenerator<Uint8Array> {
  let part = new Uint8Array(size)
  let filled = 0
  for await (const chunk of chunks) {
    let at = 0
    while (at < chunk.byteLength) {
      const take = Math.min(size - filled, chunk.byteLength - at)
      part.set(chunk.subarray(at, at + take), filled)
      filled += take
      at += take
      if (filled === size) {
        yield part
        part = new Uint8Array(size)
        filled = 0
      }
    }
  }
  if (filled > 0) yield part.subarray(0, filled)
}

/**
 * Chunks pushed by a writer, pulled as an async iterable by an upload. `write`
 * resolves when the chunk has been taken, so the writer never runs ahead.
 */
export class Channel implements AsyncIterable<Uint8Array> {
  #chunk: Uint8Array | null = null
  #done = false
  #error: unknown
  #wakeReader: (() => void) | null = null
  #wakeWriter: (() => void) | null = null

  async write(chunk: Uint8Array): Promise<void> {
    if (this.#error) throw this.#error
    while (this.#chunk !== null) {
      await new Promise<void>((r) => (this.#wakeWriter = r))
      if (this.#error) throw this.#error
    }
    this.#chunk = chunk
    this.#wakeReader?.()
    this.#wakeReader = null
  }
  close(): void {
    this.#done = true
    this.#wakeReader?.()
  }
  /** Fail both sides: the writer's next write, and the reader's next read. */
  fail(err: unknown): void {
    this.#error = err
    this.#wakeReader?.()
    this.#wakeWriter?.()
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
    for (;;) {
      if (this.#error) throw this.#error
      if (this.#chunk !== null) {
        const c = this.#chunk
        this.#chunk = null
        this.#wakeWriter?.()
        this.#wakeWriter = null
        yield c
      } else if (this.#done) return
      else await new Promise<void>((r) => (this.#wakeReader = r))
    }
  }
}
