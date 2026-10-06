/**
 * Validator throughput inside workerd (the Workers runtime), for the validator
 * choice in edge-redesign-build.md. data.json is a sample of the production
 * records cached by diff-validators.ts (not committed; see validator-suite.ts).
 *
 *   cd packages/protocol/scripts/workerd-bench && npx wrangler dev --local --port 4390
 *   curl localhost:4390
 *
 * Workers only advance the clock across I/O, so each timed section ends with a
 * timer await before reading Date.now().
 */
import { Validator } from '@cfworker/json-schema'
import { registerSchema, setShouldValidateFormat, validate } from '@hyperjump/json-schema/draft-07'
import '@hyperjump/json-schema/formats'

import { compileSchema } from '../../src/validate.js'
import data from './data.json'

type Check = (d: unknown) => boolean
type Work = {
  name: string
  schemas: Record<string, unknown>
  records: { type: string; data: unknown }[]
}

const tick = () => new Promise((r) => setTimeout(r, 0))
let n = 0

const impls: Record<string, (s: unknown) => Promise<Check>> = {
  cfworker: async (s) => {
    const v = new Validator(s as never, '7', true)
    return (d) => v.validate(d).valid
  },
  hyperjump: async (s) => {
    const uri = `https://bench.invalid/${n++}`
    registerSchema(structuredClone(s) as never, uri, 'http://json-schema.org/draft-07/schema')
    const v = await validate(uri)
    return (d) => v(d as never).valid
  },
  v2wrapper: async (s) => {
    const v = compileSchema(s)
    return (d) => v(d).length === 0
  },
}

async function run(compile: (s: unknown) => Promise<Check>) {
  const work = data as unknown as Work[]
  const checks: Map<string, Check>[] = []
  for (const w of work) {
    const m = new Map<string, Check>()
    for (const [slug, s] of Object.entries(w.schemas)) {
      try {
        m.set(slug, await compile(s))
      } catch {
        // Counted elsewhere.
      }
    }
    checks.push(m)
  }
  let best = Infinity
  let count = 0
  let valid = 0
  for (let round = 0; round < 3; round++) {
    await tick()
    const t0 = Date.now()
    count = 0
    valid = 0
    work.forEach((w, i) => {
      for (const r of w.records) {
        const c = checks[i]!.get(r.type)
        if (!c) continue
        if (c(r.data)) valid++
        count++
      }
    })
    await tick()
    best = Math.min(best, Date.now() - t0)
  }
  return { ms: best, count, valid, perSec: Math.round(count / (best / 1000)) }
}

setShouldValidateFormat(true)

export default {
  async fetch(): Promise<Response> {
    const out: Record<string, unknown> = {}
    for (const [name, compile] of Object.entries(impls)) out[name] = await run(compile)
    return Response.json(out)
  },
}
