/**
 * A Worker for r2-worker.test.ts: writes through the real R2 store inside
 * workerd, where FixedLengthStream exists, and reports what it found.
 */
import { keys, Repo } from '../../src/repo/repo.js'
import { PrefixedStore, putJoined } from '../../src/repo/types.js'
import { type R2BucketLike, r2Store } from '../../src/stores/r2.js'

const MB = 1024 * 1024

const piece = (n: number, seed: number) => {
  const p = new Uint8Array(n)
  for (let i = 0; i < n; i++) p[i] = (i * 31 + seed * 7 + (i >> 13)) & 255
  return p
}

const join = (pieces: readonly Uint8Array[]) => {
  const out = new Uint8Array(pieces.reduce((n, p) => n + p.byteLength, 0))
  let off = 0
  for (const p of pieces) {
    out.set(p, off)
    off += p.byteLength
  }
  return out
}

const same = (a: Uint8Array, b: Uint8Array) =>
  a.byteLength === b.byteLength && a.every((x, i) => x === b[i])

/** The promise's outcome, or 'hung' after 10 s. */
const settle = (p: Promise<unknown>) =>
  Promise.race([
    p.then(
      () => 'resolved',
      (err: unknown) => `rejected: ${(err as Error).message}`,
    ),
    new Promise<string>((r) => setTimeout(() => r('hung'), 10_000)),
  ])

export default {
  async fetch(
    _req: Request,
    env: {
      B: R2BucketLike & {
        get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>
      }
    },
  ) {
    const store = new PrefixedStore(r2Store(env.B), 'p')
    const read = async (key: string) => new Uint8Array(await (await env.B.get(key))!.arrayBuffer())

    // Three members of over 5 MB, written by Repo.putBody as a leaf body is.
    const pieces = [piece(6 * MB, 1), piece(5 * MB + 3, 2), piece(7 * MB + 1, 3)]
    const repo = new Repo(store, { scope: 'test', trusted: true })
    const hash = 'a'.repeat(64)
    await repo.putBody(hash, pieces)
    const roundTrip = same(await read(`p/${keys.body(hash)}`), join(pieces))

    // ifAbsent on an existing key: succeeds, writes nothing, doesn't hang.
    const again = await settle(
      putJoined(store, keys.body(hash), [piece(6 * MB, 9), piece(6 * MB, 8)], { ifAbsent: true }),
    )
    const unchanged = same(await read(`p/${keys.body(hash)}`), join(pieces))

    // A put that fails after reading a little: the error surfaces, nothing hangs.
    const failing = r2Store({
      ...env.B,
      put: async (_key: string, value: unknown) => {
        await (value as ReadableStream<Uint8Array>).getReader().read()
        throw new Error('boom')
      },
    } as R2BucketLike)
    const failed = await settle(putJoined(failing, 'x', [piece(6 * MB, 4), piece(6 * MB, 5)]))

    return Response.json({
      unjoined: typeof store.putPieces === 'function',
      roundTrip,
      again,
      unchanged,
      failed,
    })
  },
}
