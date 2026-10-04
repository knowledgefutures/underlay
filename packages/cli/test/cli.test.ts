import { mkdtemp, rm as rmDir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import * as schema from '../../server/src/db/schema.js'
import { cleanup as cleanupHarness, harness, type Harness } from '../../server/test/harness.js'
import { commit } from '../src/commands/commit.js'
import { diff, log, remoteAdd, status } from '../src/commands/info.js'
import { add, fileAdd, metaSet, rm, schemaSet } from '../src/commands/stage.js'
import { clone, pull, push } from '../src/commands/sync.js'
import { CliError, Local } from '../src/local.js'
import { versionState } from '../src/state.js'

const dirs: string[] = []
afterAll(async () => {
  for (const d of dirs.splice(0)) await rmDir(d, { recursive: true, force: true })
  await cleanupHarness()
})

async function tmp() {
  const d = await mkdtemp(join(tmpdir(), 'ul-cli-'))
  dirs.push(d)
  return d
}

const quiet = () => {
  const lines: string[] = []
  return Object.assign((l: string) => void lines.push(l), { lines })
}

const Book = {
  type: 'object',
  properties: { title: { type: 'string' }, cover: { type: 'object' } },
  required: ['title'],
}
const Note = { type: 'object', properties: { text: { type: 'string' } }, private: true }

async function writeNdjson(dir: string, name: string, rows: unknown[]) {
  const path = join(dir, name)
  await writeFile(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  return path
}

/** Route registry requests to an in-process app; a token stands for the member. */
function registry(h: Harness, user: string) {
  return async (url: string, init: RequestInit = {}) => {
    if (url.startsWith('memory://')) throw new Error(`unexpected presigned URL ${url}`)
    const headers = new Headers(init.headers)
    if (headers.get('authorization')) headers.set('x-test-user', user)
    headers.delete('authorization')
    return h.app.fetch(
      new Request(url.replace(/^https?:\/\/[^/]+/, 'http://test'), { ...init, headers }),
    )
  }
}

async function contents(local: Local) {
  const s = await versionState(local, local.headVersion()!)
  return { metadata: s.root.metadata, public: s.public, private: s.private.types }
}

describe('offline', () => {
  it('stages, validates and commits versions, and diffs them', async () => {
    const dir = await tmp()
    const local = Local.init(dir)
    const say = quiet()
    await writeFile(join(dir, 'schemas.json'), JSON.stringify({ Book, Note }))
    await schemaSet(local, join(dir, 'schemas.json'), say)
    const bad = await writeNdjson(dir, 'bad.ndjson', [
      { id: 'b1', type: 'Book', data: { title: 5 } },
    ])
    await expect(add(local, bad, {}, say)).rejects.toThrow(/Nothing staged; invalid records/)
    const books = await writeNdjson(dir, 'books.ndjson', [
      ...Array.from({ length: 3000 }, (_, i) => ({
        id: `b${i}`,
        type: 'Book',
        data: { title: `T${i}` },
      })),
      { id: 'secret', type: 'Book', data: { title: 'hidden' }, private: true },
      { id: 'n1', type: 'Note', data: { text: 'private type' } },
    ])
    expect(await add(local, books, {}, say)).toBe(3002)
    const v1 = await commit(local, 'first', say)
    expect(v1.semver).toBe('v1.0.0')
    const s1 = await versionState(local, v1)
    expect(s1.public.types.Book!.count).toBe(3000)
    expect(s1.private.types.Book!.count).toBe(1)
    expect(s1.private.types.Note!.count).toBe(1)

    // A file must be in the repository before a record can reference it.
    await writeFile(join(dir, 'cover.png'), 'png bytes')
    const withCover = await writeNdjson(dir, 'c.ndjson', [
      {
        id: 'b7',
        type: 'Book',
        data: { title: 'T7', cover: { $file: `sha256:${'a'.repeat(64)}` } },
      },
    ])
    await add(local, withCover, {}, say)
    await expect(commit(local, 'missing file', say)).rejects.toThrow(/underlay file add/)
    local.clearStaging()
    const [hash] = await fileAdd(local, [join(dir, 'cover.png')], say)
    const ok = await writeNdjson(dir, 'c2.ndjson', [
      { id: 'b7', type: 'Book', data: { title: 'T7', cover: { $file: `sha256:${hash}` } } },
    ])
    await add(local, ok, {}, say)
    rm(local, 'Book', ['b1', 'b2'], say)
    await writeFile(join(dir, 'meta.json'), JSON.stringify({ title: 'Books' }))
    metaSet(local, join(dir, 'meta.json'), say)
    const v2 = await commit(local, 'second', say)
    expect(v2.semver).toBe('v1.1.0')
    const s2 = await versionState(local, v2)
    expect(s2.public.types.Book!.count).toBe(2998)
    expect(s2.public.files.count).toBe(1)
    expect(s2.root.metadata).toEqual({ title: 'Books' })

    const out = quiet()
    await diff(local, 'v1.0.0', 'v1.1.0', out)
    expect(out.lines.join('\n')).toMatch(/Book: \+0 ~1 -2/)
    log(local, out)
    status(local, out)
    expect(out.lines.join('\n')).toMatch(/Nothing staged/)
    await expect(commit(local, 'again', say)).rejects.toThrow(/Nothing staged/)
  })
})

describe('with a registry', () => {
  async function setup() {
    const h = await harness()
    const user = await h.member()
    await h.collection('books')
    const fetch = registry(h, user)
    const dir = await tmp()
    const local = Local.init(dir)
    const say = quiet()
    remoteAdd(
      local,
      'origin',
      'https://registry.test',
      { collection: 'org/books', token: 'k' },
      say,
    )
    await writeFile(join(dir, 'schemas.json'), JSON.stringify({ Book, Note }))
    await schemaSet(local, join(dir, 'schemas.json'), say)
    await add(
      local,
      await writeNdjson(dir, 'books.ndjson', [
        ...Array.from({ length: 1200 }, (_, i) => ({
          id: `b${i}`,
          type: 'Book',
          data: { title: `T${i}` },
        })),
        { id: 'secret', type: 'Book', data: { title: 'hidden' }, private: true },
        { id: 'n1', type: 'Note', data: { text: 'note' } },
      ]),
      {},
      say,
    )
    await commit(local, 'first', say)
    return { h, user, fetch, dir, local, say }
  }

  it('pushes, then clones and round-trips between two repositories', async () => {
    const { h, user, fetch, dir, local, say } = await setup()
    const before = await contents(local)
    // The registry's private salt isn't this repository's: the push is checked by
    // content, and the registry's version (and salt) adopted.
    const pushed = await push(local, 'origin', { fetch }, say)
    expect(pushed!.semver).toBe('v1.0.0')
    expect(await contents(local)).toEqual({ ...before, private: before.private })
    expect(local.headVersion()!.hash).toBe(pushed!.hash)
    const api = await h.request('/api/collections/org/books/versions/latest', { user })
    expect(((await api.json()) as { hash: string }).hash).toBe(pushed!.hash)

    // A second repository, cloned with a token, gets the private sets too.
    const dir2 = join(await tmp(), 'clone')
    const other = await clone(
      'https://registry.test',
      'org/books',
      dir2,
      { fetch, token: 'k' },
      say,
    )
    expect(await contents(other)).toEqual(await contents(local))

    // Change it there, with the registry's salt now known: hashes match exactly.
    await writeFile(
      join(dir2, 'more.ndjson'),
      JSON.stringify({ id: 'b9999', type: 'Book', data: { title: 'new' } }) + '\n',
    )
    await add(other, join(dir2, 'more.ndjson'), {}, say)
    rm(other, 'Book', ['b3'], say)
    const localV2 = await commit(other, 'from the clone', say)
    const v2 = await push(other, 'origin', { fetch }, say)
    expect(v2!.hash).toBe(localV2.hash)

    // The first repository can't push past it, and pulls it.
    await writeFile(
      join(dir, 'x.ndjson'),
      JSON.stringify({ id: 'x', type: 'Book', data: { title: 'x' } }) + '\n',
    )
    await add(local, join(dir, 'x.ndjson'), {}, say)
    await commit(local, 'diverged', say)
    await expect(push(local, 'origin', { fetch }, say)).rejects.toThrow(/Pull first/)
    await expect(pull(local, 'origin', { fetch }, say)).rejects.toThrow(/push it first/)
    const got = await pull(local, 'origin', { fetch, force: true }, say)
    expect(got!.hash).toBe(v2!.hash)
    expect(await contents(local)).toEqual(await contents(other))
  })

  it('clones without a token: public sets only', async () => {
    const { h, fetch, local, say } = await setup()
    await push(local, 'origin', { fetch }, say)
    const anon = async (url: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers)
      headers.delete('authorization')
      return fetch(url, { ...init, headers })
    }
    const dir2 = join(await tmp(), 'public')
    // The collection is private until made public.
    await expect(
      clone('https://registry.test', 'org/books', dir2, { fetch: anon }, say),
    ).rejects.toThrow(CliError)
    await h.ports.db.update(schema.collections).set({ public: true })
    const pub = await clone('https://registry.test', 'org/books', `${dir2}-2`, { fetch: anon }, say)
    expect(pub.headVersion()!.sets).toBe('public')
    const mine = await contents(local)
    const theirs = await contents(pub)
    expect(theirs.public).toEqual(mine.public)
    expect(theirs.private).toEqual({})
    expect(theirs.public.types.Book!.count).toBe(1200)
  })
})
