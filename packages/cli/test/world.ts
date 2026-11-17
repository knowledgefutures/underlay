/**
 * A machine and a server for tests: the Underlay server's own app over a temp database and
 * an in-memory bucket (packages/server/test/harness.ts), reached through the CLI's fetch, and
 * a machine's home folder, config, store and Underlay home in a temp folder. Never a real server.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll } from 'vitest'

import { cleanup, type Harness, harness } from '../../server/test/harness.js'
import { TomlFile } from '../src/core/config.js'
import { type Ctx, openCtx } from '../src/core/context.js'
import type { Env, Fetch } from '../src/core/env.js'
import { Home } from '../src/core/home.js'
import { fileKeys } from '../src/core/keys.js'

const temps: string[] = []
afterAll(async () => {
  for (const d of temps) rmSync(d, { recursive: true, force: true })
  await cleanup()
})

export const tmp = (prefix = 'ul-cli-') => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  temps.push(d)
  return d
}

/** The server's app as a remote: a bearer key is the test user's id. */
export function serverFetch(h: Harness): Fetch & { calls: string[] } {
  const calls: string[] = []
  const f = async (url: string, init: RequestInit = {}) => {
    if (url.startsWith('memory://put/')) {
      calls.push(`PUT ${url}`)
      const body = new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer())
      await h.bucket.put(url.slice('memory://put/'.length), body)
      return new Response(null, { status: 200, headers: { etag: '"etag"' } })
    }
    if (url.startsWith('memory://get/')) {
      // A presigned download (an asset), from the same bucket.
      calls.push(`GET ${url}`)
      const obj = await h.bucket.get(url.slice('memory://get/'.length))
      return obj
        ? new Response((await obj.bytes()) as BodyInit, { status: 200 })
        : new Response(null, { status: 404 })
    }
    const u = new URL(url)
    calls.push(`${init.method ?? 'GET'} ${u.pathname}${u.search}`)
    const headers = new Headers(init.headers)
    const auth = headers.get('authorization')
    headers.delete('authorization')
    if (auth) headers.set('x-test-user', auth.replace(/^Bearer /, ''))
    const res = await h.app.fetch(
      new Request(`http://test${u.pathname}${u.search}`, { ...init, headers }),
    )
    // Jobs run as the queue would, after the request that queued them.
    if (init.method === 'POST') await h.drain()
    return res
  }
  return Object.assign(f, { calls })
}

export interface World {
  h: Harness
  env: Env
  ctx: Ctx
  home: Home
  user: string
  lines: string[]
  /** A second machine, signed in to the same server as the same user. */
  machine(): { env: Env; ctx: Ctx; home: Home; lines: string[] }
}

function makeMachine(h: Harness, user: string | null) {
  const home = tmp('ul-home-')
  const configDir = join(home, '.config', 'underlay')
  const keys = fileKeys(configDir)
  if (user) keys.set('test', user)
  const env: Env = {
    home,
    configDir,
    dataDir: join(home, '.local', 'share', 'underlay'),
    fetch: serverFetch(h),
    keys,
    now: () => new Date(),
  }
  const ul = Home.init(join(home, 'Underlay'))
  const file = TomlFile.read(join(configDir, 'config.toml'))
  file.data.home = ul.root
  file.data.remotes = { test: { url: 'http://test' } }
  file.data.defaults = { remote: 'test' }
  file.write()
  const lines: string[] = []
  const ctx = openCtx(env, (l) => lines.push(l), ul.root)
  return { env, ctx, home: ul, lines }
}

/** A server with org `org`, its member `u1`, and a machine signed in as them. */
export async function world(): Promise<World> {
  const h = await harness({ newCollections: 'v3' })
  const user = await h.member()
  const m = makeMachine(h, user)
  return { h, user, ...m, machine: () => makeMachine(h, user) }
}
