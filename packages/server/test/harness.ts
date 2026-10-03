/** Ports over a temp SQLite file and an in-memory bucket, for integration tests. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ed25519Signer,
  generateSigningKey,
  MemoryStore,
  memoryStore,
  newSalt,
  type Signer,
} from '@underlay/protocol'

import '../src/handlers.js'
import { createApp } from '../src/app.js'
import { MemoryCache } from '../src/cache.js'
import { openNodeDb } from '../src/db/node.js'
import * as schema from '../src/db/schema.js'
import { drainSqliteJobs, SqliteJobs } from '../src/jobs.js'
import type { Ports } from '../src/ports.js'
import { createStores } from '../src/stores.js'

const dirs: string[] = []

/** Outbound requests made by the app (webhooks), and the responder tests set. */
export const outboundCalls: { url: string; init: RequestInit }[] = []
export let outboundResponder: (url: string) => Response = () => new Response('ok')
export function respondOutbound(f: (url: string) => Response) {
  outboundResponder = f
}
const outbound = async (url: string, init: RequestInit) => {
  outboundCalls.push({ url, init })
  return outboundResponder(url)
}

export async function cleanup(): Promise<void> {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
}

export interface Harness {
  ports: Ports
  /** The app, authenticating `x-test-user: <userId>` as a signed-in user. */
  app: ReturnType<typeof createApp>
  /** A user who is a member of the org that owns test collections. */
  member(id?: string): Promise<string>
  /** fetch against the app as a user (or anonymously). */
  request(
    path: string,
    init?: RequestInit & { user?: string; json?: unknown; ndjson?: unknown[] },
  ): Promise<Response>
  bucket: MemoryStore
  signer: Signer
  /** Run queued jobs until none are ready. */
  drain(): Promise<number>
  /** An org and a collection with a primary placement on the platform location. */
  collection(slug?: string): Promise<typeof schema.collections.$inferSelect>
}

export async function harness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'ul-it-'))
  dirs.push(dir)
  const db = await openNodeDb(`file:${join(dir, 'db.sqlite')}`)
  const bucket = memoryStore()
  const cache = new MemoryCache()
  const signer = await ed25519Signer(await generateSigningKey())
  const ports: Ports = {
    db,
    stores: createStores(db, cache, { bucket, repoPrefix: 'repo', internalPrefix: 'internal' }),
    cache,
    signer: async () => signer,
    jobs: new SqliteJobs(db),
    waitUntil: (p) => void p.catch((err) => console.error(err)),
    outboundFetch: (url, init) => outbound(url, init),
  }
  let orgMade = false
  const ensureOrg = async () => {
    if (orgMade) return
    await db.insert(schema.organization).values({ id: 'org1', name: 'Org', slug: 'org' })
    orgMade = true
  }
  const app = createApp(() => ({
    ports,
    config: { appUrl: 'http://test', deployment: 'test' },
    authenticate: async (req) => {
      const user = req.headers.get('x-test-user')
      return user ? { userId: user, scope: 'session', collectionIds: null } : null
    },
  }))
  return {
    ports,
    app,
    bucket,
    signer,
    drain: () => drainSqliteJobs(ports),
    async member(id = 'u1') {
      await ensureOrg()
      await db
        .insert(schema.user)
        .values({ id, name: id, email: `${id}@example.org` })
        .onConflictDoNothing()
      await db.insert(schema.member).values({ organizationId: 'org1', userId: id, role: 'owner' })
      return id
    },
    async request(path, init = {}) {
      const { user, json, ndjson, ...rest } = init
      const headers = new Headers(rest.headers)
      if (user) headers.set('x-test-user', user)
      let body = rest.body
      if (json !== undefined) {
        body = JSON.stringify(json)
        headers.set('content-type', 'application/json')
      }
      if (ndjson !== undefined) {
        body = ndjson.map((l) => JSON.stringify(l)).join('\n')
        headers.set('content-type', 'application/x-ndjson')
      }
      return app.fetch(
        new Request(`http://test${path}`, {
          ...rest,
          headers,
          ...(body !== undefined ? { body } : {}),
        }),
      )
    },
    async collection(slug = 'c') {
      await ensureOrg()
      const [c] = await db
        .insert(schema.collections)
        .values({ organizationId: 'org1', slug, name: slug, privateSalt: newSalt() })
        .returning()
      await db.insert(schema.placements).values({
        collectionId: c!.id,
        locationId: schema.PLATFORM_LOCATION_ID,
        role: 'primary',
        sets: 'public+private',
      })
      return c!
    },
  }
}
