import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'

import { MemoryBlobStore } from '../src/blob/memory.js'
import { MemoryCache } from '../src/cache.js'
import { openNodeDb } from '../src/db/node.js'
import * as schema from '../src/db/schema.js'
import { drainSqliteJobs, registerJob, SqliteJobs } from '../src/jobs.js'
import type { Ports } from '../src/ports.js'

const dirs: string[] = []
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})

async function tempDb() {
  const dir = await mkdtemp(join(tmpdir(), 'ul-db-'))
  dirs.push(dir)
  return openNodeDb(`file:${join(dir, 'test.sqlite')}`)
}

describe('SQLite on Node', () => {
  it('migrates and round-trips rows, including JSON and timestamps', async () => {
    const db = await tempDb()
    await db.insert(schema.organization).values({ id: 'org1', name: 'Org', slug: 'org' })
    const [c] = await db
      .insert(schema.collections)
      .values({
        organizationId: 'org1',
        slug: 'c',
        name: 'C',
        privateSalt: 'ab'.repeat(32),
        summary: { tags: ['x'] },
      })
      .returning()
    expect(c!.summary).toEqual({ tags: ['x'] })
    expect(c!.createdAt).toBeInstanceOf(Date)
    expect(Math.abs(c!.createdAt.getTime() - Date.now())).toBeLessThan(5000)
  })

  it('runs atomic batches, and rolls back the whole batch on failure', async () => {
    const db = await tempDb()
    await db.insert(schema.organization).values({ id: 'org1', name: 'Org', slug: 'org' })
    await expect(
      db.batch([
        db.insert(schema.organization).values({ id: 'org2', name: 'Two', slug: 'two' }),
        db.insert(schema.organization).values({ id: 'org3', name: 'Dup', slug: 'org' }), // unique violation
      ]),
    ).rejects.toThrow()
    expect(
      await db.select().from(schema.organization).where(eq(schema.organization.id, 'org2')),
    ).toEqual([])
  })
})

describe('SQLite jobs', () => {
  it('runs jobs, retries failures with backoff, and claims each job once', async () => {
    const db = await tempDb()
    const ports: Ports = {
      db,
      blobs: new MemoryBlobStore(),
      cache: new MemoryCache(),
      jobs: new SqliteJobs(db),
      waitUntil: () => {},
    }
    const seen: string[] = []
    let failOnce = true
    registerJob('test.echo', async (job) => {
      seen.push(String(job.value))
    })
    registerJob('test.flaky', async () => {
      if (failOnce) {
        failOnce = false
        throw new Error('boom')
      }
      seen.push('flaky ok')
    })
    await ports.jobs.enqueueBatch([
      { type: 'test.echo', value: 'a' },
      { type: 'test.echo', value: 'b' },
    ])
    await ports.jobs.enqueue({ type: 'test.flaky' })
    expect(await drainSqliteJobs(ports)).toBe(3)
    expect(seen.sort()).toEqual(['a', 'b'])
    // The flaky job is back in the queue with a future runAt.
    const [retry] = await db.select().from(schema.jobs)
    expect(retry!.status).toBe('queued')
    expect(retry!.attempts).toBe(1)
    await db.update(schema.jobs).set({ runAt: new Date(0) })
    expect(await drainSqliteJobs(ports)).toBe(1)
    expect(seen).toContain('flaky ok')
    expect(await db.select().from(schema.jobs)).toEqual([])
  })
})
