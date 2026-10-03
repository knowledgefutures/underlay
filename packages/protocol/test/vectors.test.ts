import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('protocol test vectors', () => {
  // The vectors are the protocol's contract with other implementations. If this
  // fails, the implementation changed a hash, a tree shape or an input rule.
  it('test/vectors/v2.json matches the implementation', () => {
    const out = execFileSync('npx', ['tsx', 'scripts/gen-vectors.ts', '--check'], {
      cwd: root,
      encoding: 'utf8',
    })
    expect(out).toContain('vectors match')
  }, 60_000)
})
