/**
 * Generate the protocol test vectors: test/vectors/v2.json.
 *
 *   pnpm --filter @underlay/protocol vectors           # write
 *   pnpm --filter @underlay/protocol vectors --check   # compare, exit 1 on any difference
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
  checkSchemaFull,
  compareUtf8,
  ed25519Signer,
  entryHash,
  type FileEntry,
  fileRefs,
  fileTree,
  hashRecord,
  hashSchema,
  InputRuleError,
  jcs,
  makeRoot,
  MAX_PATTERN_LENGTH,
  MAX_RECORD_BYTES,
  MAX_TYPE_BYTES,
  MemorySink,
  type NodeDesc,
  parseRecordLine,
  privateCommitment,
  type PrivateSetObject,
  recordCanonical,
  type RecordEntry,
  recordTree,
  type SetObject,
  sha256Hex,
  signEntry,
  trailingZeros,
  utf8ByteLength,
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
const deepObject = (n: number) => '{"a":'.repeat(n - 1) + '{}' + '}'.repeat(n - 1)
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
  '{"type":"t","data":1}',
  '{"id":"r","data":1}',
  '{"id":"r","type":"t","data":1,"private":"yes"}',
  '{"id":"r","type":"t","data":1,"note":"ignored","hash":"x"}',
  '{"id":"r","type":"t","data":{"9":3,"10":2}}',
  // syntax
  '{"id":"r","type":"t","data":}',
  'not json',
  '{"id":"r","type":"t","data":"abc',
  '{"id":"r","type":"t","data":{"\\x":1}}',
  '{"id":"r","type":"t","data":"\\u12zz"}',
  // bad_type
  `{"id":"r","type":"${'t'.repeat(MAX_TYPE_BYTES)}","data":1}`,
  `{"id":"r","type":"${'t'.repeat(MAX_TYPE_BYTES + 1)}","data":1}`,
  `{"id":"r","type":"${E_ACUTE.repeat(MAX_TYPE_BYTES / 2 + 1)}","data":1}`, // 130 UTF-8 bytes
  '{"id":"r","type":".t","data":1}',
  '{"id":"r","type":"a\\\\b","data":1}',
  '{"id":"r","type":"t\\u0001","data":1}',
  '{"id":"r","type":"t\\u007f","data":1}',
  '{"id":"r","type":"","data":1}',
  '{"id":"r","type":1,"data":1}',
  // too_deep at the boundary: data may nest 64 levels, the envelope being one more,
  // and so may members that are otherwise ignored.
  `{"id":"r","type":"t","data":${deepObject(64)}}`,
  `{"id":"r","type":"t","data":${deepObject(65)}}`,
  `{"id":"r","type":"t","data":1,"ignored":${deep(65)}}`,
  // Code order: the first rule the text breaks, then the envelope rules in order.
  '{"id":"r","type":"t","data":{"a":1,"a":2},}',
  '{"id":"r","type":"t","data":{"\\x":1,"a":1,"a":2}}',
  '{"id":"r","type":"t","data":{"a":"\\u12zz","a":1}}',
  '{"id":"r","type":"t","data":[9007199254740992,"\\ud83d"]}',
  '[1]',
  '{"id":"","type":"a/b"}',
  '{"id":"r","type":".t"}',
  '{"id":"r","type":"t","private":1}',
].map(ruleCase)

// Lines too long to list: the line is `prefix`, `repeat` n times, then `suffix`.
const recipeCase = (prefix: string, repeat: string, n: number, suffix: string) => {
  const r = ruleCase(prefix + repeat.repeat(n) + suffix)
  const verdict = 'error' in r ? { ok: false, error: r.error } : { ok: true, hash: r.hash }
  return { prefix, repeat, n, suffix, ...verdict }
}
const dataPrefix = '{"id":"r","type":"t","data":"'
// The longest string data whose canonical record is exactly MAX_RECORD_BYTES.
const maxData = MAX_RECORD_BYTES - utf8ByteLength(recordCanonical('r', 't', ''))
const inputRuleRecipes = [
  recipeCase(dataPrefix, 'x', maxData, '"}'),
  recipeCase(dataPrefix, 'x', maxData + 1, '"}'),
  // Size is the canonical form's: whitespace in the line doesn't count…
  recipeCase('{ "id" : "r" , "type" : "t" , "data" : "', 'x', maxData, '" }'),
  // …and a character counts as its UTF-8 bytes.
  recipeCase(dataPrefix, E_ACUTE, Math.ceil((maxData + 1) / 2), '"}'),
]

// --- Schema rules ---------------------------------------------------------------

const LONG = 'a'.repeat(MAX_PATTERN_LENGTH + 1)
// `ok` is the verdict of checkSchemaFull, which must be the one the case intends.
const schemaCase = (note: string, schema: unknown, ok: boolean, slug = 'T') => {
  const error = checkSchemaFull(slug, schema)
  if ((error === null) !== ok) throw new Error(`schemaRules "${note}": ${error ?? 'accepted'}`)
  return { note, slug, schema, ok }
}
const schemaRules = [
  // Section 5
  schemaCase('an ordinary schema', { type: 'object', properties: { a: { type: 'string' } } }, true),
  schemaCase('a private type', { private: true, type: 'object' }, true),
  schemaCase('root private false', { private: false }, true),
  schemaCase('root private not a boolean', { private: 'true' }, false),
  schemaCase('root private null', { private: null }, false),
  schemaCase('a property called "private"', { properties: { private: { type: 'boolean' } } }, true),
  schemaCase('field-level private', { properties: { ssn: { private: true } } }, false),
  schemaCase(
    'field-level private, nested in a definition',
    { definitions: { a: { properties: { b: { properties: { c: { private: true } } } } } } },
    false,
  ),
  schemaCase(
    'field-level private under a definition called "enum"',
    { definitions: { enum: { properties: { s: { private: true } } } } },
    false,
  ),
  schemaCase('private on items, not a property', { items: { private: true } }, true),
  schemaCase(
    'private on a definition, not a property',
    { definitions: { a: { private: true } } },
    true,
  ),
  schemaCase(
    'private inside default, which is data',
    { properties: { a: { default: { properties: { b: { private: true } } } } } },
    true,
  ),
  schemaCase('pattern of 256', { pattern: 'a'.repeat(MAX_PATTERN_LENGTH) }, true),
  schemaCase('pattern of 257', { pattern: LONG }, false),
  schemaCase(
    'pattern of 129 astral characters (258 UTF-16 code units)',
    { pattern: EMOJI.repeat(129) },
    false,
  ),
  schemaCase('patternProperties key of 257', { patternProperties: { [LONG]: {} } }, false),
  schemaCase(
    'pattern of 257 under a property called "type"',
    { properties: { type: { type: 'string', pattern: LONG } } },
    false,
  ),
  schemaCase('pattern of 257 inside enum, which is data', { enum: [{ pattern: LONG }] }, true),
  schemaCase('pattern of 257 inside const, which is data', { const: { pattern: LONG } }, true),
  schemaCase('pattern of 257 inside default, which is data', { default: { pattern: LONG } }, true),
  schemaCase(
    'pattern of 257 inside examples, which is data',
    { examples: [{ pattern: LONG }] },
    true,
  ),
  schemaCase('slug with a slash', {}, false, 'a/b'),
  schemaCase('slug starting with "."', {}, false, '.t'),
  schemaCase('empty slug', {}, false, ''),
  schemaCase('slug over 128 bytes', {}, false, 't'.repeat(MAX_TYPE_BYTES + 1)),
  // Section 5.1
  schemaCase('not an object', true, false),
  schemaCase('$schema draft-07', { $schema: 'http://json-schema.org/draft-07/schema#' }, true),
  schemaCase(
    '$schema draft-07 without "#"',
    { $schema: 'http://json-schema.org/draft-07/schema' },
    true,
  ),
  schemaCase('$schema 2020-12', { $schema: 'https://json-schema.org/draft/2020-12/schema' }, false),
  schemaCase('$schema draft-04', { $schema: 'http://json-schema.org/draft-04/schema#' }, false),
  schemaCase('invalid against the meta-schema: type', { type: 'text' }, false),
  schemaCase('invalid against the meta-schema: required', { required: 'a' }, false),
  schemaCase('a pattern that needs the u flag', { pattern: '^\\p{L}+$' }, true),
  schemaCase('an invalid pattern', { pattern: '(' }, false),
  schemaCase('a pattern invalid only with the u flag', { pattern: '\\a' }, false),
  schemaCase(
    'a patternProperties key invalid only with the u flag',
    { patternProperties: { '\\a': {} } },
    false,
  ),
  schemaCase(
    '$ref to a definition',
    { definitions: { a: { type: 'string' } }, properties: { x: { $ref: '#/definitions/a' } } },
    true,
  ),
  schemaCase(
    '$ref against the base URI',
    {
      definitions: { a: { type: 'string' } },
      properties: { x: { $ref: 'https://schema.underlay.invalid/#/definitions/a' } },
    },
    true,
  ),
  schemaCase(
    '$ref to an $id',
    {
      definitions: { a: { $id: 'a.json', type: 'string' } },
      properties: { x: { $ref: 'a.json' } },
    },
    true,
  ),
  schemaCase(
    '$ref to the draft-07 meta-schema',
    { $ref: 'http://json-schema.org/draft-07/schema#' },
    true,
  ),
  schemaCase('unresolvable $ref', { $ref: '#/definitions/missing' }, false),
  schemaCase(
    'unresolvable $ref to another document',
    { properties: { x: { $ref: 'other.json' } } },
    false,
  ),
]

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

// --- Version log ------------------------------------------------------------------

// Ed25519 signatures are deterministic (RFC 8032), so a fixed seed fixes every byte.
const logSeed = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64url')
const logSigner = await ed25519Signer(logSeed)
const logUnsigned = {
  collectionId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
  seq: 2,
  semver: 'v1.1.0',
  versionHash: roots[0]!.versionHash,
  baseSemver: 'v1.0.0',
  message: 'Second version',
  appId: null,
  actorId: null,
  createdAt: '2026-10-03T12:00:00.000Z',
  prev: sha256Hex('entry 1'),
}
const logSigned = await signEntry(logSigner, logUnsigned)
const { sig: _sig, ...logToSign } = logSigned
const logEntry = {
  privateKeySeed: logSeed,
  publicKey: logSigner.publicKey,
  unsigned: logUnsigned,
  signedBytes: jcs(logToSign),
  entry: logSigned,
  canonical: jcs(logSigned),
  entryHash: entryHash(logSigned),
  head: jcs({
    entryHash: entryHash(logSigned),
    seq: logSigned.seq,
    versionHash: logSigned.versionHash,
  }),
}

const vectors = {
  protocolVersion: 2,
  generatedBy: 'packages/protocol/scripts/gen-vectors.ts',
  constants: await import('../src/constants.js').then((m) => ({ ...m })),
  jcs: jcsCases,
  inputRules: inputRuleCases,
  inputRuleRecipes,
  schemaRules,
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
  logEntry,
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
