/**
 * The R2 store inside workerd: a body written in pieces through a
 * FixedLengthStream (never joined) reads back byte for byte. The contract tests
 * reach R2 through Miniflare's proxy from Node, where that path doesn't exist.
 */
import { join } from 'node:path'

import { build } from 'esbuild'
import { convertV4MiniflareOptions, Miniflare } from 'miniflare'
import { afterAll, describe, expect, it } from 'vitest'

let mf: Miniflare | undefined
afterAll(() => mf?.dispose())

describe('r2 store in workerd', () => {
  it('writes pieces unjoined, keeps an existing key, and surfaces a failed put', async () => {
    const out = await build({
      entryPoints: [join(import.meta.dirname, 'r2-worker.ts')],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      conditions: ['workerd', 'worker', 'browser', 'import'],
      external: ['node:*'],
      write: false,
      logLevel: 'warning',
    })
    mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: out.outputFiles[0]!.text,
        compatibilityDate: '2026-09-30',
        compatibilityFlags: ['nodejs_compat'],
        r2Buckets: ['B'],
      }),
    )
    const res = await mf.dispatchFetch('http://test/')
    expect(await res.json()).toEqual({
      unjoined: true,
      roundTrip: true,
      again: 'resolved',
      unchanged: true,
      failed: 'rejected: boom',
    })
  }, 60_000)
})
