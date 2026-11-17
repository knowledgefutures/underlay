/** Home and script folders (local-tool.md "Home and script folders"). */
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { newCollection } from '../src/core/collections.js'
import { addSource, loadSettings, removeSource } from '../src/core/config.js'
import { openCtx } from '../src/core/context.js'
import { Home } from '../src/core/home.js'
import { runScript } from '../src/core/runs.js'
import { findScript, listScripts, readHeader } from '../src/core/scripts.js'
import { secretKey } from '../src/core/sources.js'
import { serveView } from '../src/core/views.js'
import { tmp, world } from './world.js'

const Member = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }

const WRITER = `// underlay: writes org/members
import { mkdirSync, writeFileSync } from 'node:fs'
import { helper } from './helper.mjs'
const out = process.env.UNDERLAY_OUT + '/test/org'
mkdirSync(out, { recursive: true })
console.log('cwd', process.cwd())
console.log('home', process.env.UNDERLAY_HOME)
console.log('secret', process.env.UL_TEST_TOKEN ?? 'none')
writeFileSync(out + '/members.ndjson', JSON.stringify({ id: 'a', type: 'Member', data: { name: helper() } }) + '\\n')
`

/** A script folder like underlay-scrapers: an underlay.toml, scripts under src/, a helper. */
function scriptFolder(opts: { need?: string[] } = {}) {
  const root = join(tmp('ul-scripts-'), 'scrapers')
  mkdirSync(join(root, 'src', 'mitp'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true })
  writeFileSync(
    join(root, 'underlay.toml'),
    `scripts = ["src"]\nauthority = "test"\n${opts.need ? `[env]\nneed = ${JSON.stringify(opts.need)}\n` : ''}`,
  )
  writeFileSync(join(root, 'src', 'mitp', 'members.mjs'), WRITER)
  writeFileSync(join(root, 'src', 'mitp', 'helper.mjs'), "export const helper = () => 'Ada'\n")
  writeFileSync(
    join(root, 'src', 'mitp', 'units.sh'),
    '# underlay: check, reads org/members, org/units\necho ok\n',
  )
  writeFileSync(
    join(root, 'src', 'mitp', 'held.html'),
    '<!doctype html>\n<!-- underlay: view, reads org/members -->\n<title>Held</title>\n',
  )
  writeFileSync(
    join(root, 'src', 'mitp', 'review.mjs'),
    `// underlay: serves, reads org/members
import { createServer } from 'node:http'
createServer((_q, r) => r.end('review ' + process.env.UNDERLAY_HOME)).listen(Number(process.env.PORT))
`,
  )
  writeFileSync(join(root, 'node_modules', 'dep', 'x.mjs'), '// underlay: writes org/nope\n')
  return root
}

async function setup(opts: { need?: string[] } = {}) {
  const w = await world()
  const meta = newCollection(w.ctx, 'test/org/members')
  w.home.writeSchemas(meta, { Member })
  const root = scriptFolder(opts)
  addSource(w.env, root)
  // Sources are read when a context opens.
  const ctx = openCtx(w.env, (l) => w.lines.push(l), w.home.root)
  return { ...w, ctx, root, meta }
}

describe('headers', () => {
  it('reads one declaration a line, or several with commas', () => {
    expect(readHeader('// underlay: writes a/b, c/d\n// underlay: takes *.csv, *.tsv\n')).toEqual({
      writes: ['a/b', 'c/d'],
      takes: '*.csv, *.tsv',
    })
    expect(readHeader('# underlay: check, reads a/b\n')).toEqual({ check: true, reads: ['a/b'] })
    expect(readHeader('<!-- underlay: view -->\n')).toEqual({ view: true })
    expect(readHeader('// nothing here\n')).toBeNull()
  })
})

describe('home and script folders', () => {
  it('lists declared scripts from each folder, named by folder, skipping helpers and node_modules', async () => {
    const w = await setup()
    const s = listScripts(w.ctx)
    expect(s.map((x) => [x.name, x.kind, x.view, x.writes, x.reads])).toEqual([
      ['scrapers/mitp/held', 'view', 'page', [], ['test/org/members']],
      ['scrapers/mitp/members', 'script', null, ['test/org/members'], []],
      ['scrapers/mitp/review', 'view', 'server', [], ['test/org/members']],
      ['scrapers/mitp/units', 'check', null, [], ['test/org/members', 'test/org/units']],
    ])
    expect(w.ctx.sources.map((x) => [x.name, x.how])).toEqual([
      ['home', 'home'],
      ['scrapers', 'listed'],
    ])
    expect(findScript(w.ctx, 'members').name).toBe('scrapers/mitp/members')
    expect(findScript(w.ctx, 'mitp/members').name).toBe('scrapers/mitp/members')
    expect(findScript(w.ctx, join(w.root, 'src/mitp/members.mjs')).name).toBe(
      'scrapers/mitp/members',
    )
    expect(() => findScript(w.ctx, join(w.root, 'src/mitp/helper.mjs'))).toThrow(/declares nothing/)

    // The same short name in home: say which.
    writeFileSync(join(w.home.scriptsDir, 'members.mjs'), '// underlay: check\n')
    expect(() => findScript(w.ctx, 'members')).toThrow(/could be home\/members or scrapers/)
    expect(findScript(w.ctx, 'home/members').kind).toBe('check')

    expect(removeSource(w.env, 'scrapers')).toBe(true)
    expect(loadSettings(w.env).sources).toEqual([])
  })

  it('runs a script in its own folder, with home and its secrets', async () => {
    const w = await setup({ need: ['UL_TEST_TOKEN'] })
    const info = findScript(w.ctx, 'members')
    await expect(runScript(w.ctx, info, [])).rejects.toThrow(
      /scrapers\/mitp\/members needs UL_TEST_TOKEN: underlay secret set UL_TEST_TOKEN/,
    )
    w.env.keys.set(secretKey('UL_TEST_TOKEN'), 's3cret')
    const r = await runScript(w.ctx, info, [])
    expect(r.status).toBe('ok')
    expect(r.script).toBe('scrapers/mitp/members')
    expect(r.saved).toMatchObject([{ collection: 'test/org/members', added: 1 }])
    const log = readFileSync(r.log, 'utf8')
    expect(log).toContain(`cwd ${realpathSync(w.root)}`)
    expect(log).toContain(`home ${w.home.root}`)
    expect(log).toContain('secret s3cret')
  })

  it('finds the folder you are in by its underlay.toml', async () => {
    const w = await world()
    const root = scriptFolder()
    const ctx = openCtx(w.env, () => {}, join(root, 'src', 'mitp'))
    expect(ctx.sources.map((x) => [x.name, x.how])).toEqual([
      ['home', 'home'],
      ['scrapers', 'here'],
    ])
    expect(findScript(ctx, 'units').name).toBe('scrapers/mitp/units')
  })

  it('says when there is no home', async () => {
    const w = await world()
    const env = { ...w.env, homeDir: join(tmp(), 'nowhere') }
    expect(() => openCtx(env, () => {})).toThrow(
      /No Underlay home at .*nowhere: run `underlay init`/,
    )
    Home.init(env.homeDir)
    expect(openCtx(env, () => {}).home.root).toBe(env.homeDir)
  })

  it('serves a view on a port it is given, and stops it', async () => {
    const w = await setup()
    const info = findScript(w.ctx, 'review')
    const v = await serveView(w.ctx, info)
    try {
      const res = await fetch(v.url)
      expect(await res.text()).toBe(`review ${w.home.root}`)
    } finally {
      v.stop()
    }
    await new Promise((r) => v.child.once('exit', r))
    await expect(runScript(w.ctx, info, [])).rejects.toThrow(/is a view/)
  })
})
