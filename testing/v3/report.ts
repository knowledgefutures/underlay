/** The report page, built from the results folder. Filled in by step 11. */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function readResults(dir: string): Record<string, unknown>[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>)
}

export function writeReport(resultsDir: string, out: string): void {
  const results = readResults(resultsDir)
  writeFileSync(
    out,
    `<pre>${JSON.stringify(
      results.map((r) => [r.suite, r.scenario, r.label]),
      null,
      1,
    )}</pre>`,
  )
}
