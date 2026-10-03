import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import * as schema from '../src/db/schema.js'
import { cleanup, harness } from './harness.js'

afterAll(cleanup)

const LONG = 'T'.repeat(120)

async function json(res: Response) {
  return (await res.json()) as any
}

describe('export', () => {
  it('streams a valid tar.gz of what the caller may read', async () => {
    const h = await harness()
    const user = await h.member()
    await h.collection('lib')
    await h.ports.db.update(schema.collections).set({ public: true })
    const base = '/api/collections/org/lib'
    const file = 'file bytes'
    const fileHash = createHash('sha256').update(file).digest('hex')
    await h.request(`${base}/files/${fileHash}`, { method: 'PUT', user, body: file })
    const Doc = { type: 'object' }
    const sid = (
      await json(
        await h.request(`${base}/push`, {
          method: 'POST',
          user,
          json: { schemas: { Doc, [LONG]: Doc }, metadata: { readme: '# Lib\n' } },
        }),
      )
    ).session_id
    await h.request(`${base}/push/${sid}/records`, {
      method: 'POST',
      user,
      ndjson: [
        { id: 'd1', type: 'Doc', data: { title: 'Ünïcode ✓', f: { $file: `sha256:${fileHash}` } } },
        { id: 'd2', type: 'Doc', data: { title: 'hidden' }, private: true },
        { id: 'l1', type: LONG, data: { x: 1 } },
      ],
    })
    expect((await h.request(`${base}/push/${sid}/commit`, { method: 'POST', user })).status).toBe(
      201,
    )

    const res = await h.request(`${base}/export`)
    expect(res.headers.get('content-disposition')).toContain('org-lib-v1.0.0.tar.gz')
    const dir = await mkdtemp(join(tmpdir(), 'ul-export-'))
    await writeFile(join(dir, 'a.tar.gz'), new Uint8Array(await res.arrayBuffer()))
    execFileSync('tar', ['-xzf', 'a.tar.gz'], { cwd: dir })
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
    expect(manifest.version).toMatchObject({ semver: 'v1.0.0', recordCount: 2, fileCount: 1 })
    expect(await readFile(join(dir, 'README.md'), 'utf8')).toBe('# Lib\n')
    const docs = (await readFile(join(dir, 'records/Doc.ndjson'), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(docs.map((d) => d.id)).toEqual(['d1']) // private record excluded for anonymous readers
    expect(docs[0].hash).toMatch(/^[0-9a-f]{64}$/)
    expect(
      (await readFile(join(dir, `records/${LONG}.ndjson`), 'utf8')).trim().split('\n').length,
    ).toBe(1)
    expect(await readFile(join(dir, `files/${fileHash}`), 'utf8')).toBe(file)

    // Members get the private record too; plain tar works as well.
    const owner = await h.request(`${base}/export?format=tar`, { user })
    await writeFile(join(dir, 'b.tar'), new Uint8Array(await owner.arrayBuffer()))
    execFileSync('mkdir', ['-p', 'b'], { cwd: dir })
    execFileSync('tar', ['-xf', '../b.tar'], { cwd: join(dir, 'b') })
    const all = (await readFile(join(dir, 'b/records/Doc.ndjson'), 'utf8')).trim().split('\n')
    expect(all.length).toBe(2)
  })
})
