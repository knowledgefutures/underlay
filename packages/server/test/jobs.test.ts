import { afterAll, describe, expect, it } from 'vitest'

import { drainSqliteJobs, QueueJobs, registerJob } from '../src/jobs.js'
import { cleanup, harness } from './harness.js'

afterAll(cleanup)

const fakeQueue = () => {
  const sent: string[] = []
  return {
    sent,
    async send(body: unknown) {
      sent.push((body as { type: string }).type)
    },
    async sendBatch(msgs: { body: unknown }[]) {
      for (const m of msgs) sent.push((m.body as { type: string }).type)
    },
  }
}

describe('job queues', () => {
  it('sends bulk jobs to the bulk queue and the rest to the interactive one', async () => {
    const interactive = fakeQueue()
    const bulk = fakeQueue()
    const jobs = new QueueJobs(interactive, bulk)
    await jobs.enqueue({ type: 'webhooks.deliver', deliveryId: 'd' })
    await jobs.enqueue({ type: 'commit.unit', unitId: 'u' })
    await jobs.enqueueBatch([
      { type: 'mirror.version', placementId: 'p' },
      { type: 'version.published', versionId: 'v' },
      ...Array.from({ length: 150 }, () => ({ type: 'commit.unit', unitId: 'u' })),
    ])
    expect(interactive.sent).toEqual(['webhooks.deliver', 'version.published'])
    // Hashing a whole file, indexing and the sweep are bulk work too.
    await jobs.enqueueBatch([
      { type: 'files.verify', uploadId: 'f' },
      { type: 'refs.index', versionId: 'v' },
      { type: 'maintenance.sweep' },
    ])
    expect(interactive.sent).toHaveLength(2)
    expect(bulk.sent).toHaveLength(155)
    expect(bulk.sent.slice(0, 2)).toEqual(['commit.unit', 'mirror.version'])

    // With one queue bound, everything goes there once.
    const one = fakeQueue()
    await new QueueJobs(one).enqueueBatch([
      { type: 'commit.unit', unitId: 'u' },
      { type: 'files.verify', uploadId: 'f' },
    ])
    expect(one.sent).toEqual(['commit.unit', 'files.verify'])
  })

  it('sends compactions to the compaction queue, or with the bulk jobs when there is none', async () => {
    const interactive = fakeQueue()
    const bulk = fakeQueue()
    const compact = fakeQueue()
    const jobs = new QueueJobs(interactive, bulk, compact)
    await jobs.enqueue({ type: 'push.compact', sessionId: 's', seq: 2 })
    await jobs.enqueueBatch([
      { type: 'push.compactPiece', sessionId: 's', seq: 2, piece: 0 },
      { type: 'push.commit', sessionId: 's' },
      { type: 'commit.unit', unitId: 'u' },
      { type: 'webhooks.deliver', deliveryId: 'd' },
      ...Array.from({ length: 150 }, (_, piece) => ({
        type: 'push.compactPiece',
        sessionId: 's',
        seq: 3,
        piece,
      })),
    ])
    expect(compact.sent).toHaveLength(152)
    expect(compact.sent.slice(0, 2)).toEqual(['push.compact', 'push.compactPiece'])
    // The commit, which claims each next round of compactions, stays with the units.
    expect(bulk.sent).toEqual(['push.commit', 'commit.unit'])
    expect(interactive.sent).toEqual(['webhooks.deliver'])

    // No compaction queue bound: compactions go with the other bulk jobs, once each.
    const one = fakeQueue()
    const two = fakeQueue()
    await new QueueJobs(one, two).enqueueBatch([
      { type: 'push.compactPiece', sessionId: 's', seq: 2, piece: 0 },
      { type: 'commit.unit', unitId: 'u' },
      { type: 'webhooks.deliver', deliveryId: 'd' },
    ])
    expect(two.sent).toEqual(['push.compactPiece', 'commit.unit'])
    expect(one.sent).toEqual(['webhooks.deliver'])
  })

  it('runs interactive jobs before bulk ones on Node', async () => {
    const h = await harness()
    const ran: string[] = []
    registerJob('test.small', async () => void ran.push('small'))
    // A real bulk type, its handler replaced (each test file has its own registry).
    registerJob('repo.repairLog', async () => void ran.push('bulk'))
    await h.ports.jobs.enqueue({ type: 'repo.repairLog', collectionId: 'x' })
    await h.ports.jobs.enqueue({ type: 'test.small' })
    await drainSqliteJobs(h.ports)
    expect(ran).toEqual(['small', 'bulk'])
  })
})
