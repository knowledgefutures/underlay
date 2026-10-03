/**
 * Differential test: v1's validator (AJV, configured exactly as the v1 server)
 * against the v2 validator (src/validate.ts), over every public schema and
 * record on underlay.org. @hyperjump/json-schema (draft-07) runs alongside as a
 * second interpreting validator.
 *
 *   npx tsx packages/core/scripts/diff-validators.ts [--data <dir>] [--offline]
 *
 * Three passes:
 *   1. every distinct schema of every version is compiled by all three;
 *   2. every record of each collection's latest version is validated;
 *   3. production records only exercise the "valid" path (v1 refused the rest
 *      at push time), so a sample of each type's records is mutated against its
 *      schema (wrong types, missing required fields, extra fields, bad format
 *      and enum values) and validated again; and a corpus of edge-case strings
 *      is run through every format keyword.
 *
 * Downloads are read-only GETs to the public API, sent one at a time under the
 * anonymous rate limit, and cached under --data so reruns are offline.
 */
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { Ajv } from 'ajv'
import addFormatsModule from 'ajv-formats'

import { compileSchema, SchemaError } from '../src/validate.js'

const API = 'https://www.underlay.org/api'
const args = process.argv.slice(2)
const option = (name: string, fallback: string) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback
}
const DATA = option('--data', '/Users/travis/.claude-kf/jobs/71495a02/tmp/validator-data')
const OFFLINE = args.includes('--offline')
/** Validate only the mutation sample of production records (for iterating). */
const QUICK = args.includes('--quick')
/** Records per type that pass 3 mutates. */
const MUTATE_SAMPLE = 20
const MUTATE_MAX_BYTES = 64 * 1024
const MAX_LISTED = 40

// --- Download (cached) ----------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let lastRequest = 0

async function get(url: string): Promise<Response> {
  if (OFFLINE) throw new Error(`--offline and not cached: ${url}`)
  // One request at a time, under the anonymous limit of 60 a minute: this is a
  // production site.
  for (let attempt = 0; ; attempt++) {
    const wait = lastRequest + 1100 - Date.now()
    if (wait > 0) await sleep(wait)
    lastRequest = Date.now()
    const res = await fetch(url, {
      headers: { 'user-agent': 'underlay-validator-diff (read-only)' },
    })
    if (res.status === 429 && attempt < 5) {
      await sleep(1000 * (Number(res.headers.get('retry-after')) || 60))
      continue
    }
    if (!res.ok) throw new Error(`GET ${url}: ${res.status}`)
    return res
  }
}

async function cachedJson<T>(file: string, url: string): Promise<T> {
  const path = join(DATA, file)
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')) as T
  const body = await (await get(url)).text()
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, body)
  return JSON.parse(body) as T
}

async function cachedFile(file: string, url: string): Promise<string> {
  const path = join(DATA, file)
  if (existsSync(path)) return path
  const res = await get(url)
  mkdirSync(join(path, '..'), { recursive: true })
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(path + '.part'))
  renameSync(path + '.part', path)
  return path
}

interface CollectionRow {
  slug: string
  ownerSlug: string
  latestVersion: string | null
}

async function listCollections(): Promise<CollectionRow[]> {
  const out: CollectionRow[] = []
  const limit = 100
  for (let page = 0; ; page++) {
    const body = await cachedJson<{ collections: CollectionRow[] }>(
      `collections-p${page}.json`,
      `${API}/collections?limit=${limit}&offset=${page * limit}`,
    )
    out.push(...body.collections)
    if (body.collections.length < limit) break
  }
  return out
}

// --- The three validators ---------------------------------------------------------

/** A compiled validator returning error strings (empty = valid), or the compile error. */
type Compiled = ((data: unknown) => string[]) | string

// v1, exactly: src/lib/core/validate.ts at the repo root.
const addFormats = addFormatsModule as unknown as (ajv: Ajv) => void
const ajv = new Ajv({ allErrors: true, strict: false })
addFormats(ajv)
// AJV warns about (and ignores) unknown formats; keep the warnings out of the report.
const ajvWarnings = new Set<string>()
;(ajv as unknown as { logger: unknown }).logger = {
  log: () => {},
  warn: (msg: unknown) => ajvWarnings.add(String(msg)),
  error: console.error,
}

function ajvCompile(schema: unknown): Compiled {
  try {
    const v = ajv.compile(schema as object)
    ajv.removeSchema(schema as object)
    return (data) =>
      v(data) ? [] : (v.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`)
  } catch (err) {
    return (err as Error).message
  }
}

function v2Compile(schema: unknown): Compiled {
  try {
    return compileSchema(schema)
  } catch (err) {
    return err instanceof SchemaError ? err.message : `THROWN: ${(err as Error).message}`
  }
}

// @hyperjump is async to compile and keeps a global registry keyed by URI.
let hj: typeof import('@hyperjump/json-schema/draft-07') | null = null
let hjCounter = 0
async function hjCompile(schema: unknown): Promise<Compiled> {
  if (!hj) {
    hj = await import('@hyperjump/json-schema/draft-07')
    // Side effect only (registers the format handlers); it ships no types.
    const formats = '@hyperjump/json-schema/formats'
    await import(formats)
    hj.setShouldValidateFormat(true)
  }
  const uri = `https://diff.invalid/schema/${hjCounter++}`
  try {
    hj.registerSchema(
      structuredClone(schema) as never,
      uri,
      'http://json-schema.org/draft-07/schema',
    )
    const v = await hj.validate(uri)
    return (data) => (v(data as never).valid ? [] : ['invalid'])
  } catch (err) {
    return (err as Error).message.slice(0, 300)
  }
}

interface Trio {
  ajv: Compiled
  v2: Compiled
  hj: Compiled
}

async function compileAll(schema: unknown): Promise<Trio> {
  return { ajv: ajvCompile(schema), v2: v2Compile(schema), hj: await hjCompile(schema) }
}

// --- Comparison -------------------------------------------------------------------

const sameSet = (a: string[], b: string[]) => {
  const x = [...a].sort()
  const y = [...b].sort()
  return x.length === y.length && x.every((v, i) => v === y[i])
}

class Tally {
  checked = 0
  agreeValid = 0
  agreeInvalid = 0
  sameMessages = 0
  /** v2 reported some of AJV's messages: it short-circuits, AJV ran with allErrors. */
  subsetMessages = 0
  hjChecked = 0
  hjAgree = 0
  disagreements: string[] = []
  messageDiffs: string[] = []
  hjDisagreements: string[] = []
  /** Schemas both refused to compile, with both messages. */
  bothRejected: string[] = []

  constructor(readonly name: string) {}

  compare(label: string, t: Trio, data: unknown): void {
    if (typeof t.ajv === 'string' || typeof t.v2 === 'string') return // reported at compile
    this.checked++
    const ae = t.ajv(data)
    const be = t.v2(data)
    const aValid = ae.length === 0
    const bValid = be.length === 0
    const show = (e: string[]) => (e.length ? JSON.stringify(e) : 'valid')
    if (aValid !== bValid) {
      this.disagreements.push(`  ${label}\n    ajv: ${show(ae)}\n    v2:  ${show(be)}`)
    } else if (aValid) {
      this.agreeValid++
    } else {
      this.agreeInvalid++
      if (sameSet(ae, be)) this.sameMessages++
      else if (be.every((m) => ae.includes(m))) this.subsetMessages++
      else this.messageDiffs.push(`  ${label}\n    ajv: ${show(ae)}\n    v2:  ${show(be)}`)
    }
    if (typeof t.hj !== 'string') {
      this.hjChecked++
      const hValid = t.hj(data).length === 0
      if (hValid === aValid) this.hjAgree++
      else
        this.hjDisagreements.push(
          `  ${label}: ajv ${show(ae)}, hyperjump ${hValid ? 'valid' : 'invalid'}`,
        )
    }
  }

  print(): void {
    const list = (lines: string[]) => {
      for (const line of lines.slice(0, MAX_LISTED)) console.log(line)
      if (lines.length > MAX_LISTED) console.log(`  … and ${lines.length - MAX_LISTED} more`)
    }
    console.log(`\n${this.name}: ${this.checked} checked`)
    console.log(`  agree valid:   ${this.agreeValid}`)
    console.log(
      `  agree invalid: ${this.agreeInvalid} (identical messages: ${this.sameMessages}, ` +
        `v2's a subset of AJV's: ${this.subsetMessages})`,
    )
    console.log(`  disagree:      ${this.disagreements.length}`)
    list(this.disagreements)
    if (this.messageDiffs.length) {
      console.log(`  verdicts agree, messages differ: ${this.messageDiffs.length}`)
      list(this.messageDiffs)
    }
    if (this.bothRejected.length) {
      console.log(`  schemas both refused to compile: ${this.bothRejected.length}`)
      list(this.bothRejected)
    }
    console.log(`  hyperjump agrees with ajv on ${this.hjAgree}/${this.hjChecked}`)
    list(this.hjDisagreements)
  }
}

// --- Mutations (pass 3) -----------------------------------------------------------

const FORMAT_CORPUS = [
  '',
  'x',
  '2020-01-01',
  '2020-02-29',
  '2021-02-29',
  '2020-13-01',
  '20200101',
  '12:00:00',
  '12:00:00Z',
  '12:00:00+01:00',
  '23:59:60Z',
  '2020-01-01T00:00:00',
  '2020-01-01T00:00:00Z',
  '2020-01-01T00:00:00.123Z',
  '2020-01-01t00:00:00z',
  '2020-01-01 00:00:00Z',
  '2020-01-01T00:00:00+0100',
  '2020-01-01T00:00:00+01:00',
  '2020-01-01T00:00:00+25:00',
  '2020-01-01T00:00:00+01:99',
  '2020-12-31T23:59:60Z',
  '2020-12-31T22:59:60-01:00',
  '2020-12-31T12:59:60Z',
  '2020-02-30T00:00:00Z',
  'a@b',
  'a@b.co',
  'a.b+c@example.org',
  '"a b"@example.org',
  'a..b@example.org',
  '.a@example.org',
  'a@-example.org',
  'a@exa_mple.org',
  `${'a'.repeat(65)}@example.org`,
  `a@${'b'.repeat(64)}.org`,
  'user@[127.0.0.1]',
  'http://example.com',
  'https://example.com/a b',
  'https://example.com/a%20b?q=1#f',
  'https://例子.测试/',
  'HTTP://EXAMPLE.COM/%zz',
  'example.com',
  '/relative/path',
  '#frag',
  'urn:isbn:0451450523',
  'mailto:a@example.org',
  'doi:10.1000/182',
  'http://[::1]/',
  'ftp://ftp.example.com/file',
  '550e8400-e29b-41d4-a716-446655440000',
  'urn:uuid:550e8400-e29b-41d4-a716-446655440000',
  '550E8400-E29B-41D4-A716-446655440000',
  '550e8400e29b41d4a716446655440000',
  '127.0.0.1',
  '001.002.003.004',
  '256.0.0.1',
  '::1',
  'example',
  'ex_ample.com',
  '-example.com',
  'P1D',
  'P1.5D',
  'PT',
  '/a/b~0c',
  '/a~2',
  '0/a',
  '^[a-z]+$',
  '(',
  '\\p{L}',
  'a\\Z',
  'QUJD',
  'QUJ',
]
const ALL_FORMATS = [
  'date',
  'time',
  'date-time',
  'iso-time',
  'iso-date-time',
  'duration',
  'uri',
  'uri-reference',
  'uri-template',
  'url',
  'email',
  'hostname',
  'ipv4',
  'ipv6',
  'regex',
  'uuid',
  'json-pointer',
  'json-pointer-uri-fragment',
  'relative-json-pointer',
  'byte',
  'int32',
  'int64',
  'float',
  'double',
  'password',
  'binary',
]

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

function wrongType(v: unknown): unknown {
  if (typeof v === 'string') return 12345
  if (typeof v === 'number') return Number.isInteger(v) ? 1.5 : 'x'
  if (Array.isArray(v)) return {}
  if (isObject(v)) return []
  return 'x'
}

/** Labelled variants of `data` that probe the keywords its schema uses. */
function* mutations(schema: unknown, data: unknown): Generator<[string, unknown]> {
  if (!isObject(data)) {
    yield ['wrong type', wrongType(data)]
    return
  }
  yield ['extra field', { ...data, __extra: 1 }]
  yield ['not an object', [data]]
  if (!isObject(schema)) return
  for (const k of Array.isArray(schema.required) ? (schema.required as string[]) : []) {
    if (!(k in data)) continue
    const copy = { ...data }
    delete copy[k]
    yield [`drop required ${k}`, copy]
  }
  const props = isObject(schema.properties) ? schema.properties : {}
  for (const [k, sub] of Object.entries(props)) {
    if (!(k in data)) continue
    yield [`${k}: wrong type`, { ...data, [k]: wrongType(data[k]) }]
    yield [`${k}: null`, { ...data, [k]: null }]
    if (!isObject(sub)) continue
    if (typeof sub.format === 'string' || typeof sub.pattern === 'string') {
      for (const s of FORMAT_CORPUS) yield [`${k}: ${JSON.stringify(s)}`, { ...data, [k]: s }]
    }
    if (Array.isArray(sub.enum)) yield [`${k}: not in enum`, { ...data, [k]: '__not_in_enum__' }]
    const v = data[k]
    if (Array.isArray(v) && v.length > 0) {
      yield [`${k}[0]: wrong type`, { ...data, [k]: [wrongType(v[0]), ...v.slice(1)] }]
      if (isObject(v[0])) {
        for (const ik of Object.keys(v[0])) {
          const item = { ...v[0], [ik]: wrongType(v[0][ik]) }
          yield [`${k}[0].${ik}: wrong type`, { ...data, [k]: [item, ...v.slice(1)] }]
        }
      }
    }
    if (isObject(v)) {
      for (const ik of Object.keys(v)) {
        yield [`${k}.${ik}: wrong type`, { ...data, [k]: { ...v, [ik]: wrongType(v[ik]) } }]
      }
      yield [`${k}: extra field`, { ...data, [k]: { ...v, __extra: 1 } }]
    }
  }
}

// --- Survey -----------------------------------------------------------------------

const LATER_KEYWORDS = new Set([
  '$recursiveRef',
  '$recursiveAnchor',
  '$anchor',
  '$defs',
  '$vocabulary',
  '$dynamicRef',
  '$dynamicAnchor',
  'unevaluatedProperties',
  'unevaluatedItems',
  'dependentRequired',
  'dependentSchemas',
  'prefixItems',
  'minContains',
  'maxContains',
])
const DATA_KEYWORDS = new Set(['enum', 'const', 'default', 'examples', 'required'])
const MAP_KEYWORDS = new Set([
  'properties',
  'patternProperties',
  'definitions',
  '$defs',
  'dependencies',
])

const count = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1)

interface Survey {
  $schema: Map<string, number>
  formats: Map<string, number>
  keywords: Map<string, number>
  refs: Map<string, number>
  refWithSiblings: number
  privateFields: number
}

function surveySchema(node: unknown, s: Survey, root = true): void {
  if (Array.isArray(node)) {
    for (const item of node) surveySchema(item, s, false)
    return
  }
  if (!isObject(node)) return
  if (root) count(s.$schema, typeof node.$schema === 'string' ? node.$schema : '(none)')
  if (typeof node.format === 'string') count(s.formats, node.format)
  if (typeof node.$ref === 'string') {
    const r = node.$ref
    count(
      s.refs,
      r.startsWith('#/definitions/')
        ? '#/definitions/…'
        : r.startsWith('#/$defs/')
          ? '#/$defs/…'
          : r,
    )
    if (Object.keys(node).some((k) => !['$ref', 'description', 'title'].includes(k))) {
      s.refWithSiblings++
    }
  }
  for (const [k, v] of Object.entries(node)) {
    count(s.keywords, k)
    if (DATA_KEYWORDS.has(k)) continue
    if (MAP_KEYWORDS.has(k) && isObject(v)) {
      for (const sub of Object.values(v)) {
        if (k === 'properties' && isObject(sub) && sub.private === true) s.privateFields++
        surveySchema(sub, s, false)
      }
    } else {
      surveySchema(v, s, false)
    }
  }
}

const sortedCounts = (m: Map<string, number>) =>
  [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))

// --- Main -------------------------------------------------------------------------

async function main() {
  mkdirSync(DATA, { recursive: true })
  const collections = await listCollections()
  console.log(`collections listed: ${collections.length}`)

  // Every distinct schema (by content) across every version, and where it was seen.
  const schemas = new Map<string, { schema: unknown; seenIn: string[] }>()
  const latest: { key: string; semver: string; schemas: Record<string, unknown> }[] = []
  let versionCount = 0
  for (const c of collections) {
    const key = `${c.ownerSlug}/${c.slug}`
    if (!c.latestVersion) {
      console.log(`  ${key}: no versions, skipped`)
      continue
    }
    const base = `${API}/collections/${key}`
    const versions = await cachedJson<{ semver: string }[]>(
      `${key}/versions.json`,
      `${base}/versions`,
    )
    for (const v of versions) {
      versionCount++
      const detail = await cachedJson<{ schemas?: Record<string, unknown> }>(
        `${key}/versions/${v.semver}.json`,
        `${base}/versions/${v.semver}`,
      )
      for (const [slug, schema] of Object.entries(detail.schemas ?? {})) {
        const id = JSON.stringify(schema)
        const entry = schemas.get(id) ?? { schema, seenIn: [] }
        entry.seenIn.push(`${key}@${v.semver}:${slug}`)
        schemas.set(id, entry)
      }
      if (v.semver === c.latestVersion) {
        latest.push({ key, semver: v.semver, schemas: detail.schemas ?? {} })
      }
    }
  }

  const survey: Survey = {
    $schema: new Map(),
    formats: new Map(),
    keywords: new Map(),
    refs: new Map(),
    refWithSiblings: 0,
    privateFields: 0,
  }
  for (const { schema } of schemas.values()) surveySchema(schema, survey)

  const started = Date.now()
  const progress = (what: string) =>
    process.stderr.write(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${what}\n`)
  progress('pass 1: compile')
  // Pass 1: compile.
  const compileReport: string[] = []
  let compileAgree = 0
  for (const { schema, seenIn } of schemas.values()) {
    const t = await compileAll(schema)
    const ok = [t.ajv, t.v2, t.hj].map((c) => typeof c !== 'string')
    if (ok[0] === ok[1] && ok[0] === ok[2]) compileAgree++
    if (ok.includes(false)) {
      const show = (c: Compiled) => (typeof c === 'string' ? c : 'ok')
      compileReport.push(
        `  ${seenIn[0]}${seenIn.length > 1 ? ` (+${seenIn.length - 1} more)` : ''}\n` +
          `    ajv: ${show(t.ajv)}\n    v2:  ${show(t.v2)}\n    hyperjump: ${show(t.hj)}`,
      )
    }
  }

  // Passes 2 and 3: records of each latest version, and mutations of a sample.
  const production = new Tally('production records')
  const mutated = new Tally('mutated records')
  for (const { key, semver, schemas: typeSchemas } of latest) {
    progress(`pass 2/3: ${key}@${semver}`)
    const byType = new Map<string, Trio>()
    for (const [slug, schema] of Object.entries(typeSchemas))
      byType.set(slug, await compileAll(schema))
    const sampled = new Map<string, number>()
    const file = await cachedFile(
      `${key}/records-${semver}.ndjson`,
      `${API}/collections/${key}/versions/${semver}/records.ndjson`,
    )
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
    for await (const line of lines) {
      if (!line) continue
      const rec = JSON.parse(line) as { id: string; type: string; data: unknown }
      const t = byType.get(rec.type)
      if (!t) throw new Error(`${key}@${semver}: no schema for type ${rec.type}`)
      const label = `${key}@${semver} ${rec.type} ${JSON.stringify(rec.id)}`
      const n = sampled.get(rec.type) ?? 0
      if (QUICK && n >= MUTATE_SAMPLE) continue
      production.compare(label, t, rec.data)
      // Large records are skipped: AJV takes seconds per call on some of them.
      if (n < MUTATE_SAMPLE && line.length < MUTATE_MAX_BYTES) {
        sampled.set(rec.type, n + 1)
        for (const [what, data] of mutations(typeSchemas[rec.type], rec.data)) {
          mutated.compare(`${label} [${what}]`, t, data)
        }
      }
    }
  }

  progress('pass 3b: format corpus')
  // Pass 3b: every format keyword over the corpus, on strings and on numbers.
  const formatTally = new Tally('format corpus')
  for (const f of ALL_FORMATS) {
    const t = await compileAll({ format: f })
    for (const s of [...FORMAT_CORPUS, 2 ** 31, 1.5, -1]) {
      formatTally.compare(`format ${f}: ${JSON.stringify(s)}`, t, s)
    }
  }

  progress('pass 3c: keyword corpus')
  // Pass 3c: every draft-07 keyword, and a few schema shapes, over small instances.
  const keywordTally = new Tally('keyword corpus')
  for (const [schema, instances] of KEYWORD_CORPUS) {
    const t = await compileAll(schema)
    const show = (c: Compiled) => (typeof c === 'string' ? c : 'ok')
    const failed = [t.ajv, t.v2].map((c) => typeof c === 'string')
    if (failed[0] !== failed[1]) {
      keywordTally.disagreements.push(
        `  compile ${JSON.stringify(schema)}\n    ajv: ${show(t.ajv)}\n    v2:  ${show(t.v2)}`,
      )
    } else if (failed[0]) {
      keywordTally.bothRejected.push(
        `  ${JSON.stringify(schema)}\n    ajv: ${show(t.ajv)}\n    v2:  ${show(t.v2)}`,
      )
    }
    if (failed[0] || failed[1]) continue
    for (const data of instances)
      keywordTally.compare(`${JSON.stringify(schema)} ← ${JSON.stringify(data)}`, t, data)
  }

  // --- Report ---------------------------------------------------------------------
  console.log(`versions: ${versionCount} (latest: ${latest.length})`)
  console.log(`distinct schemas: ${schemas.size}`)
  console.log(`\n$schema values (distinct schemas):`)
  for (const [k, n] of sortedCounts(survey.$schema)) console.log(`  ${n}\t${k}`)
  console.log(`formats (occurrences):`)
  for (const [k, n] of sortedCounts(survey.formats)) console.log(`  ${n}\t${k}`)
  console.log(`$ref targets (occurrences):`)
  for (const [k, n] of sortedCounts(survey.refs)) console.log(`  ${n}\t${k}`)
  console.log(`$ref with sibling keywords: ${survey.refWithSiblings}`)
  console.log(`field-level "private": true: ${survey.privateFields}`)
  const later = sortedCounts(survey.keywords).filter(([k]) => LATER_KEYWORDS.has(k))
  console.log(
    `2019-09+ keywords: ${later.length ? later.map(([k, n]) => `${k}=${n}`).join(', ') : 'none'}`,
  )
  console.log(`all keys in schema positions (occurrences):`)
  console.log(
    '  ' +
      sortedCounts(survey.keywords)
        .map(([k, n]) => `${k}=${n}`)
        .join(', '),
  )
  if (ajvWarnings.size) console.log(`AJV warnings: ${[...ajvWarnings].join(' | ')}`)

  console.log(`\nschema compile: ${compileAgree}/${schemas.size} agree (ajv, v2, hyperjump)`)
  for (const line of compileReport) console.log(line)

  production.print()
  mutated.print()
  formatTally.print()
  keywordTally.print()
}

/** [schema, instances]: each instance is validated by all three. */
const KEYWORD_CORPUS: [unknown, unknown[]][] = [
  [true, [1, null]],
  [false, [1]],
  [{}, [1, 'a', null, [], {}]],
  [{ type: 'integer' }, [1, 1.0, 1.5, '1', 2 ** 53, -0]],
  [{ type: ['string', 'null'] }, ['a', null, 1]],
  [{ type: 'number' }, [1, 'x']],
  [{ enum: [1, 'a', null, [1], { a: 1 }] }, [1, 'a', null, [1], { a: 1 }, 2, [2], { a: 2 }, true]],
  [{ const: { a: [1, 2] } }, [{ a: [1, 2] }, { a: [2, 1] }]],
  [{ const: 1 }, [1, 1.0, '1']],
  [{ multipleOf: 0.01 }, [0.07, 0.1, 1.23, 19.99]],
  [{ multipleOf: 3 }, [9, 10, 4.5]],
  [{ minimum: 1, maximum: 3 }, [0, 1, 3, 4, 'x']],
  [{ exclusiveMinimum: 1, exclusiveMaximum: 3 }, [1, 2, 3]],
  [{ minLength: 2, maxLength: 3 }, ['a', 'ab', 'abcd', '😀', '😀😀', 'é']],
  [{ pattern: '^a' }, ['abc', 'bac', 1]],
  [{ pattern: '\\p{Lu}' }, ['A', 'a']],
  [{ pattern: '^.$' }, ['😀']],
  [{ items: { type: 'string' } }, [['a'], ['a', 1, 2], 'x']],
  [
    { items: [{ type: 'string' }, { type: 'number' }] },
    [
      ['a', 1],
      [1, 'a'],
      ['a', 1, null],
    ],
  ],
  [{ items: [{ type: 'string' }], additionalItems: false }, [['a'], ['a', 1], ['a', 1, 2]]],
  [
    { items: [{ type: 'string' }], additionalItems: { type: 'number' } },
    [
      ['a', 1],
      ['a', 'b', 'c'],
    ],
  ],
  [{ additionalItems: false }, [[1, 2]]],
  [{ minItems: 1, maxItems: 2 }, [[], [1], [1, 2, 3]]],
  [
    { uniqueItems: true },
    [
      [1, 2],
      [1, 1],
      [{ a: 1 }, { a: 1 }],
      [1, 2, 1, 2],
      [[1], [1]],
    ],
  ],
  [{ contains: { type: 'string' } }, [[1, 'a'], [1, 2], []]],
  [{ minProperties: 1, maxProperties: 2 }, [{}, { a: 1 }, { a: 1, b: 2, c: 3 }]],
  [{ required: ['a', 'b'] }, [{ a: 1, b: 2 }, { a: 1 }, {}, []]],
  [
    { properties: { a: { type: 'string' }, 'x/y~z': { type: 'number' } } },
    [{ a: 'x' }, { a: 1 }, { 'x/y~z': 'q' }],
  ],
  [
    { properties: { 'a b': { type: 'string' }, 'é%': { type: 'string' } } },
    [{ 'a b': 1, 'é%': 2 }],
  ],
  [{ patternProperties: { '^x-': { type: 'string' } } }, [{ 'x-a': 'ok', 'x-b': 1, y: 1 }]],
  [{ properties: { a: {} }, additionalProperties: false }, [{ a: 1 }, { a: 1, b: 2, c: 3 }]],
  [
    { properties: { a: {} }, patternProperties: { '^p': {} }, additionalProperties: false },
    [{ a: 1, p1: 2 }, { q: 1 }],
  ],
  [{ additionalProperties: { type: 'string' } }, [{ a: 'x', b: 1 }]],
  [{ properties: { a: false } }, [{ a: 1 }, {}]],
  [{ dependencies: { a: ['b', 'c'] } }, [{ a: 1 }, { a: 1, b: 1, c: 1 }, { b: 1 }]],
  [{ dependencies: { a: { required: ['b'] } } }, [{ a: 1 }, { a: 1, b: 1 }]],
  [{ propertyNames: { maxLength: 2 } }, [{ ab: 1 }, { abc: 1 }]],
  [{ propertyNames: { pattern: '^[a-z]+$' } }, [{ A: 1, b: 2 }]],
  [
    { if: { type: 'string' }, then: { minLength: 2 }, else: { type: 'number' } },
    ['a', 'ab', 1, null],
  ],
  [
    { if: { properties: { k: { const: 'x' } } }, then: { required: ['v'] } },
    [{ k: 'x' }, { k: 'y' }],
  ],
  [{ allOf: [{ type: 'string' }, { minLength: 2 }] }, ['a', 'ab', 1]],
  [{ anyOf: [{ type: 'string' }, { type: 'number' }] }, ['a', 1, null]],
  [{ oneOf: [{ type: 'integer' }, { type: 'number' }] }, [1, 1.5, 'x']],
  [{ not: { type: 'string' } }, [1, 'a']],
  [{ format: 'email' }, ['a@b.co', 'a@b', 5]],
  [{ format: 'unknown-format' }, ['x']],
  [{ type: 'object', 'x-ref-type': 'T', version: '1', private: true }, [{}, 1]],
  [
    { definitions: { s: { type: 'string' } }, properties: { a: { $ref: '#/definitions/s' } } },
    [{ a: 'x' }, { a: 1 }],
  ],
  [{ $defs: { s: { type: 'string' } }, properties: { a: { $ref: '#/$defs/s' } } }, [{ a: 1 }]],
  [
    {
      definitions: { s: { type: 'string' } },
      properties: { a: { $ref: '#/definitions/s', maxLength: 1 } },
    },
    [{ a: 'xy' }],
  ],
  [
    { $ref: '#/definitions/d', definitions: { d: { type: 'object', required: ['t'] } } },
    [{ t: 1 }, {}],
  ],
  [{ properties: { a: { type: 'string' } }, items: { $ref: '#/properties/a' } }, [['x', 1]]],
  [{ definitions: { 'a b': { type: 'string' } }, $ref: '#/definitions/a%20b' }, ['x', 1]],
  [{ definitions: { 'a/b': { type: 'string' } }, $ref: '#/definitions/a~1b' }, ['x', 1]],
  [
    {
      $id: 'https://example.org/s',
      definitions: { a: { type: 'string' } },
      $ref: 'https://example.org/s#/definitions/a',
    },
    ['x', 1],
  ],
  [
    {
      $id: 'https://example.org/root.json',
      definitions: { a: { $id: 'a.json', type: 'string' } },
      $ref: 'a.json',
    },
    ['x', 1],
  ],
  [{ definitions: { a: { $anchor: 'foo', type: 'string' } }, $ref: '#foo' }, ['x', 1]],
  [
    {
      definitions: {
        n: {
          type: 'object',
          properties: { c: { type: 'array', items: { $ref: '#/definitions/n' } } },
        },
      },
      $ref: '#/definitions/n',
    },
    [{ c: [{ c: [] }] }, { c: [{ c: [1] }] }],
  ],
  [{ id: 'other', definitions: { a: { type: 'string' } }, $ref: '#/definitions/a' }, ['x', 1]],
  [{ unevaluatedProperties: false, properties: { a: {} } }, [{ b: 1 }]],
  [{ dependentRequired: { a: ['b'] } }, [{ a: 1 }]],
  [{ dependentSchemas: { a: { required: ['b'] } } }, [{ a: 1 }]],
  [{ prefixItems: [{ type: 'string' }] }, [[1]]],
  [{ contains: { type: 'string' }, minContains: 2, maxContains: 2 }, [['a'], ['a', 'b', 'c']]],
  [{ $schema: 'http://json-schema.org/draft-07/schema' }, [1]],
  [{ $schema: 'http://json-schema.org/draft-07/schema#' }, [1]],
  [{ $schema: 'https://json-schema.org/draft-07/schema#' }, [1]],
  [{ $schema: 'http://json-schema.org/draft-04/schema#' }, [1]],
  [{ $schema: 'https://json-schema.org/draft/2020-12/schema' }, [1]],
  [
    { properties: { a: { $schema: 'http://json-schema.org/draft-04/schema#', type: 'string' } } },
    [{ a: 1 }],
  ],
  [{ type: 'text' }, [1]],
  [{ required: 'a' }, [1]],
  [{ pattern: '(' }, [1]],
  [{ pattern: '\\a' }, ['a']],
  [{ patternProperties: { '(': {} } }, [1]],
  [{ $ref: '#/definitions/missing' }, [1]],
  [{ $ref: 'https://remote.invalid/schema.json' }, [1]],
  [{ $ref: 'http://json-schema.org/draft-07/schema#' }, [{ type: 'string' }, { type: 3 }]],
  [{ enum: [] }, [1]],
  [{ minLength: -1 }, ['a']],
  [{ multipleOf: 0 }, [1]],
  [
    { properties: { a: { default: 'x', examples: ['y'], readOnly: true, $comment: 'c' } } },
    [{ a: 1 }],
  ],
  // Names that exist on Object.prototype are ordinary property names.
  [{ required: ['toString'] }, [{}, { toString: 1 }]],
  [{ properties: { constructor: { type: 'string' } } }, [{}, { constructor: 1 }]],
  [{ dependencies: { toString: ['b'] } }, [{}]],
  [{ format: 'hasOwnProperty' }, ['x']],
  [
    JSON.parse('{"properties":{"__proto__":{"type":"string"}}}'),
    [JSON.parse('{"__proto__":1}'), {}],
  ],
  // Every error, or the first per loop (schemas with branching keywords).
  [{ properties: { a: { type: 'string' }, b: { type: 'string' } } }, [{ a: 1, b: 2 }]],
  [
    { properties: { a: { type: 'string' }, b: { type: 'string' } }, not: { type: 'null' } },
    [{ a: 1, b: 2 }],
  ],
  [{ items: { type: 'string' }, anyOf: [{}] }, [[1, 2]]],
]

await main()
