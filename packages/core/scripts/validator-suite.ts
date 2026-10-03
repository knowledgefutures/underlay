/**
 * Validator evidence (edge-redesign-build.md, "Validator choice"):
 *
 *   1. the official JSON Schema Test Suite, draft-07, required and optional/format,
 *      against @cfworker/json-schema as shipped, @hyperjump/json-schema, and our
 *      wrapper (src/validate.ts), which implements v1's AJV dialect and so fails
 *      some draft-07 tests on purpose;
 *   2. throughput over the production records cached by diff-validators.ts.
 *
 *   npx tsx packages/core/scripts/validator-suite.ts --suite <JSON-Schema-Test-Suite dir> [--data <dir>]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { Validator } from '@cfworker/json-schema'
import { Ajv } from 'ajv'
import addFormatsModule from 'ajv-formats'

import { compileSchema } from '../src/validate.js'

const args = process.argv.slice(2)
const option = (name: string, fallback?: string) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback
}
const SUITE = option('--suite')
const DATA = option('--data', '/Users/travis/.claude-kf/jobs/71495a02/tmp/validator-data')!

type Check = (data: unknown) => boolean
type Impl = { name: string; compile(schema: unknown): Promise<Check> }

const remotes: [string, unknown][] = []

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (f.endsWith('.json')) out.push(p)
  }
  return out
}

// --- Implementations --------------------------------------------------------------

const cfworker: Impl = {
  name: '@cfworker/json-schema',
  async compile(schema) {
    const v = new Validator(schema as never, '7', true)
    for (const [uri, s] of remotes) v.addSchema(s as never, uri)
    return (data) => v.validate(data).valid
  },
}

let hjCounter = 0
let hj: typeof import('@hyperjump/json-schema/draft-07') | null = null
const hyperjump: Impl = {
  name: '@hyperjump/json-schema',
  async compile(schema) {
    if (!hj) {
      hj = await import('@hyperjump/json-schema/draft-07')
      const formats = '@hyperjump/json-schema/formats'
      await import(formats)
      hj.setShouldValidateFormat(true)
      for (const [uri, s] of remotes) {
        try {
          hj.registerSchema(
            structuredClone(s) as never,
            uri,
            'http://json-schema.org/draft-07/schema',
          )
        } catch {
          // Remotes for other drafts.
        }
      }
    }
    const uri = `https://suite.invalid/schema/${hjCounter++}`
    hj.registerSchema(
      structuredClone(schema) as never,
      uri,
      'http://json-schema.org/draft-07/schema',
    )
    const v = await hj.validate(uri)
    return (data) => v(data as never).valid
  },
}

const ours: Impl = {
  name: 'v2 wrapper (AJV dialect)',
  async compile(schema) {
    const v = compileSchema(schema)
    return (data) => v(data).length === 0
  },
}

const addFormats = addFormatsModule as unknown as (ajv: Ajv) => Ajv
const ajv: Impl = {
  name: 'ajv (v1, Node only)',
  async compile(schema) {
    const a = new Ajv({ allErrors: true, strict: false })
    addFormats(a)
    const v = a.compile(schema as never)
    return (data) => v(data) as boolean
  },
}

// --- 1. Test suite ----------------------------------------------------------------

interface Case {
  description: string
  schema: unknown
  tests: { description: string; data: unknown; valid: boolean }[]
}

async function runSuite(impl: Impl, files: string[], root: string) {
  let pass = 0
  let fail = 0
  let error = 0
  const failures: string[] = []
  for (const file of files) {
    const cases = JSON.parse(readFileSync(file, 'utf8')) as Case[]
    for (const c of cases) {
      let check: Check
      try {
        check = await impl.compile(c.schema)
      } catch (err) {
        error += c.tests.length
        failures.push(
          `${relative(root, file)}: ${c.description}: compile: ${(err as Error).message.slice(0, 100)}`,
        )
        continue
      }
      for (const t of c.tests) {
        let got: boolean
        try {
          got = check(t.data)
        } catch (err) {
          error++
          failures.push(
            `${relative(root, file)}: ${c.description} / ${t.description}: threw ${(err as Error).message.slice(0, 80)}`,
          )
          continue
        }
        if (got === t.valid) pass++
        else {
          fail++
          failures.push(`${relative(root, file)}: ${c.description} / ${t.description}`)
        }
      }
    }
  }
  return { pass, fail, error, failures }
}

if (SUITE) {
  for (const f of walk(join(SUITE, 'remotes'))) {
    remotes.push([
      `http://localhost:1234/${relative(join(SUITE, 'remotes'), f)}`,
      JSON.parse(readFileSync(f, 'utf8')),
    ])
  }
  const dir = join(SUITE, 'tests', 'draft7')
  const required = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => join(dir, f))
  const formats = walk(join(dir, 'optional', 'format'))
  const otherOptional = readdirSync(join(dir, 'optional'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => join(dir, 'optional', f))
  for (const [label, files] of [
    ['draft7 required', required],
    ['draft7 optional/format', formats],
    ['draft7 optional (other)', otherOptional],
  ] as const) {
    console.log(`\n== ${label} (${files.length} files)`)
    for (const impl of [cfworker, hyperjump, ours, ajv]) {
      const r = await runSuite(impl, files, dir)
      const total = r.pass + r.fail + r.error
      console.log(
        `${impl.name.padEnd(28)} ${r.pass}/${total} pass, ${r.fail} fail, ${r.error} error`,
      )
      if (process.env.VERBOSE || label === 'draft7 required') {
        for (const f of r.failures.slice(0, 40)) console.log(`    ${f}`)
        if (r.failures.length > 40) console.log(`    … ${r.failures.length - 40} more`)
      }
    }
  }
}

// --- 2. Throughput ----------------------------------------------------------------

interface Workload {
  name: string
  schemas: Record<string, unknown>
  records: { type: string; data: unknown }[]
}

function loadWorkload(): Workload[] {
  const out: Workload[] = []
  for (const owner of readdirSync(DATA)) {
    const od = join(DATA, owner)
    if (!statSync(od).isDirectory()) continue
    for (const slug of readdirSync(od)) {
      const cd = join(od, slug)
      const recs = readdirSync(cd).filter((f) => f.startsWith('records-'))
      if (recs.length === 0) continue
      const semver = recs[0]!.slice('records-'.length, -'.ndjson'.length)
      const version = JSON.parse(readFileSync(join(cd, 'versions', `${semver}.json`), 'utf8')) as {
        schemas: Record<string, unknown> | { slug: string; schema: unknown }[]
      }
      const schemas: Record<string, unknown> = Array.isArray(version.schemas)
        ? Object.fromEntries(version.schemas.map((s) => [s.slug, s.schema]))
        : version.schemas
      const records = readFileSync(join(cd, recs[0]!), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { type: string; data: unknown })
      out.push({ name: `${owner}/${slug}`, schemas, records })
    }
  }
  return out
}

async function bench(impl: Impl, work: Workload[]) {
  let compileMs = 0
  let validateMs = 0
  let n = 0
  let valid = 0
  const per: { name: string; ms: number; n: number }[] = []
  for (const w of work) {
    const t0 = performance.now()
    const checks = new Map<string, Check>()
    for (const [slug, s] of Object.entries(w.schemas)) {
      try {
        checks.set(slug, await impl.compile(s))
      } catch {
        // Counted by diff-validators.ts; skip here.
      }
    }
    const t1 = performance.now()
    for (const r of w.records) {
      const check = checks.get(r.type)
      if (!check) continue
      if (check(r.data)) valid++
      n++
    }
    const t2 = performance.now()
    compileMs += t1 - t0
    validateMs += t2 - t1
    per.push({ name: w.name, ms: t2 - t1, n: w.records.length })
  }
  return { compileMs, validateMs, n, valid, per }
}

if (!args.includes('--no-bench')) {
  const work = loadWorkload()
  const total = work.reduce((s, w) => s + w.records.length, 0)
  console.log(
    `\n== throughput: ${work.length} collections, ${total} production records (Node ${process.version})`,
  )
  for (const impl of [cfworker, hyperjump, ours, ajv]) {
    // Best of three full passes (the first warms the JIT).
    let r = await bench(impl, work)
    for (let i = 0; i < 2; i++) {
      const again = await bench(impl, work)
      if (again.validateMs < r.validateMs) r = again
    }
    console.log(
      `${impl.name.padEnd(28)} ${Math.round(r.n / (r.validateMs / 1000)).toLocaleString()} records/s (${(r.validateMs / 1000).toFixed(2)} s for ${r.n}, ${r.valid} valid), compile ${r.compileMs.toFixed(0)} ms`,
    )
    // One recursive collection dominates some totals; show the rest without it.
    const slowest = r.per.reduce((a, b) => (b.ms > a.ms ? b : a))
    const restMs = r.validateMs - slowest.ms
    const restN = r.n - slowest.n
    console.log(
      `${''.padEnd(28)} slowest: ${slowest.name} ${slowest.ms.toFixed(0)} ms for ${slowest.n}; the rest ${Math.round(restN / (restMs / 1000)).toLocaleString()} records/s`,
    )
  }
}
