/**
 * The file store lists by prefix without walking the rest of the bucket: listing one
 * collection's manifests walked every file (20,000 collections in the scale bench:
 * most of each F maintain job's time, a cost R2's prefix listing doesn't have).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { fileStore } from '../../src/stores/fs.js'

const fsp = process.getBuiltinModule('node:fs/promises')

describe('fileStore list', () => {
  const dirs: string[] = []
  afterEach(() => {
    vi.restoreAllMocks()
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('reads only the folders that can hold the prefix', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ul-fs-list-'))
    dirs.push(root)
    const store = fileStore(root)
    const keys = [
      'repo/runs/a/manifest/f/000000000001.json',
      'repo/runs/a/manifest/f/000000000002.json',
      'repo/runs/a/manifest/f/pending/1-x.json',
      'repo/runs/a/packs/p.pk',
      'repo/runs/b/manifest/f/000000000001.json',
      'repo/nodes/zz',
    ]
    for (const k of keys) await store.put(k, 'x')
    const read = vi.spyOn(fsp, 'readdir')
    expect((await store.list('repo/runs/a/manifest/f/0')).keys).toEqual(keys.slice(0, 2))
    const walked = read.mock.calls.map((c) => String(c[0]))
    expect(walked.length).toBeGreaterThan(0)
    expect(walked.every((d) => d === join(root, 'repo/runs/a/manifest/f'))).toBe(true)
    // The same keys as before, whatever the prefix's shape.
    expect((await store.list('repo/runs/a/')).keys).toEqual(keys.slice(0, 4))
    expect((await store.list('repo/run')).keys).toEqual(keys.slice(0, 5))
    expect((await store.list('')).keys).toEqual([...keys].sort())
    expect((await store.list('repo/runs/c/')).keys).toEqual([])
    expect(
      (await store.list('repo/runs/a/', 'repo/runs/a/manifest/f/000000000002.json')).keys,
    ).toEqual(keys.slice(2, 4))
  })
})
