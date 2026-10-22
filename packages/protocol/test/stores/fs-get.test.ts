/**
 * An object the file store returned stays readable when deleted after the get, as
 * on R2: a maintain job listing split merges read a plan the merge's last job had
 * just deleted (round 20, ENOENT from the body's read).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { fileStore } from '../../src/stores/fs.js'

describe('fileStore get', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('reads a small object deleted after the get', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ul-fs-get-'))
    dirs.push(root)
    const store = fileStore(root)
    await store.put('merges/m1/plan', '{"id":"m1"}')
    const o = await store.get('merges/m1/plan')
    await store.delete('merges/m1/plan')
    expect(await o!.text()).toBe('{"id":"m1"}')
    expect(await store.get('merges/m1/plan')).toBeNull()
  })
})
