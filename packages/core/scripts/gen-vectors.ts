/**
 * Generate the protocol test vectors: test/vectors/v2.json.
 *
 *   pnpm --filter @underlay/core vectors           # write
 *   pnpm --filter @underlay/core vectors --check   # compare, exit 1 on any difference
 *
 * Tree vectors are given as a recipe (how to generate the entries) plus the
 * expected results, so a second implementation can regenerate the inputs without
 * a multi-megabyte fixture. test/vectors.test.ts runs --check in CI.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  boundaryBytes,
  buildTree,
  compareUtf8,
  type FileEntry,
  fileRefs,
  fileTree,
  hashRecord,
  hashSchema,
  InputRuleError,
  jcs,
  makeRoot,
  MemorySink,
  type NodeDesc,
  parseRecordLine,
  privateCommitment,
  type PrivateSetObject,
  type RecordEntry,
  recordTree,
  type SetObject,
  sha256Hex,
  trailingZeros,
  versionHash,
} from '../src/index.js'

// Non-ASCII test strings are built from code points: the formatter rewrites
// \u escapes into literal characters, which an editor could silently normalize.
const cp = (...points: number[]) => String.fromCodePoint(...points)
const EMOJI = cp(0x1f600)
const E_ACUTE = cp(0xe9) // é, one code point
const E_COMBINING = cp(0x65, 0x301) // é, e + combining acute

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(here, '../test/vectors/v2.json')

// --- Canonical JSON -----------------------------------------------------------

const jcsCases = [
  '{"b":1,"a":2}',
  '{"9":3,"10":2,"a":1}',
  '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001,-0,1e21,1e-7]}',
  '{"\\u20ac":1,"\\r":2,"\\ufb33":3,"1":4,"\\ud83d\\ude00":5,"\\u0080":6,"\\u00f6":7}',
  '{"s":"\\u0000\\u001f\\"\\\\\\/\\b\\f\\n\\r\\t\\u007f\\u2028é😀"}',
  '[[],{},[{}],null,true,false,0,"",[1,[2,[3]]]]',
  '{"e\\u0301":1,"\\u00e9":2}',
].map((input) => ({ input, output: jcs(JSON.parse(input)) }))

// --- Input rules ----------------------------------------------------------------

const ruleCase = (line: string) => {
  try {
    const r = parseRecordLine(line)
    return { line, ok: true, canonical: r.canonical, hash: sha256Hex(r.canonical) }
  } catch (err) {
    if (!(err instanceof InputRuleError)) throw err
    return { line, ok: false, error: err.code }
  }
}

const deep = (n: number) => '['.repeat(n) + ']'.repeat(n)
const inputRuleCases = [
  '{"id":"r1","type":"Author","data":{"name":"Ada","year":1815}}',
  '{"type":"Author","data":{"year":1815,"name":"Ada"},"id":"r1","private":true}',
  '{"id":"r","type":"t","data":{"a":1,"a":2}}',
  '{"id":"r","type":"t","data":{"a":1,"\\u0061":2}}',
  '{"id":"r","type":"t","data":{"x":{"a":1},"y":{"a":1}}}',
  '{"id":"r","type":"t","data":9007199254740991}',
  '{"id":"r","type":"t","data":9007199254740992}',
  '{"id":"r","type":"t","data":-9007199254740992}',
  '{"id":"r","type":"t","data":[1e20,6.02e23,9007199254740993.0]}',
  '{"id":"r","type":"t","data":"\\ud83d\\ude00"}',
  '{"id":"r","type":"t","data":"\\ud83d"}',
  '{"id":"r","type":"t","data":"\\ude00"}',
  '{"id":"\\u00e9","type":"t","data":1}',
  '{"id":"e\\u0301","type":"t","data":1}',
  `{"id":"r","type":"t","data":${deep(64)}}`,
  `{"id":"r","type":"t","data":${deep(65)}}`,
  `{"id":"${'x'.repeat(1024)}","type":"t","data":1}`,
  `{"id":"${'x'.repeat(1025)}","type":"t","data":1}`,
  '{"id":"","type":"t","data":1}',
  '{"id":"r","type":"a/b","data":1}',
  '{"id":"r","type":"t"}',
  '{"id":"r","type":"t","data":{"9":3,"10":2}}',
].map(ruleCase)

// --- Hashes ---------------------------------------------------------------------

const recordHashes = [
  { id: 'r1', type: 'Author', data: { name: 'Ada', year: 1815 } },
  {
    id: 'r2',
    type: 'Pub',
    data: { title: 'On Computable Numbers', refs: [{ $file: `sha256:${'a'.repeat(64)}` }] },
  },
  { id: '9', type: 'T', data: { 10: 'x', 9: 'y', z: [1.5, null, true] } },
  { id: '😀', type: 'Émoji', data: 'plain string data' },
].map((r) => ({ ...r, ...hashRecord(r.id, r.type, r.data) }))

const schemaHashes = [
  { type: 'object', properties: { name: { type: 'string' } } },
  { type: 'object', properties: { 1: { type: 'string' }, 10: { type: 'integer' } }, private: true },
].map((schema) => ({ schema, canonical: jcs(schema), hash: hashSchema(schema) }))

const boundaryCases = ['', 'a', 'r0', 'k12345', EMOJI, E_COMBINING].map((key) => {
  const u = boundaryBytes(key)
  return { key, u: Buffer.from(u).toString('hex'), trailingZeros: trailingZeros(u) }
})
// Keys whose boundary hash ends in ≥10 and ≥16 zero bits, found by search.
for (const want of [10, 16]) {
  for (let i = 0; ; i++) {
    const key = `b${i}`
    const u = boundaryBytes(key)
    if (trailingZeros(u) >= want) {
      boundaryCases.push({
        key,
        u: Buffer.from(u).toString('hex'),
        trailingZeros: trailingZeros(u),
      })
      break
    }
  }
}

const keyOrder = [
  'a',
  'b',
  'aa',
  '',
  'Z',
  cp(0x7f),
  cp(0x80),
  cp(0xffff),
  EMOJI,
  cp(0xe000),
  E_ACUTE,
  E_COMBINING,
]
  .slice()
  .sort(compareUtf8)

// --- Trees ----------------------------------------------------------------------

interface TreeVector {
  name: string
  recipe: string
  entries: number
  root: string | null
  count: number
  bytes: number
  height: number
  nodesPerLevel: number[]
  leafSizes?: number[]
}

function recordEntries(keys: string[]): RecordEntry[] {
  return keys
    .slice()
    .sort(compareUtf8)
    .map((key) => {
      const { hash, canonical } = hashRecord(key, 'T', { k: key })
      return { key, hash, size: Buffer.byteLength(canonical) }
    })
}

function treeVector(
  name: string,
  recipe: string,
  entries: RecordEntry[],
  withLeafSizes = false,
): TreeVector {
  const levels: number[] = []
  const leafSizes: number[] = []
  const sink = {
    leaf(_d: NodeDesc, _j: string, es: readonly RecordEntry[]) {
      levels[0] = (levels[0] ?? 0) + 1
      leafSizes.push(es.length)
    },
    interior(d: NodeDesc) {
      levels[d.level] = (levels[d.level] ?? 0) + 1
    },
  }
  const root = buildTree(recordTree, sink, entries)
  const v: TreeVector = {
    name,
    recipe,
    entries: entries.length,
    root: root?.hash ?? null,
    count: root?.count ?? 0,
    bytes: root?.bytes ?? 0,
    height: root ? root.level + 1 : 0,
    nodesPerLevel: levels.slice(0, root ? root.level + 1 : 0),
  }
  if (withLeafSizes) v.leafSizes = leafSizes
  return v
}

const RECIPE =
  'entries: for each key, hashRecord(key, "T", {"k": key}) → [key, hash, UTF-8 length of the canonical record]; sorted by key'
const range = <T>(n: number, f: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => f(i))

const trees: TreeVector[] = [
  treeVector('empty', `${RECIPE}; no keys`, []),
  treeVector('one', `${RECIPE}; keys ["only"]`, recordEntries(['only'])),
  treeVector(
    'small',
    `${RECIPE}; keys "r0".."r999"`,
    recordEntries(range(1000, (i) => `r${i}`)),
    true,
  ),
  treeVector(
    'medium',
    `${RECIPE}; keys "r0".."r99999"`,
    recordEntries(range(100_000, (i) => `r${i}`)),
  ),
  treeVector(
    'unicode',
    `${RECIPE}; keys "é<i>", "e\\u0301<i>", "😀<i>", "\\uffff<i>" for i in 0..2499`,
    recordEntries(
      range(2500, (i) => [
        `${E_ACUTE}${i}`,
        `${E_COMBINING}${i}`,
        `${EMOJI}${i}`,
        `${cp(0xffff)}${i}`,
      ]).flat(),
    ),
    true,
  ),
  treeVector(
    'forced-leaf-splits',
    `${RECIPE}; keys "f<i>" for i in 0..19999 whose boundary hash has fewer than 10 trailing zero bits (no natural leaf boundary at all)`,
    recordEntries(
      range(20_000, (i) => `f${i}`).filter((k) => trailingZeros(boundaryBytes(k)) < 10),
    ),
    true,
  ),
]

// File trees: key = file hash, value = size.
const fileEntries: FileEntry[] = range(3000, (i) => ({
  key: sha256Hex(`file${i}`),
  size: i * 1000 + 1,
})).sort((a, b) => compareUtf8(a.key, b.key))
const fileRoot = buildTree(fileTree, new MemorySink(), fileEntries)

// One leaf, spelled out, so the node encoding can be checked by eye.
const tinyLeafSink = new MemorySink<RecordEntry>()
const tinyLeaf = buildTree(recordTree, tinyLeafSink, recordEntries(['a', 'b', 'c']))!
const tinyInteriorSink = new MemorySink<RecordEntry>()
const tinyInteriorRoot = buildTree(
  recordTree,
  tinyInteriorSink,
  recordEntries(range(3000, (i) => `r${i}`)),
)!

// --- Roots ----------------------------------------------------------------------

const smallTree = trees.find((t) => t.name === 'small')!
const publicSet: SetObject = {
  types: {
    Author: {
      schema: schemaHashes[0]!.hash,
      root: smallTree.root,
      count: smallTree.count,
      bytes: smallTree.bytes,
    },
    Empty: { schema: schemaHashes[0]!.hash, root: null, count: 0, bytes: 0 },
  },
  files: { root: fileRoot!.hash, count: fileRoot!.count, bytes: fileRoot!.bytes },
}
const privateSet: PrivateSetObject = {
  types: {
    Secret: {
      schema: schemaHashes[1]!.hash,
      root: tinyLeaf.hash,
      count: tinyLeaf.count,
      bytes: tinyLeaf.bytes,
    },
  },
  files: { root: null, count: 0, bytes: 0 },
  salt: sha256Hex('vector salt'),
}
const metadata = { name: 'Vector collection', readme: '# Hi\n', tags: ['a', 'b'], 10: 'x', 9: 'y' }
const rootPublicOnly = makeRoot(metadata, publicSet, null)
const rootWithPrivate = makeRoot(metadata, publicSet, privateSet)
const roots = [
  {
    name: 'public-only',
    root: rootPublicOnly,
    canonical: jcs(rootPublicOnly),
    versionHash: versionHash(rootPublicOnly),
  },
  {
    name: 'with-private',
    privateSet,
    privateCanonical: jcs(privateSet),
    commitment: privateCommitment(privateSet),
    root: rootWithPrivate,
    canonical: jcs(rootWithPrivate),
    versionHash: versionHash(rootWithPrivate),
  },
]

// --- File references --------------------------------------------------------------

const H = (c: string) => c.repeat(64)
const fileRefCases = [
  { data: { f: { $file: `sha256:${H('a')}` } } },
  {
    data: {
      list: [
        { $file: `sha256:${H('b')}` },
        { nested: { $file: `sha256:${H('c')}`, extra: { $file: `sha256:${H('d')}` } } },
      ],
    },
  },
  {
    data: {
      f: { $file: `sha256:${H('A')}` },
      g: { $file: H('e') },
      h: { $file: 1, inner: { $file: `sha256:${H('f')}` } },
    },
  },
  { data: [{ $file: `sha256:${H('a')}` }, { $file: `sha256:${H('a')}` }] },
].map((c) => ({ ...c, refs: fileRefs(c.data) }))

const vectors = {
  format: 2,
  generatedBy: 'packages/core/scripts/gen-vectors.ts',
  constants: await import('../src/constants.js').then((m) => ({ ...m })),
  jcs: jcsCases,
  inputRules: inputRuleCases,
  recordHashes,
  schemaHashes,
  boundary: boundaryCases,
  keyOrder,
  nodes: {
    leaf: {
      keys: ['a', 'b', 'c'],
      recipe: RECIPE,
      hash: tinyLeaf.hash,
      json: tinyLeafSink.nodes.get(tinyLeaf.hash),
    },
    interior: {
      recipe: `${RECIPE}; keys "r0".."r2999"; the root node`,
      hash: tinyInteriorRoot.hash,
      json: tinyInteriorSink.nodes.get(tinyInteriorRoot.hash),
    },
  },
  trees,
  fileTree: {
    recipe:
      'entries: key = sha256Hex("file<i>"), size = i × 1000 + 1, for i in 0..2999; sorted by key',
    root: fileRoot!.hash,
    count: fileRoot!.count,
    bytes: fileRoot!.bytes,
  },
  roots,
  fileRefs: fileRefCases,
}

const text = JSON.stringify(vectors, null, 1) + '\n'
if (process.argv.includes('--check')) {
  const existing = readFileSync(out, 'utf8')
  // Compare content, not layout: the formatter (and the pre-commit hook) may
  // re-wrap the file.
  const same = JSON.stringify(JSON.parse(existing)) === JSON.stringify(JSON.parse(text))
  if (!same) {
    console.error(
      'test/vectors/v2.json is out of date with the implementation. If the change is intended, it is a protocol change: regenerate with `pnpm vectors` and say so in docs/protocol-v2.md.',
    )
    process.exit(1)
  }
  console.log('vectors match')
} else {
  writeFileSync(out, text)
  console.log(`wrote ${out}`)
}
