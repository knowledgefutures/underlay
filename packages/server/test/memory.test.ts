/**
 * Every push job's memory stays bounded on large records: scripts/memory.ts
 * pushes about 40 MB of records of several KB each (and updates spread over them)
 * through uploads, compaction in pieces, a parallel commit and indexing, and
 * reports each job's peak live memory. A job that held its records (rather than
 * streaming them) would show tens of MB of JS heap here.
 *
 * Only the JS heap is checked: array buffers (compressed parts and spans) are
 * bounded by the size constants, and Node releases them lazily after a GC, so
 * their readings vary from run to run. scripts/memory.ts with the defaults gives
 * the full picture at production sizes.
 */
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { expect, it } from 'vitest'

const run = promisify(execFile)

it('keeps every push job’s heap bounded on large records', async () => {
  const cwd = fileURLToPath(new URL('..', import.meta.url))
  const { stdout } = await run(
    process.execPath,
    [
      '--expose-gc',
      '--import',
      'tsx',
      'scripts/memory.ts',
      '--records',
      '4000',
      '--update',
      '1000',
      '--piece-mb',
      '8',
      '--unit-mb',
      '8',
      '--sample',
      '5',
    ],
    { cwd, maxBuffer: 16 * 1024 * 1024 },
  )
  const report = JSON.parse(stdout) as {
    recordMB: number
    jobs: Record<string, { n: number; heapMB: number }>
  }
  expect(report.recordMB).toBeGreaterThan(35)
  for (const job of ['push.compactPiece', 'commit.unit', 'commit.assemble', 'refs.index'])
    expect(report.jobs[job]?.n ?? 0, job).toBeGreaterThan(0)
  for (const [job, r] of Object.entries(report.jobs)) {
    // An upload holds its batch (8 MB) as text and records; nothing else holds records.
    expect(r.heapMB, job).toBeLessThan(job.startsWith('upload') ? 32 : 16)
  }
}, 180_000)
