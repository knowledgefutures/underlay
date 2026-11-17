/**
 * The terminal UI driven through whole sequences, as a person uses it, against the server's
 * app in-process: what each screen shows after each key, including when something fails
 * part way. Each test is a flow someone tried or will try, not one screen once.
 */
import { v3 } from '@underlay/protocol'
import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'

import { newCollection } from '../src/core/collections.js'
import { openColl } from '../src/core/context.js'
import { saveVersion } from '../src/core/versions.js'
import { App } from '../src/tui/App.js'
import { world } from './world.js'

const K = {
  up: '\u001B[A',
  down: '\u001B[B',
  right: '\u001B[C',
  left: '\u001B[D',
  enter: '\r',
  esc: '\u001B',
  tab: '\t',
}
const wait = (ms = 120) => new Promise((r) => setTimeout(r, ms))

/** The UI, and helpers to press keys and wait for what it shows. */
function drive(ui: ReturnType<typeof render>) {
  const frame = () => ui.lastFrame() ?? ''
  return {
    frame,
    async press(...keys: string[]) {
      for (const k of keys) {
        ui.stdin.write(k)
        await wait(60)
      }
      await wait()
    },
    async until(text: string | RegExp, ms = 6000) {
      const t0 = Date.now()
      for (;;) {
        const f = frame()
        if (typeof text === 'string' ? f.includes(text) : text.test(f)) return f
        if (Date.now() - t0 > ms) throw new Error(`Never showed ${text}:\n${f}`)
        await wait(50)
      }
    },
  }
}

/** Put the picker's cursor on a collection by name. */
async function cursorTo(d: ReturnType<typeof drive>, name: string) {
  for (let i = 0; i < 8; i++) await d.press(K.up)
  const at = new RegExp(`› \\[.\\] ${name}`)
  for (let i = 0; i < 8 && !at.test(d.frame()); i++) await d.press(K.down)
  expect(d.frame()).toMatch(at)
}

const Thing = { type: 'object', properties: { name: { type: 'string' } } }

/** A server with v3 collections lib and a long-named one, a v2 one, and an empty machine. */
async function server() {
  const w = await world()
  await w.h.collection('lib', { recordLayout: 'v3' })
  await w.h.collection('a-collection-with-a-really-long-name-indeed', { recordLayout: 'v3' })
  await w.h.collection('old', { recordLayout: 'today' })
  return w
}

describe('adding collections from a remote', () => {
  it('lists no v2 collection, adds several at once, and carries on past one that fails', async () => {
    const w = await server()
    // The server refuses one of them part way.
    const real = w.ctx.env.fetch
    w.ctx.env.fetch = async (url, init) =>
      url.includes('/org/lib/commits')
        ? new Response('{"error":"Collection not found"}', { status: 404 })
        : real(url, init)
    const ui = render(<App ctx={w.ctx} />)
    const d = drive(ui)
    await d.until('Servers')
    await d.press('+')
    await d.until(/▸ org/)
    await d.press(K.right)
    let f = await d.until('lib')
    expect(f).toMatch(/org\s+2 ·/)
    expect(f).not.toMatch(/\bold\b/)
    await cursorTo(d, 'lib')
    await d.press(' ')
    await cursorTo(d, 'a-collection')
    await d.press(' ', K.enter)
    f = await d.until('Added 1 of 2')
    expect(f).toMatch(/Collection not found/)
    // The one that failed is not half-added, and stays selected to retry.
    expect(f).toMatch(/\[x\] lib/)
    expect(w.home.readCollection({ authority: 'test', org: 'org', name: 'lib' })).toBeNull()
    expect(w.home.collections().map((c) => c.name)).toEqual([
      'a-collection-with-a-really-long-name-indeed',
    ])
    ui.unmount()
  })

  it('adds one, then another, without the first getting in the way', async () => {
    const w = await server()
    const ui = render(<App ctx={w.ctx} />)
    const d = drive(ui)
    await d.until('Servers')
    await d.press('+')
    await d.until(/▸ org/)
    await d.press(K.right)
    await cursorTo(d, 'a-collection')
    await d.press(' ', K.enter)
    await d.until('Added 1')
    // Another one.
    await cursorTo(d, 'lib')
    await d.press(' ', K.enter)
    const f = await d.until('Added 1', 6000)
    expect(f).not.toMatch(/here already/)
    expect(
      w.home
        .collections()
        .map((c) => c.name)
        .sort(),
    ).toEqual(['a-collection-with-a-really-long-name-indeed', 'lib'])
    ui.unmount()
  })

  it('cuts a long name rather than running it into the next column', async () => {
    const w = await server()
    const ui = render(<App ctx={w.ctx} />)
    const d = drive(ui)
    await d.until('Servers')
    await d.press('+')
    await d.until(/▸ org/)
    await d.press(K.right)
    const f = await d.until('a-collection-with-a-real')
    expect(f).toMatch(/a-collection-with-a-real…\s+private/)
    ui.unmount()
  })

  it('says why on the command line too, and adds nothing for a v2 collection', async () => {
    const w = await server()
    const { addCollection } = await import('../src/core/collections.js')
    await expect(addCollection(w.ctx, 'test/org/old')).rejects.toThrow(/older protocol \(v2\)/)
    expect(w.home.readCollection({ authority: 'test', org: 'org', name: 'old' })).toBeNull()
  })
})

describe('everyday flows in the terminal UI', () => {
  it('moves through the sidebar, opens a collection’s tabs, and undoes a version', async () => {
    const w = await server()
    const meta = newCollection(w.ctx, 'test/org/notes')
    w.home.writeSchemas(meta, { Thing })
    const c = openColl(w.ctx, meta)
    for (const names of [['a'], ['a', 'b']])
      await saveVersion(c, {
        rows: names.map((n) => v3.rowFromRecord(n, 'Thing', { name: n })),
        mode: 'set',
        schemas: { Thing },
        message: names.join(','),
        now: new Date(),
      })
    const ui = render(<App ctx={w.ctx} />)
    const d = drive(ui)
    await d.until('NOT PUSHED')
    expect(d.frame()).toMatch(/notes\s+new/)
    // Into the main pane, across to Versions.
    await d.press(K.tab)
    for (let i = 0; i < 5; i++) await d.press(K.right)
    let f = await d.until('not pushed')
    expect(f).toMatch(/v1\.1\.0.*not pushed/)
    await d.press('u')
    f = await d.until('Dropped v1.1.0')
    expect(f).not.toMatch(/v1\.1\.0\s+2/)
    // Records tab lists what is there.
    await d.press(K.left, K.left, K.left, K.left)
    f = await d.until(/Thing\s+a\s/)
    ui.unmount()
  })

  it('edits a setting and shows it saved', async () => {
    const w = await server()
    const ui = render(<App ctx={w.ctx} />)
    const d = drive(ui)
    await d.until('Servers')
    await d.press(',')
    await d.until('STORE')
    // Down to store.limit and set it.
    const onLimit = () => /▌\s+limit/.test(d.frame())
    for (let i = 0; i < 20 && !onLimit(); i++) await d.press(K.down)
    expect(onLimit()).toBe(true)
    await d.press(K.enter)
    for (const ch of '50 GB') await d.press(ch)
    await d.press(K.enter)
    const f = await d.until(/limit\s+50 GB/)
    expect(f).not.toMatch(/limit\s+\(none\)/)
    ui.unmount()
  })

  it('pushes, and when someone pushed first says so and offers the replayed versions', async () => {
    const w = await server()
    const { push } = await import('../src/core/sync.js')
    const { addCollection } = await import('../src/core/collections.js')
    const meta = newCollection(w.ctx, 'test/org/shared', { access: 'private' })
    w.home.writeSchemas(meta, { Thing })
    const c = openColl(w.ctx, meta)
    const save = (cc: typeof c, names: string[], schemas = { Thing }) =>
      saveVersion(cc, {
        rows: names.map((n) => v3.rowFromRecord(n, 'Thing', { name: n })),
        mode: 'set',
        schemas,
        message: names.join(','),
        now: new Date(),
      })
    await save(c, ['a'])
    await push(w.ctx, c)
    // Another machine pushes first; this one saves its own version meanwhile.
    const m = w.machine()
    const { coll: b } = await addCollection(m.ctx, 'test/org/shared')
    await save(b, ['a', 'theirs'])
    await push(m.ctx, b)
    await save(c, ['a', 'mine'])

    const ui = render(<App ctx={w.ctx} />)
    const d = drive(ui)
    await d.until('NOT PUSHED')
    await d.press('p')
    let f = await d.until('l pulls first')
    // y with nothing it can send says why, rather than "Done".
    await d.press('y')
    f = await d.until('Behind its authority')
    expect(f).not.toContain('Done.')
    // l pulls, replays this machine's version on top, and shows the plan again.
    await d.press('l')
    f = await d.until('yours replayed as v1.2.0')
    f = await d.until('COPIED EXACTLY AS THEY ARE HERE')
    expect(f).toMatch(/→ v1\.2\.0/)
    await d.press('y')
    f = await d.until('Done. esc goes back.')
    expect(f).toContain('✓ test')
    ui.unmount()
  })

  it('pulls what another machine pushed, and cycles what is kept', async () => {
    const w = await server()
    const { push } = await import('../src/core/sync.js')
    const { addCollection } = await import('../src/core/collections.js')
    const meta = newCollection(w.ctx, 'test/org/kept', { access: 'private' })
    w.home.writeSchemas(meta, { Thing })
    const c = openColl(w.ctx, meta)
    await saveVersion(c, {
      rows: [v3.rowFromRecord('a', 'Thing', { name: 'a' })],
      mode: 'set',
      schemas: { Thing },
      message: 'one',
      now: new Date(),
    })
    await push(w.ctx, c)
    const m = w.machine()
    const { coll: b } = await addCollection(m.ctx, 'test/org/kept')
    await saveVersion(b, {
      rows: ['a', 'b'].map((n) => v3.rowFromRecord(n, 'Thing', { name: n })),
      mode: 'set',
      schemas: { Thing },
      message: 'two',
      now: new Date(),
    })
    await push(m.ctx, b)

    const ui = render(<App ctx={w.ctx} />)
    const d = drive(ui)
    await d.until('AUTHORITY')
    await d.until(/kept\s+↓1/)
    await d.press('l')
    let f = await d.until('1 new versions')
    expect(f).toMatch(/kept\s+│/)
    // k asks which level; going down asks again before deleting, and n keeps it as it was.
    await d.press('k')
    await d.until('Keep here: e everything')
    await d.press('m', K.enter)
    f = await d.until(/Delete \d+ record files .* from this machine\? They stay on/)
    await d.press('n', K.enter)
    f = await d.until('Kept as it was')
    expect(f).toMatch(/kept\s+│/)
    // y deletes them: metadata only.
    await d.press('k')
    await d.until('Keep here')
    await d.press('m', K.enter)
    await d.until('Delete')
    await d.press('y', K.enter)
    f = await d.until(/metadata only, let go of \d+ files here/)
    expect(f).toMatch(/kept\s+○/)
    // Back up to everything fetches them again, without asking.
    await d.press('k')
    await d.until('Keep here')
    await d.press('e', K.enter)
    f = await d.until(/everything, fetched \d+/)
    expect(f).toMatch(/kept\s+│/)
    ui.unmount()
  })

  it('says so when a file path is wrong, and gets back out of every screen with esc', async () => {
    const w = await server()
    const ui = render(<App ctx={w.ctx} />)
    const d = drive(ui)
    await d.until('Servers')
    await d.press('f')
    await d.until('A file to add')
    for (const ch of '/no/such/file.csv') await d.press(ch)
    await d.press(K.enter)
    await d.until(/No file \/no\/such\/file\.csv/)
    for (const key of ['+', ',', 'h', 'p']) {
      await d.press(key)
      await wait(300)
      await d.press(K.esc)
      const f = await d.until('Servers')
      expect(f, `esc after ${key}`).not.toMatch(/Push to|Settings|Runs ─|Your orgs/)
    }
    ui.unmount()
  })

  it('finds public collections by search, on the Public tab', async () => {
    const w = await server()
    const pub = await w.h.collection('open-data', { recordLayout: 'v3' })
    void pub
    await w.h.request('/api/collections/org/open-data', {
      method: 'PATCH',
      user: w.user,
      json: { public: true },
    })
    const ui = render(<App ctx={w.ctx} />)
    const d = drive(ui)
    await d.until('Servers')
    await d.press('+')
    await d.until('Your orgs')
    await d.press(K.tab)
    let f = await d.until('org/open-data')
    await d.press('/')
    for (const ch of 'nothing-like-it') await d.press(ch)
    await d.press(K.enter)
    f = await d.until('Public 0')
    expect(f).not.toContain('org/open-data')
    ui.unmount()
  })

  it('removes a collection from this machine, but not one with versions not yet pushed', async () => {
    const w = await server()
    const { addCollection, removeCollection } = await import('../src/core/collections.js')
    const { coll: lib } = await addCollection(w.ctx, 'test/org/lib')
    await removeCollection(w.ctx, lib)
    expect(w.home.readCollection(lib.meta)).toBeNull()
    // Added again, from nothing.
    await addCollection(w.ctx, 'test/org/lib')
    const meta = newCollection(w.ctx, 'test/org/draft')
    w.home.writeSchemas(meta, { Thing })
    const c = openColl(w.ctx, meta)
    await saveVersion(c, {
      rows: [v3.rowFromRecord('a', 'Thing', { name: 'a' })],
      mode: 'set',
      schemas: { Thing },
      message: 'm',
      now: new Date(),
    })
    await expect(removeCollection(w.ctx, c)).rejects.toThrow(/1 version not pushed/)
    await removeCollection(w.ctx, c, true)
    expect(w.home.readCollection(meta)).toBeNull()
  })
})
