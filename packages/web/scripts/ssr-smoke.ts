/**
 * SSR smoke test: the built renderPage (dist/server/entry-server.js) behind the
 * v2 app on Node, with a temp SQLite file and an in-memory bucket, seeded with an
 * org, a public and a private collection, and a version pushed through the push
 * API. Renders pages through app.fetch, so loaders reach the API in-process the
 * way they do in production.
 *
 *   pnpm --filter @underlay/web build && pnpm --filter @underlay/web smoke
 *
 * The server's ports are imported from its sources (as packages/server/test/harness.ts
 * builds them) because @underlay/server doesn't export them.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ed25519Signer,
  generateSigningKey,
  memoryStore,
  newSalt,
} from '../../protocol/src/index.ts'
import '../../server/src/handlers.ts'
import { createApp } from '../../server/src/app.ts'
import { MemoryCache } from '../../server/src/cache.ts'
import { openNodeDb } from '../../server/src/db/node.ts'
import * as schema from '../../server/src/db/schema.ts'
import { drainSqliteJobs, SqliteJobs } from '../../server/src/jobs.ts'
import type { Ports } from '../../server/src/ports.ts'
import { createStores } from '../../server/src/stores.ts'
// @ts-ignore: the built bundle has no declarations; its source is src/entry-server.tsx.
import { renderPage } from '../dist/server/entry-server.js'

const dir = await mkdtemp(join(tmpdir(), 'ul-web-smoke-'))
let failures = 0

try {
  const db = await openNodeDb(`file:${join(dir, 'db.sqlite')}`)
  const cache = new MemoryCache()
  const signer = await ed25519Signer(await generateSigningKey())
  const ports: Ports = {
    db,
    stores: createStores(db, cache, {
      bucket: memoryStore(),
      repoPrefix: 'repo',
      internalPrefix: 'internal',
    }),
    cache,
    signer: async () => signer,
    jobs: new SqliteJobs(db),
    waitUntil: (p) => void p.catch((err) => console.error(err)),
    outboundFetch: async () => new Response('ok'),
  }
  const app = createApp(() => ({
    ports,
    config: { appUrl: 'http://smoke.test', deployment: 'smoke' },
    // A session cookie naming the user, else anonymous. A cookie (not the server
    // tests' x-test-user header) because SSR loaders forward the page's Cookie.
    authenticate: async (req) => {
      const user = /(?:^|;\s*)test-user=([^;]+)/.exec(req.headers.get('cookie') ?? '')?.[1]
      return user ? { userId: user, scope: 'session', collectionIds: null } : null
    },
    renderPage,
  }))

  // --- Seed: org "org" with member u1, a public and a private collection.
  await db.insert(schema.organization).values({ id: 'org1', name: 'Smoke Org', slug: 'org' })
  await db.insert(schema.user).values({ id: 'u1', name: 'Ada', email: 'u1@example.org' })
  await db.insert(schema.member).values({ organizationId: 'org1', userId: 'u1', role: 'owner' })
  for (const [slug, isPublic] of [
    ['authors', true],
    ['secret', false],
  ] as const) {
    const [c] = await db
      .insert(schema.collections)
      .values({
        organizationId: 'org1',
        slug,
        name: slug,
        public: isPublic,
        privateSalt: newSalt(),
      })
      .returning()
    await db.insert(schema.placements).values({
      collectionId: c!.id,
      locationId: schema.PLATFORM_LOCATION_ID,
      role: 'primary',
      sets: 'public+private',
    })
  }

  const call = (path: string, init: RequestInit = {}, user?: string) => {
    const headers = new Headers(init.headers)
    if (user) headers.set('cookie', `test-user=${user}`)
    return app.fetch(new Request(`http://smoke.test${path}`, { ...init, headers }))
  }

  // --- Push v1.0.0 through the push API.
  const base = '/api/collections/org/authors'
  const Author = {
    type: 'object',
    properties: { name: { type: 'string' }, born: { type: 'integer' } },
    required: ['name'],
  }
  let res = await call(
    `${base}/push`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schemas: { Author },
        message: 'First load of authors',
        metadata: { readme: '# Authors\n\nPeople who wrote things. <script>alert(1)</script>' },
      }),
    },
    'u1',
  )
  if (res.status !== 200) throw new Error(`push open: ${res.status} ${await res.text()}`)
  const { session_id: sid } = (await res.json()) as { session_id: string }
  res = await call(
    `${base}/push/${sid}/records`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-ndjson' },
      body: [
        { id: 'ada', type: 'Author', data: { name: 'Ada Lovelace', born: 1815 } },
        { id: 'alan', type: 'Author', data: { name: 'Alan Turing', born: 1912 } },
        { id: 'kurt', type: 'Author', data: { name: 'Kurt Gödel' }, private: true },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n'),
    },
    'u1',
  )
  if (res.status !== 200) throw new Error(`push records: ${res.status} ${await res.text()}`)
  res = await call(`${base}/push/${sid}/commit`, { method: 'POST' }, 'u1')
  if (res.status !== 201) throw new Error(`push commit: ${res.status} ${await res.text()}`)
  const version = (await res.json()) as { semver: string }
  // Post-publish jobs (the reference log behind provenance) run from the jobs table.
  await drainSqliteJobs(ports)
  console.log(`seeded org/authors ${version.semver}`)

  // --- A storage location and a mirror of org/authors that failed, written as
  // rows (adding one through the API needs LOCATION_KEY and a reachable bucket).
  // After the drain, so no mirror job tries to reach it. u2 is a plain member.
  await db.insert(schema.storageLocations).values({
    id: 'loc1',
    organizationId: 'org1',
    kind: 's3',
    name: 'Archive bucket',
    endpoint: 'https://s3.example.org',
    bucket: 'archive',
    prefix: 'ul',
    credentials: 'sealed-credentials',
    permissions: 'write',
    status: 'active',
  })
  const authors = (await db.select().from(schema.collections)).find((c) => c.slug === 'authors')
  await db.insert(schema.placements).values({
    collectionId: authors!.id,
    locationId: 'loc1',
    role: 'mirror',
    sets: 'public',
    state: 'error',
    lastError: 'Access Denied',
  })
  await db.insert(schema.user).values({ id: 'u2', name: 'Bea', email: 'u2@example.org' })
  await db.insert(schema.member).values({ organizationId: 'org1', userId: 'u2', role: 'member' })
  console.log('seeded a storage location and a mirror\n')

  // --- Pages.
  // A record hash and a schema id, for the provenance and schema pages.
  const page = (await (await call(`${base}/versions/latest/records?type=Author`)).json()) as {
    records: { id: string; hash: string }[]
  }
  const adaHash = page.records.find((r) => r.id === 'ada')!.hash
  const schemas = (await (await call(`${base}/schemas`)).json()) as {
    schemas?: { schemaId: string }[]
  }
  const schemaId = schemas.schemas?.[0]?.schemaId ?? '1'

  interface Check {
    path: string
    status: number
    has?: string[]
    lacks?: string[]
    location?: string
    user?: string
  }
  const checks: Check[] = [
    {
      path: '/',
      status: 200,
      has: [
        'A protocol for radically accessible structured knowledge',
        'authors',
        '<title>Underlay</title>',
      ],
    },
    {
      path: '/explore',
      status: 200,
      has: ['Browse public knowledge collections', '>authors<', 'Smoke Org', 'v1.0.0'],
      lacks: ['secret'],
    },
    {
      path: '/org/authors',
      status: 200,
      has: [
        '<title>org/authors · Underlay</title>',
        'v1.0.0',
        'People who wrote things.',
        '&lt;script&gt;alert(1)&lt;/script&gt;',
        'Author',
        '2 records',
        'ulv2:',
      ],
      lacks: ['<script>alert(1)</script>'],
    },
    // Members see the private set too.
    { path: '/org/authors', status: 200, has: ['3 records'], user: 'u1' },
    {
      path: '/org/authors/records',
      status: 200,
      has: ['Records — org/authors', 'Ada Lovelace', 'Alan Turing', '1815'],
      lacks: ['Kurt'],
    },
    {
      path: '/org/authors/records?type=Author&page=1',
      status: 200,
      has: ['Ada Lovelace', 'Kurt Gödel'],
      user: 'u1',
    },
    {
      path: '/org/authors/versions',
      status: 200,
      has: ['Versions — org/authors', 'v1.0.0', 'First load of authors', 'ulv2:'],
    },
    { path: '/org/authors/v/1.0.0/records', status: 200, has: ['Ada Lovelace'] },
    { path: '/org/authors/v/v1.0.0', status: 302, location: '/org/authors/v/1.0.0' },
    { path: '/org/authors/schemas', status: 200, has: ['Author', 'born', 'integer'] },
    { path: '/org/authors/files', status: 200, has: ['Files — org/authors'] },
    { path: '/org', status: 200, has: ['Smoke Org', 'authors'], lacks: ['secret'] },
    { path: `/records/${adaHash}`, status: 200, has: ['Ada Lovelace', 'org/authors'] },
    { path: '/records/abc123', status: 404 },
    { path: `/schemas/${schemaId}`, status: 200, has: ['born', 'org/authors'] },
    { path: '/schemas', status: 200, has: ['Schemas'] },
    { path: '/protocol', status: 200, has: ['Protocol'] },
    { path: '/docs', status: 200 },
    { path: '/org/secret', status: 404 },
    { path: '/org/secret', status: 200, has: ['secret'], user: 'u1' },
    { path: '/org/nope', status: 404 },
    { path: '/no/such/page/here', status: 404 },
    { path: '/signup', status: 302, location: '/login' },
    { path: '/dashboard', status: 302, location: '/login' },
    { path: '/dashboard', status: 200, has: ['authors', 'secret'], user: 'u1' },
    // Account and org settings (their data comes from /api/accounts/*).
    { path: '/settings', status: 200, has: ['<title>Settings · Underlay</title>'], user: 'u1' },
    { path: '/settings', status: 302, location: '/login' },
    { path: '/settings/sessions', status: 200, has: ['Active sessions'], user: 'u1' },
    { path: '/org/settings', status: 200, has: ['Settings — org', 'Smoke Org'], user: 'u1' },
    { path: '/org/settings/members', status: 200, has: ['Members — org'], user: 'u1' },
    { path: '/new-org', status: 200, user: 'u1' },
    { path: '/invitations/accept?token=x', status: 200, has: ['Organization Invitation'] },
    // Mirrors in collection settings: status for members, actions for admins.
    {
      path: '/org/authors/settings',
      status: 200,
      has: [
        'Storage and mirrors',
        'Underlay storage',
        'Archive bucket',
        'archive/ul',
        'Access Denied',
        '0 of 1',
        '1 version behind',
        'Sync now',
        'Remove',
      ],
      user: 'u1',
    },
    {
      path: '/org/authors/settings',
      status: 200,
      has: ['Archive bucket', 'Access Denied'],
      lacks: ['Sync now', 'Add mirror'],
      user: 'u2',
    },
    // The org's storage page: owners and admins only, credentials never shown.
    {
      path: '/org/settings/storage',
      status: 200,
      has: [
        'Storage locations',
        'Archive bucket',
        'https://s3.example.org · archive/ul',
        'Write only',
        'Re-check',
        'Add a storage location',
        'Default mirrors',
        'Add default mirror',
      ],
      lacks: ['sealed-credentials'],
      user: 'u1',
    },
    {
      path: '/org/settings/storage',
      status: 200,
      has: ['Only organization owners and admins manage storage.'],
      lacks: ['Archive bucket'],
      user: 'u2',
    },
    { path: '/org/settings/storage', status: 302, location: '/login' },
  ]

  for (const c of checks) {
    const r = await call(c.path, {}, c.user)
    // React separates adjacent text nodes with <!-- -->; match the visible text.
    const body = (await r.text()).replaceAll('<!-- -->', '')
    const problems: string[] = []
    if (r.status !== c.status) problems.push(`status ${r.status}, expected ${c.status}`)
    if (c.location && r.headers.get('location') !== c.location) {
      problems.push(`location ${r.headers.get('location')}, expected ${c.location}`)
    }
    if (c.status === 200) {
      if (!r.headers.get('content-type')?.startsWith('text/html')) problems.push('not HTML')
      // Every rendered page hydrates: the router data and the built client entry.
      for (const s of ['window.__staticRouterHydrationData=', '/assets/entry-client-']) {
        if (!body.includes(s)) problems.push(`missing ${JSON.stringify(s)}`)
      }
    }
    for (const s of c.has ?? [])
      if (!body.includes(s)) problems.push(`missing ${JSON.stringify(s)}`)
    for (const s of c.lacks ?? []) if (body.includes(s)) problems.push(`has ${JSON.stringify(s)}`)
    const label = `${c.path}${c.user ? ` (as ${c.user})` : ''}`
    if (problems.length) {
      failures++
      console.log(`FAIL ${label}\n     ${problems.join('\n     ')}`)
    } else {
      console.log(`ok   ${label}  ${r.status}  ${body.length} bytes`)
    }
  }
} finally {
  await rm(dir, { recursive: true, force: true })
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
