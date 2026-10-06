import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { checkSchemaFull, InputRuleError, parseRecordLine, sha256Hex } from '../src/index.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

interface Verdict {
  ok: boolean
  error?: string
  hash?: string
}
const vectors = JSON.parse(readFileSync(resolve(root, 'test/vectors/v2.json'), 'utf8')) as {
  inputRules: (Verdict & { line: string; canonical?: string })[]
  inputRuleRecipes: (Verdict & { prefix: string; repeat: string; n: number; suffix: string })[]
  schemaRules: { note: string; slug: string; schema: unknown; ok: boolean }[]
}

/** The verdict of the input rules on a line, in the vectors' terms. */
function verdict(line: string): Verdict & { canonical?: string } {
  try {
    const { canonical } = parseRecordLine(line)
    return { ok: true, canonical, hash: sha256Hex(canonical) }
  } catch (err) {
    if (!(err instanceof InputRuleError)) throw err
    return { ok: false, error: err.code }
  }
}

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

  // The same checks a second implementation would make, read from the file.
  it('input rules give each line its verdict', () => {
    for (const { line, ...want } of vectors.inputRules) expect(verdict(line), line).toEqual(want)
  })

  it('input rules give each long line its verdict', () => {
    for (const { prefix, repeat, n, suffix, ...want } of vectors.inputRuleRecipes) {
      const { canonical: _, ...got } = verdict(prefix + repeat.repeat(n) + suffix)
      expect(got, `${prefix}${repeat}×${n}${suffix}`).toEqual(want)
    }
  })

  it('schema rules accept and reject each schema', () => {
    for (const { note, slug, schema, ok } of vectors.schemaRules)
      expect(checkSchemaFull(slug, schema) === null, note).toBe(ok)
  })
})
