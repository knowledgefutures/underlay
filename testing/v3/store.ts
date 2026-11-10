/**
 * The bench store: a folder on disk that behaves as R2 is documented to.
 *
 * It wraps the protocol's file store and adds what a local disk hides:
 *
 *   latency   every call waits as R2 would (src/latency.ts: `r2`, `r2-slow`)
 *   limits    one write a second to a key, then a 429 (new keys are not limited);
 *             create-if-absent is atomic and a loss is still a Class A request;
 *             a list returns at most 1,000 keys; a single put is at most 5 GiB;
 *             multipart parts are all one size but the last, at least 5 MiB;
 *             there is no conditional delete and no rename
 *   counting  requests by R2's billing class, bytes in and out, by key prefix
 *
 * A server-side copy is a hard link here: R2 copies inside the bucket without
 * the bytes passing through the caller, so the bench must not pay to read and
 * write them either. Listing walks only the folders a prefix names, in key
 * order, so a page costs what it holds, as on R2.
 */
import { link, mkdir, readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  type BlobHead,
  type BlobObject,
  FileStore,
  type ListPage,
  type PutOptions,
  type PutPartsOptions,
  type Store,
} from '../../packages/protocol/src/index.js'
import { delayMs, type Profile, profile as profileOf, wait } from '../src/latency.js'

/** R2's prices, dollars per million requests. Deletes are free. */
export const CLASS_A_PER_MILLION = 4.5
export const CLASS_B_PER_MILLION = 0.36

export const MAX_PUT_BYTES = 5 * 1024 ** 3
export const MIN_PART_BYTES = 5 * 1024 ** 2
export const MAX_PARTS = 10_000

export interface Counts {
  /** put, create, copy, list, and each request of a multipart upload. */
  classA: number
  /** get (whole, range, tail) and head. */
  classB: number
  deletes: number
  bytesIn: number
  bytesOut: number
  /** Creates that lost: the key existed. Counted in classA as well. */
  createsLost: number
  /** Overwrites refused with a 429: a second write to a key within a second. */
  rateLimited: number
  /** Milliseconds of simulated waiting. */
  waitMs: number
}

export const zeroCounts = (): Counts => ({
  classA: 0,
  classB: 0,
  deletes: 0,
  bytesIn: 0,
  bytesOut: 0,
  createsLost: 0,
  rateLimited: 0,
  waitMs: 0,
})

export function addCounts(into: Counts, c: Counts): Counts {
  for (const k of Object.keys(into) as (keyof Counts)[]) into[k] += c[k]
  return into
}
export function subCounts(a: Counts, b: Counts): Counts {
  const out = zeroCounts()
  for (const k of Object.keys(out) as (keyof Counts)[]) out[k] = a[k] - b[k]
  return out
}
export const costOf = (c: Counts): number =>
  (c.classA * CLASS_A_PER_MILLION + c.classB * CLASS_B_PER_MILLION) / 1e6

export class RateLimitError extends Error {
  readonly status = 429
  constructor(key: string) {
    super(`429 Too Many Requests: ${key} was written less than a second ago`)
    this.name = 'RateLimitError'
  }
}

/** What kind of object a key is, for the breakdown of bytes and requests. */
export function kindOf(key: string): string {
  if (key.startsWith('records/')) return 'records'
  if (key.startsWith('assets/')) return 'assets'
  if (key.startsWith('trash/')) return 'trash'
  if (key.startsWith('tmp/')) return 'tmp'
  if (key.startsWith('sweep/')) return 'sweep'
  if (key.includes('/commits/')) return 'commits'
  if (key.includes('/layouts/')) return 'layouts'
  if (key.endsWith('/latest.json') || key.endsWith('/latest-layout.json')) return 'latest'
  if (key.endsWith('/collection.json')) return 'description'
  return 'other'
}

export class BenchStore implements Store {
  readonly inner: FileStore
  readonly latency: Profile
  counts = zeroCounts()
  /** Requests and bytes by kind of object. */
  readonly byKind = new Map<string, { a: number; b: number; in: number; out: number }>()

  constructor(
    readonly dir: string,
    latency: string | Profile = 'none',
  ) {
    this.inner = new FileStore(dir)
    this.latency = typeof latency === 'string' ? profileOf(latency) : latency
  }

  snapshot(): Counts {
    return { ...this.counts }
  }

  #kind(key: string) {
    const k = kindOf(key)
    let s = this.byKind.get(k)
    if (!s) this.byKind.set(k, (s = { a: 0, b: 0, in: 0, out: 0 }))
    return s
  }
  async #wait(ms: number) {
    this.counts.waitMs += ms
    await wait(ms)
  }
  #a(key: string, bytes: number, requests = 1) {
    this.counts.classA += requests
    this.counts.bytesIn += bytes
    const k = this.#kind(key)
    k.a += requests
    k.in += bytes
  }
  #b(key: string, bytes: number) {
    this.counts.classB += 1
    this.counts.bytesOut += bytes
    const k = this.#kind(key)
    k.b += 1
    k.out += bytes
  }

  async get(key: string, range?: { offset: number; length?: number }): Promise<BlobObject | null> {
    const out = await this.inner.get(key, range)
    this.#b(key, out?.size ?? 0)
    await this.#wait(delayMs(this.latency.get, out?.size ?? 0))
    return out
  }

  async tail(key: string, length: number): Promise<BlobObject | null> {
    const out = await this.inner.tail(key, length)
    this.#b(key, out?.size ?? 0)
    await this.#wait(delayMs(this.latency.get, out?.size ?? 0))
    return out
  }

  async head(key: string): Promise<BlobHead | null> {
    const out = await this.inner.head(key)
    this.#b(key, 0)
    await this.#wait(delayMs(this.latency.head))
    return out
  }

  /** R2 refuses a second write to one key within a second. A new key is never refused. */
  async #rateLimit(key: string): Promise<void> {
    const st = await stat(join(this.dir, key)).catch(() => null)
    if (st && Date.now() - st.mtimeMs < 1000) {
      this.counts.rateLimited++
      this.counts.classA++
      await this.#wait(delayMs(this.latency.put))
      throw new RateLimitError(key)
    }
  }

  async put(key: string, body: Uint8Array | string, opts?: PutOptions): Promise<void> {
    const size = typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength
    if (size > MAX_PUT_BYTES) throw new Error(`A single put is at most 5 GiB (${key})`)
    if (!opts?.ifAbsent) await this.#rateLimit(key)
    this.#a(key, size)
    await this.inner.put(key, body, opts)
    await this.#wait(delayMs(this.latency.put, size))
  }

  async create(key: string, body: Uint8Array | string, opts?: PutOptions): Promise<boolean> {
    const size = typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength
    if (size > MAX_PUT_BYTES) throw new Error(`A single put is at most 5 GiB (${key})`)
    const won = await this.inner.create(key, body, opts)
    // A lost create is still a request R2 bills for; its body was sent.
    this.#a(key, size)
    if (!won) this.counts.createsLost++
    await this.#wait(delayMs(this.latency.put, size))
    return won
  }

  /** A multipart upload: create, a request for each part, complete. */
  async putParts(
    key: string,
    parts: AsyncIterable<Uint8Array>,
    opts?: PutPartsOptions,
  ): Promise<void> {
    let size = 0
    let n = 0
    let first = -1
    let short = false
    const pause = (bytes: number) => this.#wait(delayMs(this.latency.put, bytes))
    async function* checked() {
      for await (const part of parts) {
        if (short) throw new Error(`Multipart parts must be one size but the last (${key})`)
        if (first === -1) first = part.byteLength
        if (part.byteLength !== first) {
          if (part.byteLength > first) {
            throw new Error(`Multipart parts must be one size but the last (${key})`)
          }
          short = true
        }
        size += part.byteLength
        if (++n > MAX_PARTS) throw new Error(`A multipart upload has at most 10,000 parts (${key})`)
        await pause(part.byteLength)
        yield part
      }
    }
    if (!opts?.ifAbsent) await this.#rateLimit(key)
    await this.inner.putParts(key, checked(), opts)
    // One part is a plain put. More must each be 5 MiB or over, but the last.
    if (n > 1 && first < MIN_PART_BYTES) {
      throw new Error(`Multipart parts must be at least 5 MiB but the last (${key})`)
    }
    this.#a(key, size, n > 1 ? n + 2 : 1)
    await this.#wait(delayMs(this.latency.put))
  }

  async delete(key: string): Promise<void> {
    this.counts.deletes++
    await this.inner.delete(key)
    await this.#wait(delayMs(this.latency.delete))
  }

  /** A copy inside the bucket: one Class A request, no bytes through the caller. */
  async copy(from: string, to: string): Promise<void> {
    const src = join(this.dir, from)
    const dest = join(this.dir, to)
    await mkdir(dirname(dest), { recursive: true })
    await link(src, dest).catch(async (err: { code?: string }) => {
      if (err.code !== 'EEXIST') throw err
      await this.inner.copy(from, to)
    })
    this.#a(to, 0)
    await this.#wait(delayMs(this.latency.put))
  }

  /**
   * Up to 1,000 keys under a prefix, in key order, after a cursor. Walks the
   * folders in key order and stops when the page is full.
   */
  async list(prefix: string, cursor?: string): Promise<ListPage> {
    const keys: string[] = []
    const info: { size: number; modified: number }[] = []
    const slash = prefix.lastIndexOf('/')
    const startDir = prefix.slice(0, slash + 1)
    const walk = async (rel: string): Promise<boolean> => {
      const entries = await readdir(join(this.dir, rel), { withFileTypes: true }).catch(() => [])
      // A folder's keys all begin `name/`, so it sorts as that, not as `name`.
      const named = entries
        .filter((e) => e.isDirectory() || !(e.name.endsWith('.tmp') || e.name.endsWith('.__type')))
        .map((e) => ({ key: rel + e.name + (e.isDirectory() ? '/' : ''), dir: e.isDirectory() }))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      for (const e of named) {
        if (e.dir) {
          // Skip folders that hold nothing under the prefix or after the cursor.
          if (!(e.key.startsWith(prefix) || prefix.startsWith(e.key))) continue
          if (cursor && e.key < cursor && !cursor.startsWith(e.key)) continue
          if (!(await walk(e.key))) return false
        } else {
          if (!e.key.startsWith(prefix) || (cursor && e.key <= cursor)) continue
          const st = await stat(join(this.dir, e.key)).catch(() => null)
          if (!st) continue
          keys.push(e.key)
          info.push({ size: st.size, modified: st.mtimeMs })
          if (keys.length === 1000) return false
        }
      }
      return true
    }
    await walk(startDir)
    this.#a(prefix, 0)
    await this.#wait(delayMs(this.latency.list))
    return keys.length === 1000 ? { keys, info, cursor: keys[999]! } : { keys, info }
  }
}

/** Bytes and objects under a folder of the store, by kind, straight from disk (no requests). */
export async function diskUsage(
  dir: string,
): Promise<Record<string, { objects: number; bytes: number }>> {
  const out: Record<string, { objects: number; bytes: number }> = {}
  const walk = async (rel: string) => {
    const entries = await readdir(join(dir, rel), { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      const key = rel + e.name
      if (e.isDirectory()) await walk(key + '/')
      else if (!e.name.endsWith('.__type')) {
        const st = await stat(join(dir, key)).catch(() => null)
        if (!st) continue
        const k = (out[kindOf(key)] ??= { objects: 0, bytes: 0 })
        k.objects++
        k.bytes += st.size
      }
    }
  }
  await walk('')
  return out
}
