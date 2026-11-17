/** Updates for a CLI installed by install.sh: the daily check, and `underlay update`. */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { Env } from '../src/core/env.js'
import { fileKeys } from '../src/core/keys.js'
import { checkForUpdate, installed, update } from '../src/core/update.js'
import { tmp } from './world.js'

const sum = (s: string) => createHash('sha256').update(s).digest('hex')
const ORIGIN = 'https://staging.example.test'

/** An installed CLI (old), a server publishing a newer one, and a clock. */
function setup(published = 'console.log("new")\n') {
  const home = tmp('ul-update-')
  const dir = join(home, '.local', 'share', 'underlay-cli')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'underlay.js')
  writeFileSync(file, 'console.log("old")\n')
  writeFileSync(join(dir, 'origin'), ORIGIN + '\n')
  const calls: string[] = []
  let body = published
  let sha = sum(published)
  let now = Date.parse('2026-11-17T10:00:00Z')
  const env: Env = {
    home,
    configDir: join(home, '.config', 'underlay'),
    dataDir: join(home, '.local', 'share', 'underlay'),
    keys: fileKeys(join(home, '.config', 'underlay')),
    now: () => new Date(now),
    fetch: async (url) => {
      calls.push(url)
      if (url === `${ORIGIN}/cli/underlay.js.sha256`) return new Response(`${sha}  underlay.js\n`)
      if (url === `${ORIGIN}/cli/underlay.js`) return new Response(body)
      return new Response('', { status: 404 })
    },
  }
  mkdirSync(env.configDir, { recursive: true })
  return {
    env,
    file,
    calls,
    later: (ms: number) => (now += ms),
    publish: (b: string, s = sum(b)) => ((body = b), (sha = s)),
  }
}

const vars = {}

describe('updates', () => {
  it('knows where it was installed from, and nothing for a build from source', () => {
    const t = setup()
    expect(installed(t.file)).toEqual({ file: realpathSync(t.file), origin: ORIGIN })
    expect(installed(join(tmp(), 'cli.js'))).toBeNull()
  })

  it('checks at most once a day, and says when a newer build is out', async () => {
    const t = setup()
    expect(await checkForUpdate(t.env, { file: t.file, vars })).toEqual({ origin: ORIGIN })
    expect(await checkForUpdate(t.env, { file: t.file, vars })).toEqual({ origin: ORIGIN })
    expect(t.calls).toHaveLength(1)
    t.later(25 * 3600_000)
    await checkForUpdate(t.env, { file: t.file, vars })
    expect(t.calls).toHaveLength(2)
    expect(
      await checkForUpdate(t.env, { file: t.file, vars: { UNDERLAY_NO_UPDATE_CHECK: '1' } }),
    ).toBeNull()
  })

  it('says nothing when it is the newest, or when the server can’t be reached', async () => {
    const t = setup('console.log("old")\n')
    expect(await checkForUpdate(t.env, { file: t.file, vars })).toBeNull()
    const u = setup()
    u.env.fetch = async () => {
      throw new Error('offline')
    }
    expect(await checkForUpdate(u.env, { file: u.file, vars })).toBeNull()
    // And it waits a day before asking again.
    expect(JSON.parse(readFileSync(join(u.env.configDir, 'update.json'), 'utf8'))).toMatchObject({
      latest: null,
    })
  })

  it('updates: downloads, checks the SHA-256, swaps the file in', async () => {
    const t = setup()
    expect(await update(t.env, t.file)).toMatchObject({ changed: true, origin: ORIGIN })
    expect(readFileSync(t.file, 'utf8')).toBe('console.log("new")\n')
    expect(await checkForUpdate(t.env, { file: t.file, vars })).toBeNull()
    expect(await update(t.env, t.file)).toMatchObject({ changed: false })

    t.publish('console.log("newer")\n', sum('something else'))
    await expect(update(t.env, t.file)).rejects.toThrow(/doesn’t match its checksum/)
    expect(readFileSync(t.file, 'utf8')).toBe('console.log("new")\n')
  })

  it('tells an install without an origin to run the install line again', async () => {
    const t = setup()
    await expect(update(t.env, join(tmp(), 'cli.js'))).rejects.toThrow(/Run the install line again/)
  })
})
