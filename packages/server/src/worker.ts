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
  /** KF Auth's internal API key: KF orgs for new orgs, and /api/kf/summary. Optional. */
  AUTH_INTERNAL_API_KEY?: string
  REPO_PREFIX?: string
  INTERNAL_PREFIX?: string
}

let signer: Promise<Signer> | null = null

function makePorts(env: Env, ctx: ExecutionContext): Ports {
  const db = openD1(env.DB)
  const cache = new CfCache(caches as never, env.DEPLOYMENT)
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
    jobs: new QueueJobs(env.JOBS as never),
    waitUntil: (p) => ctx.waitUntil(p),
    outboundFetch: (url, init) => fetch(url, init),
    locationFetch: (req) => fetch(req),
    ...(env.LOCATION_KEY ? { locationKey: env.LOCATION_KEY } : {}),
  }
}

// One KF Auth client and one better-auth instance per isolate and database binding.
const kfs = new WeakMap<object, Kf>()
function kfFor(env: Env, ports: Ports): Kf {
  let kf = kfs.get(env.DB)
  if (!kf) {
    kf = createKf(ports.db, {
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
      ports.db,
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
      kfFor(env, ports),
    )
    auths.set(env.DB, auth)
  }
  return auth
}

const app = createApp((c) => {
  const env = c.env as unknown as Env
  const ports = makePorts(env, c.executionCtx as unknown as ExecutionContext)
  return {
    ports,
    config: {
      appUrl: env.APP_URL,
      deployment: env.DEPLOYMENT,
      kfAuthUrl: env.OIDC_ISSUER_URL,
      kfAccountUrl: env.OIDC_ACCOUNT_URL,
    },
    authenticate: authenticator(() => authFor(env, ports)),
    kf: kfFor(env, ports),
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
