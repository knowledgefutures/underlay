/** Scripts and runs (phase 2), and built-in imports (phase 3). */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { v3 } from '@underlay/protocol'
import { describe, expect, it } from 'vitest'

import { newCollection } from '../src/core/collections.js'
import { openColl } from '../src/core/context.js'
import {
  addFile,
  decisionsPath,
  defaultOptions,
  eject,
  heldPath,
  readTable,
  runImport,
  saveImport,
} from '../src/core/importers.js'
import { listRuns, lock, readRun, runScript, saveFromRun } from '../src/core/runs.js'
import { findScript, listScripts, takesFile } from '../src/core/scripts.js'
import { saveVersion, unpushedOf } from '../src/core/versions.js'
import { tmp, world } from './world.js'

const Member = {
  type: 'object',
  properties: { name: { type: 'string' }, unit: { type: 'string' }, year: { type: 'integer' } },
  required: ['name'],
}

const SCRIPT = `// underlay: writes test/org/roster
// underlay: takes *.json
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const names = process.argv.slice(2)
const out = join(process.env.UNDERLAY_OUT, 'test/org')
mkdirSync(out, { recursive: true })
console.log('writing', names.length)
writeFileSync(join(out, 'roster.ndjson'), names.map((n) => JSON.stringify({ id: n.toLowerCase(), type: 'Member', data: { name: n } })).join('\\n') + '\\n')
`

async function setup() {
  const w = await world()
  const meta = newCollection(w.ctx, 'test/org/roster')
  w.home.writeSchemas(meta, { Member })
  mkdirSync(join(w.home.root, 'scripts', 'mitp'), { recursive: true })
  writeFileSync(join(w.home.root, 'scripts', 'mitp', 'members.mjs'), SCRIPT)
  writeFileSync(
    join(w.home.root, 'scripts', 'check.sh'),
    '# underlay: check\necho checking; exit 3\n',
  )
  return { ...w, meta }
}

describe('scripts and runs', () => {
  it('reads declarations, runs a script, and saves a version for what changed', async () => {
    const w = await setup()
    const scripts = listScripts(w.ctx)
    expect(scripts.map((s) => [s.name, s.kind, s.writes])).toEqual([
      ['home/check', 'check', []],
      ['home/mitp/members', 'script', ['test/org/roster']],
    ])
    expect(takesFile('*.json', 'inputs/x.json')).toBe(true)
    expect(takesFile('*.xlsx, *.csv', 'roster.CSV')).toBe(true)
    expect(takesFile('*.json', 'x.jsonl')).toBe(false)

    const info = findScript(w.ctx, 'members')
    let printed = ''
    const r1 = await runScript(w.ctx, info, ['Ada', 'Grace'], { onOutput: (t) => (printed += t) })
    expect(printed).toContain('writing 2')
    expect(r1).toMatchObject({ status: 'ok', exitCode: 0, unchanged: [] })
    expect(r1.saved).toMatchObject([{ collection: 'test/org/roster', semver: 'v1.0.0', added: 2 }])
    expect(readFileSync(r1.log, 'utf8')).toContain('writing 2')
    const c = openColl(w.ctx, w.meta)
    expect(c.store.state(w.meta.id).versions[r1.saved[0]!.id]?.run).toBe(r1.id)

    const r2 = await runScript(w.ctx, info, ['Ada', 'Grace'])
    expect(r2.saved).toEqual([])
    expect(r2.unchanged).toEqual(['test/org/roster'])
    const r3 = await runScript(w.ctx, info, ['Ada'])
    expect(r3.saved).toMatchObject([{ semver: 'v1.1.0', removed: 1 }])

    const check = await runScript(w.ctx, findScript(w.ctx, 'check.sh'), [])
    expect(check).toMatchObject({ status: 'failed', exitCode: 3, saved: [] })
    expect(listRuns(w.ctx).map((r) => r.status)).toEqual(['failed', 'ok', 'ok', 'ok'])

    // Two runs never write one collection at once.
    const release = lock(w.ctx, 'test/org/roster', 'someone')
    // The lock of this same process is taken over (it is ours); another process's is not.
    writeFileSync(
      join(w.home.stateDir, 'locks', 'test__org__roster.lock'),
      JSON.stringify({ pid: process.ppid, run: 'other' }),
    )
    await expect(runScript(w.ctx, info, ['Ada'])).rejects.toThrow(/being written by run other/)
    release()
  })
})

describe('built-in importers', () => {
  it("keeps what a script wrote for a collection that isn't here, and makes it from that", async () => {
    const w = await world()
    mkdirSync(join(w.home.root, 'scripts'), { recursive: true })
    writeFileSync(
      join(w.home.root, 'scripts', 'papers.mjs'),
      `// underlay: writes test/org/papers
import { mkdirSync, writeFileSync } from 'node:fs'
const dir = process.env.UNDERLAY_OUT + '/test/org'
mkdirSync(dir, { recursive: true })
const rows = [
  { id: 'p1', type: 'Paper', data: { title: 'One', year: 2024, open: true } },
  { id: 'p2', type: 'Paper', data: { title: 'Two', year: 2025 } },
]
writeFileSync(dir + '/papers.ndjson', rows.map((r) => JSON.stringify(r)).join('\\n') + '\\n')
`,
    )
    let said = ''
    const r = await runScript(w.ctx, findScript(w.ctx, 'papers'), [], {
      onOutput: (t) => (said += t),
    })
    expect(r.status).toBe('ok')
    expect(r.saved).toEqual([])
    expect(r.missing).toEqual([{ collection: 'test/org/papers', records: 2, types: ['Paper'] }])
    expect(said).toContain('test/org/papers isn’t here: 2 Paper records kept with this run')
    // Made, then filled from the run: a schema drafted from the records, and v1.0.0.
    const meta = newCollection(w.ctx, 'test/org/papers')
    const s = await saveFromRun(w.ctx, r.id, 'test/org/papers', meta)
    expect(s).toMatchObject({ semver: 'v1.0.0', added: 2, types: ['Paper'] })
    expect(w.home.schemas(meta).Paper).toEqual({
      type: 'object',
      properties: {
        title: { type: 'string' },
        year: { type: 'integer' },
        open: { type: 'boolean' },
      },
      required: ['title', 'year'],
    })
    const again = readRun(w.ctx, r.id)
    expect(again.missing).toEqual([])
    expect(again.saved).toMatchObject([{ collection: 'test/org/papers', semver: 'v1.0.0' }])
  })

  it('stores the files a run wrote that its records point to, and refuses a missing one', async () => {
    const w = await world()
    const meta = newCollection(w.ctx, 'test/org/papers')
    const Paper = {
      type: 'object',
      properties: { title: { type: 'string' }, pdf: { type: 'object', required: ['$file'] } },
      required: ['title'],
    }
    w.home.writeSchemas(meta, { Paper })
    mkdirSync(join(w.home.root, 'scripts'), { recursive: true })
    const script = (missing: boolean) => `// underlay: writes test/org/papers
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
const out = process.env.UNDERLAY_OUT
mkdirSync(out + '/test/org', { recursive: true })
mkdirSync(out + '/files/pdfs', { recursive: true })
const sha = (b) => createHash('sha256').update(b).digest('hex')
const a = Buffer.from('first paper'), b = Buffer.from('second paper')
writeFileSync(out + '/files/pdfs/a.pdf', a)
writeFileSync(out + '/files/b.pdf', b)
writeFileSync(out + '/files/stray.txt', 'nothing points here')
const ref = (x) => ({ $file: 'sha256:' + sha(x) })
const rows = [
  { id: 'p1', type: 'Paper', data: { title: 'One', pdf: ref(a) } },
  { id: 'p2', type: 'Paper', data: { title: 'Two', pdf: ref(b) } },
  { id: 'p3', type: 'Paper', data: { title: 'Three', pdf: ref(a) } },
  ${missing ? "{ id: 'p77', type: 'Paper', data: { title: 'Gone', pdf: ref(Buffer.from('never written')) } }," : ''}
]
writeFileSync(out + '/test/org/papers.ndjson', rows.map((r) => JSON.stringify(r)).join('\\n') + '\\n')
`
    writeFileSync(join(w.home.root, 'scripts', 'papers.mjs'), script(false))
    let said = ''
    const r = await runScript(w.ctx, findScript(w.ctx, 'papers'), [], {
      onOutput: (t) => (said += t),
    })
    expect(r.status).toBe('ok')
    expect(r.saved).toMatchObject([
      { collection: 'test/org/papers', added: 3, files: { added: 2, bytes: 23, here: 0 } },
    ])
    expect(said).toContain('1 file in files/ that no record points to was left out')
    const c = openColl(w.ctx, meta)
    const { listAssets } = await import('../src/core/assets.js')
    expect((await listAssets(c)).map((a) => a.mediaType)).toEqual([
      'application/pdf',
      'application/pdf',
    ])

    // A record pointing to a file the run didn't write: nothing is saved, and it says which.
    writeFileSync(join(w.home.root, 'scripts', 'papers.mjs'), script(true))
    const bad = await runScript(w.ctx, findScript(w.ctx, 'papers'), [], {})
    expect(bad.status).toBe('failed')
    expect(bad.error).toMatch(
      /^org\/papers: 1 record points to a file the run didn't write: Paper p77  pdf  sha256:[0-9a-f]{6}… Write it to \$UNDERLAY_OUT\/files\/, or leave the field out\.$/,
    )
    expect(bad.saved).toEqual([])
  })

  it('matches a dropped file to a collection by its ids, imports it, holds rows without ids', async () => {
    const w = await setup()
    const c = openColl(w.ctx, w.meta)
    await saveVersion(c, {
      rows: ['a1', 'a2', 'a3'].map((id) => v3.rowFromRecord(id, 'Member', { name: id })),
      mode: 'set',
      schemas: { Member },
      message: 'first',
      now: new Date(),
    })
    const dir = tmp()
    const csv = join(dir, 'roster.csv')
    writeFileSync(
      csv,
      'person_id,Name,Unit,Year,Email\na1,Ada,CSAIL,1999,ada@x\na2,Bob,CSAIL,2001,\na4,Cy,LIDS,2003,\n,Nobody,CSAIL,,n@x\n',
    )
    const shape = await addFile(w.ctx, csv)
    expect(shape.path).toBe('inputs/roster.csv')
    expect(shape.tables[0]).toMatchObject({
      rows: 4,
      idColumns: ['person_id', 'Name'],
      personal: ['Email'],
    })
    expect(shape.matches[0]).toMatchObject({
      collection: 'test/org/roster',
      type: 'Member',
      column: 'person_id',
      hits: 2,
      of: 3,
    })
    const t = await readTable(join(w.home.root, shape.path))
    const opts = defaultOptions(w.ctx, shape.path, t, {
      collection: 'test/org/roster',
      type: 'Member',
      id: 'person_id',
    })
    expect(opts.columns).toEqual({ Name: 'name', Unit: 'unit', Year: 'year', Email: '' })
    const rel = saveImport(w.ctx, 'roster', opts)
    const info = findScript(w.ctx, rel)
    expect(info).toMatchObject({
      kind: 'import',
      writes: ['test/org/roster'],
      mode: 'set',
      types: ['Member'],
    })
    const r = await runScript(w.ctx, info, [shape.path], {
      importer: (i, a, out, log) => runImport(w.ctx, i, a, out, log),
    })
    expect(r.status).toBe('ok')
    // With a row held, nothing is removed (a3 stays); a1 changed, a2 changed, a4 added.
    expect(r.saved).toMatchObject([{ added: 1, changed: 2, removed: 0 }])
    expect(readFileSync(heldPath(w.ctx, 'roster'), 'utf8')).toContain('"row":5')
    const view = await v3.openView(c.store.fs, w.meta.id)
    const a1 = await v3.getRecord(c.store.fs, view, 'Member', 'a1')
    expect(JSON.parse(new TextDecoder().decode(a1!.line!)).data).toEqual({
      name: 'Ada',
      unit: 'CSAIL',
      year: 1999,
    })

    // A choice for the held row (none: leave it out), and the run is a whole set again.
    writeFileSync(decisionsPath(w.ctx, 'roster'), JSON.stringify({ '5': null }))
    const r2 = await runScript(w.ctx, info, [shape.path], {
      importer: (i, a, out, log) => runImport(w.ctx, i, a, out, log),
    })
    expect(r2.saved).toMatchObject([{ removed: 1 }])

    // Ejected, it is a script that declares the same things.
    const ts = eject(w.ctx, info)
    expect(findScript(w.ctx, ts)).toMatchObject({
      kind: 'script',
      writes: ['test/org/roster'],
      types: ['Member'],
    })
    expect((await unpushedOf(c)).length).toBe(3)
  })

  it('reads SQLite tables and JSON', async () => {
    const dir = tmp()
    const db = new DatabaseSync(join(dir, 'x.sqlite'))
    db.exec(
      "CREATE TABLE units (id TEXT, name TEXT); INSERT INTO units VALUES ('u1','CSAIL'),('u2','LIDS')",
    )
    db.close()
    const t = await readTable(join(dir, 'x.sqlite'))
    expect(t).toMatchObject({
      name: 'units',
      columns: ['id', 'name'],
      rows: [
        { id: 'u1', name: 'CSAIL' },
        { id: 'u2', name: 'LIDS' },
      ],
    })
    const q = await readTable(join(dir, 'x.sqlite'), {
      query: "SELECT id FROM units WHERE name = 'LIDS'",
    })
    expect(q.rows).toEqual([{ id: 'u2' }])
    writeFileSync(
      join(dir, 'x.json'),
      JSON.stringify({ people: [{ id: 1 }], units: [{ id: 'u' }], meta: { a: 1 } }),
    )
    await expect(readTable(join(dir, 'x.json'))).rejects.toThrow(/2 sheets or tables/)
    expect((await readTable(join(dir, 'x.json'), { sheet: 'units' })).rows).toEqual([{ id: 'u' }])
  })

  it('reads Excel sheets', async () => {
    const dir = tmp()
    const parts: Record<string, string> = {
      '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
      '_rels/.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Members" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>person_id</t></is></c><c r="B1" t="inlineStr"><is><t>Name</t></is></c><c r="C1" t="inlineStr"><is><t>Year</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>a1</t></is></c><c r="B2" t="inlineStr"><is><t>Ada</t></is></c><c r="C2"><v>1999</v></c></row></sheetData></worksheet>`,
    }
    const src = join(dir, 'src')
    for (const [name, text] of Object.entries(parts)) {
      mkdirSync(join(src, name, '..'), { recursive: true })
      writeFileSync(join(src, name), text)
    }
    try {
      execFileSync('zip', ['-qr', join(dir, 'roster.xlsx'), '.'], { cwd: src })
    } catch {
      return // No zip here to make the fixture with.
    }
    const t = await readTable(join(dir, 'roster.xlsx'))
    expect(t).toMatchObject({
      name: 'Members',
      columns: ['person_id', 'Name', 'Year'],
      rows: [{ person_id: 'a1', Name: 'Ada', Year: 1999 }],
    })
  })
})
