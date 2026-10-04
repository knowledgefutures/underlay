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
      { type: 'files.verify', uploadId: 'f' },
      ...Array.from({ length: 150 }, () => ({ type: 'commit.unit', unitId: 'u' })),
    ])
    expect(interactive.sent).toEqual(['webhooks.deliver', 'files.verify'])
    expect(bulk.sent).toHaveLength(152)
    expect(bulk.sent.slice(0, 2)).toEqual(['commit.unit', 'mirror.version'])

    // With one queue bound, everything goes there once.
    const one = fakeQueue()
    await new QueueJobs(one).enqueueBatch([
      { type: 'commit.unit', unitId: 'u' },
      { type: 'files.verify', uploadId: 'f' },
    ])
    expect(one.sent).toEqual(['commit.unit', 'files.verify'])
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
