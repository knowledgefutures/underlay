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
import { ed25519Signer, type R2BucketLike, r2Store, s3Store, type Signer } from '@underlay/protocol'

import './handlers.js'
import { renderPage } from '@underlay/web'

import { createApp } from './app.js'
import { type Auth, authenticator, createAuth } from './auth/auth.js'
import { createKf, type Kf } from './auth/kf.js'
import { type UsageEvent, writeUsage } from './billing/usage.js'
import { CfCache } from './cache.js'
import { openD1 } from './db/d1.js'
import { readsAnyReplica } from './db/replicas.js'
import { isBulk, QueueJobs, runJob } from './jobs.js'
import { bindingRateLimiter, type RateLimitBinding } from './lib/limits.js'
import type { JobMessage, Ports } from './ports.js'
import { createStores } from './stores.js'

export interface Env {
  DB: D1Database
  JOBS: Queue
  /** Bulk jobs (jobs.ts BULK_JOBS); without it, everything goes to JOBS. */
  JOBS_BULK?: Queue
  /** Usage events (billing/usage.ts), a request's to a message; without it, nothing is metered. */
  USAGE?: Queue
  APP_URL: string
  DEPLOYMENT: string
  R2_ENDPOINT: string
  R2_BUCKET: string
  R2_ACCESS_KEY_ID: string
  R2_SECRET_ACCESS_KEY: string
  /**
   * Optional R2 binding on the same bucket as R2_BUCKET. When set, repository
   * and internal objects go through the binding; file bytes keep the S3 API,
   * which can presign.
   */
  BUCKET?: R2BucketLike
  SIGNING_KEY: string
  /** 32 bytes, base64url: encrypts customer storage credentials. */
  LOCATION_KEY?: string
  SESSION_SECRET: string
  OIDC_ISSUER_URL: string
  OIDC_CLIENT_ID: string
  OIDC_CLIENT_SECRET: string
  /** The KF account site, linked from the user menu. */
  OIDC_ACCOUNT_URL?: string
  /** Rate-limit bindings (wrangler.jsonc "ratelimits"); without them, no limit. */
  RL_ANON?: RateLimitBinding
  RL_USER?: RateLimitBinding
  /** KF Auth's internal API key: KF orgs for new orgs, and /api/kf/summary. Optional. */
  AUTH_INTERNAL_API_KEY?: string
  REPO_PREFIX?: string
  INTERNAL_PREFIX?: string
}

/** Interactive jobs one invocation runs at once. */
const INTERACTIVE_LANES = 4

let signer: Promise<Signer> | null = null

/** Which D1 a request reads: any replica for anonymous reads (db/replicas.ts), else the primary. */
function d1For(env: Env, req: Request): D1Database {
  if (!env.DB.withSession || !readsAnyReplica(req)) return env.DB
  return env.DB.withSession('first-unconstrained') as unknown as D1Database
}

/** The primary, for long-lived clients (better-auth, KF Auth) built once per isolate. */
const primaries = new WeakMap<object, Ports['db']>()
const primaryDb = (env: Env) => {
  let db = primaries.get(env.DB)
  if (!db) primaries.set(env.DB, (db = openD1(env.DB)))
  return db
}

function makePorts(env: Env, ctx: ExecutionContext, req?: Request): Ports {
  const db = req ? openD1(d1For(env, req)) : primaryDb(env)
  const cache = new CfCache(caches as never, env.DEPLOYMENT, (p) => ctx.waitUntil(p))
  const s3 = s3Store({
    endpoint: env.R2_ENDPOINT,
    bucket: env.R2_BUCKET,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    region: 'auto',
  })
  return {
    db,
    stores: createStores(db, cache, {
      bucket: env.BUCKET ? r2Store(env.BUCKET) : s3,
      files: s3,
      repoPrefix: env.REPO_PREFIX ?? 'repo',
      internalPrefix: env.INTERNAL_PREFIX ?? 'internal',
    }),
    cache,
    signer: () => (signer ??= ed25519Signer(env.SIGNING_KEY)),
    jobs: new QueueJobs(env.JOBS as never, (env.JOBS_BULK ?? env.JOBS) as never),
    waitUntil: (p) => ctx.waitUntil(p),
    outboundFetch: (url, init) => fetch(url, init),
    locationFetch: (req) => fetch(req),
    ...(env.LOCATION_KEY ? { locationKey: env.LOCATION_KEY } : {}),
    ...(env.USAGE
      ? {
          usage: {
            record: (events: UsageEvent[]) =>
              ctx.waitUntil(
                (env.USAGE as unknown as { send(b: unknown): Promise<void> })
                  .send({ events })
                  .catch((err: unknown) => console.error('[usage] send failed', err)),
              ),
          },
        }
      : {}),
    ...(env.RL_ANON && env.RL_USER
      ? { rateLimit: bindingRateLimiter({ anon: env.RL_ANON, user: env.RL_USER }) }
      : {}),
  }
}

// One KF Auth client and one better-auth instance per isolate and database binding.
const kfs = new WeakMap<object, Kf>()
function kfFor(env: Env): Kf {
  let kf = kfs.get(env.DB)
  if (!kf) {
    kf = createKf(primaryDb(env), {
      // No private network on Workers: server-to-server calls use the public URL.
      internalUrl: env.OIDC_ISSUER_URL,
      clientId: env.OIDC_CLIENT_ID,
      clientSecret: env.OIDC_CLIENT_SECRET,
      internalApiKey: env.AUTH_INTERNAL_API_KEY,
    })
    kfs.set(env.DB, kf)
  }
  return kf
}

const auths = new WeakMap<object, Auth>()
function authFor(env: Env, ports: Ports): Auth {
  let auth = auths.get(env.DB)
  if (!auth) {
    auth = createAuth(
      primaryDb(env),
      {
        appUrl: env.APP_URL,
        secret: env.SESSION_SECRET,
        oidc: {
          issuerUrl: env.OIDC_ISSUER_URL,
          // No private network on Workers: server-to-server calls use the public URL.
          internalUrl: env.OIDC_ISSUER_URL,
          clientId: env.OIDC_CLIENT_ID,
          clientSecret: env.OIDC_CLIENT_SECRET,
        },
      },
      ports.waitUntil,
      kfFor(env),
    )
    auths.set(env.DB, auth)
  }
  return auth
}

const app = createApp((c) => {
  const env = c.env as unknown as Env
  const ports = makePorts(env, c.executionCtx as unknown as ExecutionContext, c.req.raw)
  return {
    ports,
    config: {
      appUrl: env.APP_URL,
      deployment: env.DEPLOYMENT,
      kfAuthUrl: env.OIDC_ISSUER_URL,
      kfAccountUrl: env.OIDC_ACCOUNT_URL,
    },
    authenticate: authenticator(() => authFor(env, ports)),
    kf: kfFor(env),
    authHandler: (req) => authFor(env, ports).handler(req),
    renderPage,
  }
})

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(req, env as never, ctx as never)
  },

  async queue(batch: MessageBatch<JobMessage>, env: Env, ctx: ExecutionContext): Promise<void> {
    const ports = makePorts(env, ctx)
    // The usage queue: a batch of requests' events becomes one log object.
    if (batch.queue.endsWith('-usage')) {
      const events = batch.messages.flatMap(
        (m) => (m.body as unknown as { events: UsageEvent[] }).events ?? [],
      )
      await writeUsage(ports, events)
      batch.ackAll()
      return
    }
    const run = async (msg: (typeof batch.messages)[number]) => {
      try {
        await runJob(msg.body, ports)
        msg.ack()
      } catch (err) {
        console.error(`[jobs] ${msg.body.type} failed (attempt ${msg.attempts}):`, err)
        msg.retry({ delaySeconds: Math.min(3600, 2 ** msg.attempts) })
      }
    }
    // The bulk queue delivers one job per invocation (wrangler.jsonc); an
    // interactive batch's small jobs run a few at a time, sharing its CPU.
    const queue = [...batch.messages]
    const lanes = batch.messages.some((m) => isBulk(m.body.type)) ? 1 : INTERACTIVE_LANES
    await Promise.all(
      Array.from({ length: Math.min(lanes, queue.length) }, async () => {
        for (let m = queue.shift(); m; m = queue.shift()) await run(m)
      }),
    )
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
