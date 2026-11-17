/**
 * The terminal UI driven through whole sequences, as a person uses it, against the server's
 * app in-process: what each screen shows after each key, including when something fails
 * part way. Each test is a flow someone tried or will try, not one screen once.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { v3 } from '@underlay/protocol'
import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'

import { newCollection } from '../src/core/collections.js'
import { openColl } from '../src/core/context.js'
import { runImport } from '../src/core/importers.js'
import { runScript } from '../src/core/runs.js'
import { findScript } from '../src/core/scripts.js'
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
  backspace: '\u007F',
  tab: '\t',
}
const wait = (ms = 120) => new Promise((r) => setTimeout(r, ms))

/** The UI, and helpers to press keys and wait for what it shows. */
function drive(ui: ReturnType<typeof render>) {
  const frame = () => ui.lastFrame() ?? ''
  return {
    frame,
    /** Click where some text is on screen (the nth time it appears), as a terminal reports it. */
    async click(text: string | RegExp, nth = 0) {
      const lines = frame().split('\n')
      let seen = 0
      for (let y = 0; y < lines.length; y++) {
        const m =
          typeof text === 'string' ? lines[y]!.indexOf(text) : (lines[y]!.match(text)?.index ?? -1)
        if (m < 0) continue
        if (seen++ < nth) continue
        const x = [...lines[y]!.slice(0, m)].length + 2
        ui.stdin.write(`\u001B[<0;${x};${y + 1}M`)
        ui.stdin.write(`\u001B[<0;${x};${y + 1}m`)
        await wait()
        return
      }
      throw new Error(`Nothing on screen says ${text}:\n${frame()}`)
    },
    async wheel(text: string, down = true) {
      const lines = frame().split('\n')
      const y = lines.findIndex((l) => l.includes(text))
      const x = [...lines[y]!.slice(0, lines[y]!.indexOf(text))].length + 2
      ui.stdin.write(`\u001B[<${down ? 65 : 64};${x};${y + 1}M`)
      await wait()
    },
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

describe('the mouse', () => {
  it('selects a row, gives a pane the keys, opens a tab, picks a version, and runs a key cap', async () => {
    const w = await world()
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
    // A server's row: it is selected, and Servers has the keys.
    await d.click('● test')
    await d.until('Signed in.')
    // Back to the collection, then its Versions tab.
    await d.click('notes')
    await d.until('NOT PUSHED')
    await d.click('Versions')
    let f = await d.until(/v1\.1\.0 CHANGED/)
    // The older version, by clicking its row.
    await d.click('v1.0.0')
    f = await d.until(/v1\.0\.0 CHANGED/)
    expect(f).toMatch(/\+ a\s+Thing/)
    // The wheel over the pane moves through the versions too.
    await d.wheel('v1.0.0', false)
    await d.until(/v1\.1\.0 CHANGED/)
    // A key cap does what its key does.
    await d.click(' D ')
    f = await d.until('It was never pushed')
    await d.press(K.esc)
    ui.unmount()
  })
})

describe('inside a collection', () => {
  it('keeps up and down in the pane, opens a record, and saves a file', async () => {
    const w = await world()
    const Paper = {
      type: 'object',
      properties: { name: { type: 'string' }, pdf: { type: 'object', required: ['$file'] } },
    }
    for (const name of ['aaa', 'zzz']) {
      const meta = newCollection(w.ctx, `test/org/${name}`)
      w.home.writeSchemas(meta, { Paper })
    }
    const meta = w.home.collection({ authority: 'test', org: 'org', name: 'aaa' })
    const c = openColl(w.ctx, meta)
    const pdf = join(w.home.root, '..', 'paper.pdf')
    writeFileSync(pdf, 'a small pdf')
    const { storeAssets } = await import('../src/core/assets.js')
    const [file] = await storeAssets(c, [pdf])
    await saveVersion(c, {
      rows: [
        v3.rowFromRecord('p1', 'Paper', { name: 'One', pdf: { $file: `sha256:${file!.hash}` } }),
        v3.rowFromRecord('p2', 'Paper', { name: 'Two' }),
      ],
      mode: 'set',
      schemas: { Paper },
      message: 'two',
      now: new Date(),
      assets: [file!],
    })
    const ui = render(<App ctx={w.ctx} />)
    const d = drive(ui)
    await d.until('NOT PUSHED')
    // The pane has the keys: down scrolls it, and the sidebar stays on aaa.
    await d.press(K.tab, K.down, K.down)
    expect(d.frame()).toMatch(/aaa ─/)
    // Records: a cursor; enter opens the record whole, esc goes back to the list.
    await d.press(K.right)
    await d.until(/▌ Paper\s+p1/)
    await d.press(K.down)
    await d.until(/▌ Paper\s+p2/)
    await d.press(K.up, K.enter)
    let f = await d.until('"$file"')
    expect(f).toContain('"name": "One"')
    await d.press(K.esc)
    await d.until(/▌ Paper\s+p1/)
    expect(d.frame()).toMatch(/aaa ─/)
    // Files: the file, the record that points to it, and w saves a copy.
    await d.press(K.right, K.right)
    f = await d.until('application/pdf')
    expect(f).toMatch(/▌ ✓ [0-9a-f]{12}\s+application\/pdf\s+11 B\s+Paper p1/)
    await d.press('w')
    await d.until(/Saved .*paper-p1-[0-9a-f]{12}\.pdf/)
    ui.unmount()
  })
})

describe('a new collection', () => {
  it('checks the name as you type, makes it here, and says how to fill it', async () => {
    const w = await server()
    const ui = render(<App ctx={w.ctx} />)
    const d = drive(ui)
    await d.until('Servers')
    await d.press('+')
    await d.until('New collection')
    // The org comes from the server's list once it is read.
    await d.until(/org\s+org/)
    for (const ch of 'members') await d.press(ch)
    await d.until('keeps "members" for itself; choose another name')
    for (let i = 0; i < 7; i++) await d.press(K.backspace)
    for (const ch of 'lib') await d.press(ch)
    await d.until('already has org/lib: add it from Servers (s) instead')
    for (const ch of '-notes') await d.press(ch)
    await d.until('Makes test/org/lib-notes here')
    await d.press(K.enter)
    const f = await d.until('Made org/lib-notes here; your first push creates it on test')
    expect(f).toContain('No versions yet. To fill it:')
    expect(f).toContain('// underlay: writes org/lib-notes')
    expect(w.home.readCollection({ authority: 'test', org: 'org', name: 'lib-notes' })?.isNew).toBe(
      true,
    )
    ui.unmount()
  })
})

describe('a new collection from a spreadsheet', () => {
  it('offers to make one, drafts its schema from the columns, and imports it', async () => {
    const w = await server()
    const csv = join(w.home.root, '..', 'roster-2026.csv')
    writeFileSync(
      csv,
      'member_id,name,unit,joined,email\nm1,Ada,CSAIL,2019-09-01,a@x.org\nm2,Bo,LIDS,2020-01-15,\nm3,Cy,CSAIL,2026-01-15,c@x.org\n',
    )
    const ui = render(<App ctx={w.ctx} />)
    const d = drive(ui)
    await d.until('Servers')
    await d.press('f')
    await d.until('A file to add')
    for (const ch of csv) await d.press(ch)
    await d.press(K.enter)
    let f = await d.until('Make a new collection from this file')
    expect(f).toContain('no collection here')
    // n: the form, filled in from the file.
    await d.press('n')
    f = await d.until('from roster-2026.csv')
    expect(f).toMatch(/name\s+roster▏/)
    expect(f).toMatch(/type\s+Roster/)
    await d.press(K.down)
    for (let i = 0; i < 6; i++) await d.press(K.backspace)
    for (const ch of 'Member') await d.press(ch)
    await d.until(/org\s+org/)
    await d.press(K.enter)
    // Back on the file, with a schema drafted for Member.
    f = await d.until('SCHEMA FOR Member')
    expect(f).toContain('Made org/roster here; now shape its schema')
    expect(f).toMatch(/member_id\s+member_id\s+the id\s+the id: 3 val/)
    expect(f).toMatch(/unit\s+unit\s+text\s+2 values: CSA/)
    expect(f).toMatch(/joined\s+joined\s+date\s+2019-09-01 to/)
    expect(f).toMatch(/✗\s+email\s+left out\s+looks pers/)
    await d.press(K.enter)
    await d.until(/Saved schemas\/Member\.json and imports\/roster-2026/)
    const meta = w.home.collection({ authority: 'test', org: 'org', name: 'roster' })
    const schema = w.home.schemas(meta).Member as {
      properties: Record<string, unknown>
      required: string[]
    }
    expect(Object.keys(schema.properties)).toEqual(['name', 'unit', 'joined'])
    expect(schema.required).toEqual(['name', 'unit', 'joined'])
    // The saved import runs as any script does (here in-process; the UI starts it detached).
    const r = await runScript(w.ctx, findScript(w.ctx, 'imports/roster-2026'), [csv], {
      importer: (i, a, o, l) => runImport(w.ctx, i, a, o, l),
    })
    expect(r.saved).toMatchObject([{ collection: 'test/org/roster', semver: 'v1.0.0', added: 3 }])
    ui.unmount()
  })
})

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
    // Servers starts on one you're signed in to; enter lists what it has to add.
    await d.press('s', K.enter)
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
    // Servers starts on one you're signed in to; enter lists what it has to add.
    await d.press('s', K.enter)
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
    // Servers starts on one you're signed in to; enter lists what it has to add.
    await d.press('s', K.enter)
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
    for (let i = 0; i < 4; i++) await d.press(K.right)
    let f = await d.until('not pushed')
    expect(f).toMatch(/v1\.1\.0.*not pushed/)
    // The selected version's changes, below the list.
    f = await d.until(/v1\.1\.0 CHANGED/)
    expect(f).toMatch(/Thing\s+\+1 ~0 −0/)
    expect(f).toMatch(/\+ b\s+Thing/)
    await d.press(K.down)
    f = await d.until(/v1\.0\.0 CHANGED/)
    await d.press('u')
    f = await d.until('Dropped v1.1.0')
    expect(f).not.toMatch(/v1\.1\.0\s+2/)
    // Records tab lists what is there.
    await d.press(K.left, K.left, K.left)
    f = await d.until(/Thing\s+a\s/)
    // D asks first: anything but the answer keeps it; "lose them" removes one never pushed.
    await d.press(K.esc, 'D')
    await d.until(/Remove \S+\/notes\? It was never pushed/)
    for (const ch of 'notes') await d.press(ch)
    await d.press(K.enter)
    await d.until('Kept')
    await d.press('D')
    await d.until('never pushed')
    for (const ch of 'lose them') await d.press(ch)
    await d.press(K.enter)
    f = await d.until('Removed')
    expect(f).not.toMatch(/notes\s+new/)
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
    await d.press('s', K.enter)
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
