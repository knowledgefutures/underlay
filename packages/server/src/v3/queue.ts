/**
 * The one way a commit to a v3 collection is made: "do this for collection X, one at a
 * time" (v3-deploy-plan.md, decision 4). Every v3 commit goes through `commitQueue`.
 *
 * Phase 1: an in-process lock. On Node (dev, tests) that orders every commit to a
 * collection. On Workers it orders those within one isolate, and the library's own rule
 * covers the rest: a commit number is created only if absent, and a loser tries again at
 * the next number. That is correct whatever happens; the queue only saves the retries.
 * Phase 2 puts a Durable Object for each collection behind the same interface.
 */
export interface CommitQueue {
  run<T>(collectionId: string, work: () => Promise<T>): Promise<T>
}

/** One at a time per collection, in this process. */
export function localQueue(): CommitQueue {
  const tails = new Map<string, Promise<unknown>>()
  return {
    async run<T>(collectionId: string, work: () => Promise<T>): Promise<T> {
      const before = tails.get(collectionId) ?? Promise.resolve()
      const mine = before.catch(() => {}).then(work)
      const tail = mine.catch(() => {})
      tails.set(collectionId, tail)
      try {
        return await mine
      } finally {
        if (tails.get(collectionId) === tail) tails.delete(collectionId)
      }
    },
  }
}

/** The process's queue, until Phase 2 gives Workers another. */
export const commitQueue: CommitQueue = localQueue()
