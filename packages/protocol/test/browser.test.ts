/**
 * The package loads and works in a browser: bundled for the browser, then run
 * in a VM context that has only web globals (no `process`, no `Buffer`, no
 * `require`), so hashing takes the portable path.
 */
import { createContext, runInContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

import { browserBundle } from '../scripts/browser-bundle.js'
import { hashRecord, sha256Hex } from '../src/index.js'

const WEB_GLOBALS = [
  'TextEncoder',
  'TextDecoder',
  'crypto',
  'CompressionStream',
  'DecompressionStream',
  'Blob',
  'Response',
  'Request',
  'Headers',
  'ReadableStream',
  'WritableStream',
  'TransformStream',
  'URL',
  'URLSearchParams',
  'atob',
  'btoa',
  'structuredClone',
  'queueMicrotask',
  'setTimeout',
  'clearTimeout',
] as const

describe('in a browser', () => {
  it('bundles with no Node imports and runs on web globals alone', async () => {
    const esm = await browserBundle('esm')
    expect(esm.gzip).toBeLessThan(200 * 1024)
    const { code } = await browserBundle('iife')

    const sandbox: Record<string, unknown> = {}
    for (const name of WEB_GLOBALS) sandbox[name] = (globalThis as Record<string, unknown>)[name]
    const context = createContext(sandbox)
    runInContext(code, context)
    await runInContext(
      `(async () => {
        const p = underlay
        const store = p.memoryStore()
        const repo = p.openRepo(store)
        const sink = new p.RepoSink(repo, { bodyOf: p.bodyOfRecord })
        const entries = []
        for (let i = 0; i < 3000; i++) {
          const id = 'r' + String(i).padStart(4, '0')
          const { hash, canonical } = p.hashRecord(id, 'T', { i })
          entries.push({ key: id, hash, size: canonical.length, body: canonical })
        }
        const root = p.buildTree(p.recordTree, sink, entries)
        await sink.flush()
        const got = await p.getEntry(new p.RepoSource(p.recordTree, repo), root.hash, 'r1234')
        globalThis.result = {
          native: p.nativeSha256,
          hasProcess: typeof process !== 'undefined',
          abc: p.sha256Hex('abc'),
          record: p.hashRecord('a', 'T', { x: 1 }).hash,
          count: root.count,
          found: got && got.hash,
          want: entries[1234].hash,
          version: p.PROTOCOL_VERSION,
        }
      })()`,
      context,
    )
    const r = sandbox.result as Record<string, unknown>
    expect(r.hasProcess).toBe(false)
    expect(r.native).toBe(false)
    expect(r.abc).toBe(sha256Hex('abc'))
    expect(r.record).toBe(hashRecord('a', 'T', { x: 1 }).hash)
    expect(r.count).toBe(3000)
    expect(r.found).toBe(r.want)
    expect(r.version).toBe(2)
  })
})
