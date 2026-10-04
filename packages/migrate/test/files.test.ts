/** Copying v1 file objects to their canonical keys in the deployment's bucket. */
import { createHash } from 'node:crypto'

import { memoryStore } from '@underlay/protocol'
import { dbSchema as schema } from '@underlay/server'
import { afterAll, describe, expect, it } from 'vitest'

import { cleanup, harness } from '../../server/test/harness.js'
import { copyFiles } from '../src/files.js'

afterAll(cleanup)

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const v1Key = (h: string) => `files/${h.slice(0, 2)}/${h.slice(2, 4)}/${h}`

describe('copyFiles', () => {
  it('copies verified bytes, repoints rows, reports the rest, and re-runs cleanly', async () => {
    const h = await harness()
    const source = memoryStore()
    const files = {
      good: 'cover bytes',
      missing: 'never uploaded',
      wrong: 'expected bytes',
      present: 'already copied',
    }
    for (const [name, body] of Object.entries(files)) {
      await h.ports.db.insert(schema.files).values({
        hash: sha(body),
        size: body.length,
        mimeType: 'text/plain',
        storageKey: v1Key(sha(body)),
      })
      if (name === 'good') await source.put(v1Key(sha(body)), body)
      if (name === 'wrong') await source.put(v1Key(sha(body)), 'tampered bytes')
    }
    const canonical = (body: string) => h.ports.stores.canonicalFileKey(sha(body))
    await h.ports.stores.fileBytes.put(canonical(files.present), files.present)

    const report = await copyFiles(source, h.ports, { concurrency: 2 })
    expect(report).toMatchObject({
      copied: 1,
      present: 1,
      bytes: files.good.length,
      missing: [sha(files.missing)],
      mismatched: [sha(files.wrong)],
      tooLarge: [],
    })
    expect(await (await h.ports.stores.fileBytes.get(canonical(files.good)))!.text()).toBe(
      files.good,
    )
    const keys = Object.fromEntries(
      (await h.ports.db.select().from(schema.files)).map((f) => [f.hash, f.storageKey]),
    )
    expect(keys[sha(files.good)]).toBe(canonical(files.good))
    expect(keys[sha(files.present)]).toBe(canonical(files.present))
    expect(keys[sha(files.missing)]).toBe(v1Key(sha(files.missing)))

    // Moved rows are skipped; only the failures are tried again.
    const again = await copyFiles(source, h.ports)
    expect(again).toMatchObject({ copied: 0, present: 0 })
    expect(again.missing).toHaveLength(1)
    expect(again.mismatched).toHaveLength(1)
  })
})
