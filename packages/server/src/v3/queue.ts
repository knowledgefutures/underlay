/**
 * The one way a commit to a v3 collection lands: "do this for collection X, one at a
 * time" (v3-deploy-plan.md, decision 4). Every v3 commit goes through `Ports.commits`.
 *
 * What goes through it is a `Landing` (landing.ts): plain JSON, so it can cross into a
 * Durable Object. Two implementations:
 *
 *   localQueue    an in-process lock (Node, tests). On a Worker without the Durable
 *                 Object it orders the commits of one isolate, and the library's rule
 *                 covers the rest: a lost number comes back as `base_moved`.
 *   durableQueue  a Durable Object for each collection (worker.ts, `CollectionCommits`),
 *                 which runs the landings it is sent one after another.
 */
import type { Ports } from '../ports.js'
import { type Landed, landCommit, type Landing } from './landing.js'

export interface CommitQueue {
  land(ports: Ports, landing: Landing): Promise<Landed>
}

/** Run work for a key one at a time, in this process. */
export function serially() {
  const tails = new Map<string, Promise<unknown>>()
  return async function run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const before = tails.get(key) ?? Promise.resolve()
    const mine = before.catch(() => {}).then(work)
    const tail = mine.catch(() => {})
    tails.set(key, tail)
    try {
      return await mine
    } finally {
      if (tails.get(key) === tail) tails.delete(key)
    }
  }
}

/** One at a time per collection, in this process. */
export function localQueue(): CommitQueue {
  const run = serially()
  return { land: (ports, l) => run(l.collectionId, () => landCommit(ports, l)) }
}

/** A Durable Object namespace, as far as the queue uses it. */
export interface CommitsNamespace {
  idFromName(name: string): unknown
  get(id: unknown): { fetch(req: Request): Promise<Response> }
}

/** One Durable Object per collection: it lands what it is sent, one at a time. */
export function durableQueue(ns: CommitsNamespace): CommitQueue {
  return {
    async land(_ports, l) {
      const stub = ns.get(ns.idFromName(l.collectionId))
      const res = await stub.fetch(
        new Request('https://commits/land', { method: 'POST', body: JSON.stringify(l) }),
      )
      if (!res.ok)
        throw new Error(`Commit queue for ${l.collectionId}: ${res.status} ${await res.text()}`)
      return (await res.json()) as Landed
    },
  }
}

/** The process's in-process queue, for ports that name none. */
export const defaultQueue: CommitQueue = localQueue()

export const commitsOf = (ports: Ports): CommitQueue => ports.commits ?? defaultQueue
