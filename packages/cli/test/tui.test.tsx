/** The terminal UI, rendered: the sidebar, a collection, a finished run, push, add, settings. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { v3 } from '@underlay/protocol'
import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'

import { newCollection } from '../src/core/collections.js'
import { openColl } from '../src/core/context.js'
import { runImport } from '../src/core/importers.js'
import { runScript } from '../src/core/runs.js'
import { findScript } from '../src/core/scripts.js'
import { push } from '../src/core/sync.js'
import { saveVersion } from '../src/core/versions.js'
import { App } from '../src/tui/App.js'
import { world } from './world.js'

const Member = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
const wait = (ms = 150) => new Promise((r) => setTimeout(r, ms))

async function until(frame: () => string | undefined, text: string | RegExp, ms = 4000) {
  const t0 = Date.now()
  for (;;) {
    const f = frame() ?? ''
    if (typeof text === 'string' ? f.includes(text) : text.test(f)) return f
    if (Date.now() - t0 > ms) throw new Error(`Never showed ${text}:\n${f}`)
    await wait(50)
  }
}

describe('the terminal UI', () => {
  it('shows what is here, a finished run, push, a remote’s list and settings', async () => {
    const w = await world()
    const meta = newCollection(w.ctx, 'test/org/roster', { access: 'public' })
    w.home.writeSchemas(meta, { Member })
    const c = openColl(w.ctx, meta)
    await saveVersion(c, {
      rows: [v3.rowFromRecord('a', 'Member', { name: 'Ada' })],
      mode: 'set',
      schemas: { Member },
      message: 'first',
      now: new Date(),
    })
    await push(w.ctx, c)
    mkdirSync(join(w.home.root, 'scripts'), { recursive: true })
    writeFileSync(
      join(w.home.root, 'scripts', 'roster.mjs'),
      `// underlay: writes test/org/roster
import { mkdirSync, writeFileSync } from 'node:fs'
mkdirSync(process.env.UNDERLAY_OUT + '/test/org', { recursive: true })
console.log('fetched 2 members')
writeFileSync(process.env.UNDERLAY_OUT + '/test/org/roster.ndjson', '{"id":"a","type":"Member","data":{"name":"Ada"}}\\n{"id":"b","type":"Member","data":{"name":"Bo"}}\\n')
`,
    )
    await runScript(w.ctx, findScript(w.ctx, 'roster'), [], {
      importer: (i, a, o, l) => runImport(w.ctx, i, a, o, l),
    })

    const ui = render(<App ctx={w.ctx} />)
    let f = await until(ui.lastFrame, 'NOT PUSHED')
    expect(f).toContain('Servers (s)')
    expect(f).toMatch(/Collections on.* \(c\)/)
    expect(f).toMatch(/roster\s+■ ↑1/)
    expect(f).toContain('Scripts and views')
    expect(f).toContain('NOT PUSHED')
    expect(f).toMatch(/v1\.1\.0/)
    expect(f).toContain('AUTHORITY')

    // r to the scripts: its finished run, saved as a new version.
    ui.stdin.write('r')
    f = await until(ui.lastFrame, 'SAVED HERE AS NEW VERSIONS')
    expect(f).toContain('fetched 2 members')
    expect(f).toMatch(/roster v1\.1\.0\s+\+1/)

    // Push: public, so the word is typed.
    ui.stdin.write('p')
    f = await until(ui.lastFrame, 'COPIED EXACTLY AS THEY ARE HERE')
    expect(f).toContain('public: anyone can read it once pushed')
    expect(f).toContain('Type push to copy 1 version')
    for (const ch of 'push') {
      ui.stdin.write(ch)
      await wait(20)
    }
    ui.stdin.write('\r')
    f = await until(ui.lastFrame, 'Done. esc goes back.')
    expect(f).toContain('✓ test')
    expect((await v3.findHead(w.h.ports.stores.v3, meta.id))?.commit.semver).toBe('v1.1.0')
    ui.stdin.write('\u001B')
    await wait()

    // A remote's list: your orgs, with what is here.
    ui.stdin.write('+')
    f = await until(ui.lastFrame, 'Your orgs')
    f = await until(ui.lastFrame, /org.*1 here/)
    ui.stdin.write('\u001B')
    await wait()

    // Settings: every setting in sections, and About for the one selected, as Hopper lays it out.
    ui.stdin.write(',')
    f = await until(ui.lastFrame, 'STORE')
    expect(f).toContain('REMOTES')
    expect(f).toContain('test')
    expect(f).toContain('About')
    expect(f).toContain('Where your collections')
    // J goes section by section to Terminal; enter steps the mascot through its choices.
    for (let i = 0; i < 8; i++) {
      ui.stdin.write('J')
      await wait(30)
    }
    ui.stdin.write('j')
    f = await until(ui.lastFrame, 'enter steps through: on, off')
    expect(f).toMatch(/mascot\s+on/)
    ui.stdin.write('\r')
    f = await until(ui.lastFrame, /mascot\s+off/)
    expect(f).toMatch(/\bd default\b/)
    ui.stdin.write('d')
    f = await until(ui.lastFrame, 'mascot back to the default')
    ui.stdin.write('\u001B')
    await wait()

    // ? shows every key, lit where you are; any other key goes back.
    ui.stdin.write('?')
    f = await until(ui.lastFrame, 'you are here')
    expect(f).toMatch(/A COLLECTION\s+you are here/)
    expect(f).toContain('any other key closes')
    ui.stdin.write('x')
    f = await until(ui.lastFrame, 'Scripts and views')

    // s gives Servers the keys; esc comes back to the same collection.
    ui.stdin.write('s')
    f = await until(ui.lastFrame, /Signed (in|out)\./)
    ui.stdin.write('\u001B')
    f = await until(ui.lastFrame, 'AUTHORITY')
    expect(f).toMatch(/roster/)

    // A file dropped on the terminal: its shape, what it matches, and the importer's options.
    const csv = join(w.home.root, '..', 'roster-2026.csv')
    writeFileSync(csv, 'member_id,name,email\na,Ada,a@x\nb,Bo,\nz,Zed,\n')
    ui.stdin.write('f')
    await wait()
    for (const ch of csv) ui.stdin.write(ch)
    ui.stdin.write('\r')
    f = await until(ui.lastFrame, 'SCRIPTS THAT TAKE IT')
    expect(f).toContain('inputs/roster-2026.csv')
    expect(f).toContain('matches org/roster')
    expect(f).toMatch(/id\s+member_id\s+unique/)
    expect(f).toMatch(/email\s+→ left out/)
    ui.unmount()
  })
})
