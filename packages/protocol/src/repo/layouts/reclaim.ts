import { type RecordEntry, recordTree } from '../../tree/node.js'
/**
 * Reclaim's mark for a key range (keyed layouts, record-storage-layout.md
 * "Reclaim needs a mark again"). A leaf covers its records, so today's cleanup
 * marks nodes; a packed layout has to know which records are live, one by one,
 * and at Crossref's size that set doesn't fit one isolate. So reclaim works a
 * key range at a time: each range's job walks every retained version's record
 * trees only where they overlap the range, and keeps the live records as 52-bit
 * hashes, 8 bytes each. A collision can only keep a dead record, never drop a
 * live one.
 */
import { compareUtf8 } from '../../utf8.js'
import type { Repo } from '../repo.js'

/** Live records of one key range, as sorted 52-bit hashes of (id, record hash). */
export class LiveHashes {
  #h = new Float64Array(4096)
  size = 0
  #sorted = true

  add(id: string, hash: string): void {
    if (this.size === this.#h.length) {
      const grown = new Float64Array(this.#h.length * 2)
      grown.set(this.#h)
      this.#h = grown
    }
    this.#h[this.size++] = hash52(id, hash)
    this.#sorted = false
  }

  has(id: string, hash: string): boolean {
    if (!this.#sorted) {
      this.#h = this.#h.subarray(0, this.size).sort()
      this.#sorted = true
    }
    const x = hash52(id, hash)
    let lo = 0
    let hi = this.size - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const v = this.#h[mid]!
      if (v === x) return true
      if (v < x) lo = mid + 1
      else hi = mid - 1
    }
    return false
  }
}

/** FNV-1a with two seeds over id, a separator and hash, folded to 52 bits (exact in a double). */
function hash52(id: string, hash: string): number {
  let a = 2_166_136_261
  let b = 0x9747b28c
  const step = (c: number) => {
    a = Math.imul(a ^ c, 16_777_619)
    b = Math.imul(b ^ c, 0x5bd1e995)
  }
  for (let i = 0; i < id.length; i++) step(id.charCodeAt(i))
  step(0)
  for (let i = 0; i < hash.length; i++) step(hash.charCodeAt(i))
  return (a >>> 0) * 1_048_576 + ((b >>> 0) >>> 12)
}

/** A key range: ids in [lo, hi); null is open. */
export interface KeyRange {
  lo: string | null
  hi: string | null
}

export const inRange = (r: KeyRange, k: string) =>
  (r.lo === null || compareUtf8(k, r.lo) >= 0) && (r.hi === null || compareUtf8(k, r.hi) < 0)

/**
 * Mark the records of `range` that the given record tree roots hold. Each node is
 * read once however many versions share it, and only nodes whose keys overlap
 * the range are read.
 */
export async function markRange(
  repo: Repo,
  treeRoots: Iterable<string>,
  range: KeyRange,
): Promise<{ live: LiveHashes; nodesRead: number }> {
  const live = new LiveHashes()
  const seen = new Set<string>()
  let nodesRead = 0
  const walk = async (hash: string): Promise<void> => {
    if (seen.has(hash)) return
    seen.add(hash)
    nodesRead++
    const node = await repo.decoded(recordTree, hash)
    if (node.kind === 'leaf') {
      for (const e of node.entries as RecordEntry[])
        if (inRange(range, e.key)) live.add(e.key, e.hash)
      return
    }
    // A child holds keys after the one before it's last, through its own last.
    const due: string[] = []
    for (let i = 0; i < node.children.length; i++) {
      const c = node.children[i]!
      const prev = i > 0 ? node.children[i - 1]!.lastKey : null
      if (range.hi !== null && prev !== null && compareUtf8(prev, range.hi) >= 0) break
      if (range.lo !== null && compareUtf8(c.lastKey, range.lo) < 0) continue
      due.push(c.hash)
    }
    for (let i = 0; i < due.length; i += 16) await Promise.all(due.slice(i, i + 16).map(walk))
  }
  for (const root of treeRoots) await walk(root)
  return { live, nodesRead }
}

/** Every record tree root of the given versions (public and private sets, every type). */
export async function recordRoots(repo: Repo, versionHashes: Iterable<string>): Promise<string[]> {
  const out = new Set<string>()
  for (const v of versionHashes) {
    const root = await repo.root(v)
    const sets = [root.public, ...(root.private ? [await repo.privateSet(root.private)] : [])]
    for (const s of sets) for (const t of Object.values(s.types)) if (t.root) out.add(t.root)
  }
  return [...out]
}
