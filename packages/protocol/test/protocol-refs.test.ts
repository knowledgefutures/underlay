/**
 * Citations of the protocol stay true (docs/protocol/README.md). Each version is one file,
 * `docs/protocol/v<N>.md`; code, docs, and the site cite a section by its version's file, and
 * the site's protocol pages name theirs with `protocolSections`/`protocolEyebrow`. This walks
 * the repository and checks that every section cited exists in the file it names, and that
 * nothing cites a file name the specification no longer has.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..', '..', '..')
const specDir = join(root, 'docs', 'protocol')
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.claude', '.wrangler', 'planning'])
const SKIP_PATHS = ['packages/web/public/cli/', 'packages/web/src/generated/', 'docs/protocol/']
const EXTS = ['.ts', '.tsx', '.md', '.txt', '.json', '.jsonc', '.yml', '.sql', '.mjs']

/** Section ids in a spec file: "6", "6.4", "11.3.1", "Appendix C". */
export function sectionsOf(text: string): Set<string> {
  const out = new Set<string>()
  for (const line of text.split('\n')) {
    const m = /^#{2,4} (?:(Appendix [A-Z])\.|(\d+(?:\.\d+)*)\.? )/.exec(line)
    if (m) out.add(m[1] ?? m[2]!)
  }
  return out
}

const REF = String.raw`(?:Appendix [A-Z]|\d+(?:\.\d+)*)`
const LIST = String.raw`${REF}(?:(?:, and |, | and | to |/)${REF})*`
/** A citation: the file, then optionally "Section(s)"/"§", then a list of section ids. */
const CITE = new RegExp(
  String.raw`docs/protocol/v(\d+)\.md` +
    String.raw`(?:[,:]?\s*(?:\(\s*)?(?:(?:Sections?|§§?)\s+)?(${LIST}))?`,
  'g',
)
/** A page's declared sections: protocolSections(3, ['2', '3']) or protocolEyebrow(3, [...]). */
const DECLARED = /protocol(?:Sections|Eyebrow)\((\d+),\s*\[([^\]]*)\]/g
/** File names the specification no longer has. */
const RETIRED = /(?<![\w/-])(?:docs\/)?protocol(?:-v\d+)?\.md\b|docs\/protocol-v\d+\.md/g

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* files(p)
    else if (EXTS.some((e) => name.endsWith(e))) yield p
  }
}

const refsIn = (list: string) =>
  list
    .split(/, and |, | and | to |\//)
    .map((s) => s.trim())
    .filter(Boolean)

describe('citations of the protocol', () => {
  const specs = new Map<number, Set<string>>()
  for (const name of readdirSync(specDir)) {
    const m = /^v(\d+)\.md$/.exec(name)
    if (m) specs.set(Number(m[1]), sectionsOf(readFileSync(join(specDir, name), 'utf8')))
  }

  it('reads the sections of every version', () => {
    expect([...specs.keys()].sort()).toEqual([2, 3])
    expect(specs.get(3)).toContain('7.2')
    expect(specs.get(3)).toContain('Appendix C')
    expect(specs.get(2)).toContain('11.3.1')
  })

  it('finds every cited section in the version it names, and no retired file name', () => {
    const problems: string[] = []
    let cited = 0
    for (const path of files(root)) {
      const rel = relative(root, path)
      if (SKIP_PATHS.some((s) => rel.startsWith(s))) continue
      const text = readFileSync(path, 'utf8')
      const at = (i: number) => `${rel}:${text.slice(0, i).split('\n').length}`
      for (const m of text.matchAll(RETIRED)) {
        problems.push(`${at(m.index)}: cites ${m[0]}; cite docs/protocol/v<N>.md`)
      }
      const check = (version: number, ids: string[], i: number) => {
        const known = specs.get(version)
        if (!known) {
          problems.push(`${at(i)}: no docs/protocol/v${version}.md`)
          return
        }
        for (const id of ids) {
          cited++
          if (!known.has(id)) problems.push(`${at(i)}: v${version} has no section ${id}`)
        }
      }
      for (const m of text.matchAll(CITE)) check(Number(m[1]), m[2] ? refsIn(m[2]) : [], m.index)
      for (const m of text.matchAll(DECLARED)) {
        const ids = [...m[2]!.matchAll(/'([^']*)'/g)].map((x) => x[1]!)
        check(Number(m[1]), ids, m.index)
      }
    }
    expect(problems).toEqual([])
    expect(cited).toBeGreaterThan(50)
  })
})
