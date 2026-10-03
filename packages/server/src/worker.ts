/**
 * Cloudflare Workers entry: HTTP (fetch), background jobs (queue) and
 * schedules (scheduled). Bindings and secrets are in wrangler.jsonc.
 */
import type {
  D1Database,
  ExecutionContext,
  MessageBatch,
  Queue,
  ScheduledController,
} from '@cloudflare/workers-types'
import { ed25519Signer, type Signer } from '@underlay/repo'
import { S3BlobStore } from '@underlay/repo/blob/s3'

import './handlers.js'
import { createApp } from './app.js'
import { CfCache } from './cache.js'
import { openD1 } from './db/d1.js'
import { QueueJobs, runJob } from './jobs.js'
import type { JobMessage, Ports } from './ports.js'
import { createStores } from './stores.js'

export interface Env {
  DB: D1Database
  JOBS: Queue
  APP_URL: string
  DEPLOYMENT: string
  R2_ENDPOINT: string
  R2_BUCKET: string
  R2_ACCESS_KEY_ID: string
  R2_SECRET_ACCESS_KEY: string
  SIGNING_KEY: string
  REPO_PREFIX?: string
  INTERNAL_PREFIX?: string
}

let signer: Promise<Signer> | null = null

function makePorts(env: Env, ctx: ExecutionContext): Ports {
  const db = openD1(env.DB)
  const cache = new CfCache(caches as never, env.DEPLOYMENT)
  const bucket = new S3BlobStore({
    endpoint: env.R2_ENDPOINT,
    bucket: env.R2_BUCKET,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    region: 'auto',
  })
  return {
    db,
    stores: createStores(db, cache, {
      bucket,
      repoPrefix: env.REPO_PREFIX ?? 'repo',
      internalPrefix: env.INTERNAL_PREFIX ?? 'internal',
    }),
    cache,
    signer: () => (signer ??= ed25519Signer(env.SIGNING_KEY)),
    jobs: new QueueJobs(env.JOBS as never),
    waitUntil: (p) => ctx.waitUntil(p),
  }
}

const app = createApp((c) => {
  const env = c.env as unknown as Env
  return {
    ports: makePorts(env, c.executionCtx as unknown as ExecutionContext),
    config: { appUrl: env.APP_URL, deployment: env.DEPLOYMENT },
  }
})

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(req, env as never, ctx as never)
  },

  async queue(batch: MessageBatch<JobMessage>, env: Env, ctx: ExecutionContext): Promise<void> {
    const ports = makePorts(env, ctx)
    for (const msg of batch.messages) {
      try {
        await runJob(msg.body, ports)
        msg.ack()
      } catch (err) {
        console.error(`[jobs] ${msg.body.type} failed (attempt ${msg.attempts}):`, err)
        msg.retry({ delaySeconds: Math.min(3600, 2 ** msg.attempts) })
      }
    }
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const ports = makePorts(env, ctx)
    await ports.jobs.enqueue({ type: 'maintenance.sweep' })
  },
}
