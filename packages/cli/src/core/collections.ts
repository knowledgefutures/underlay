/**
 * Collections on this machine: listing a remote's, adding them, starting new ones, what is
 * kept, and how each stands (local-tool-build.md phase 1).
 */
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { v3 } from '@underlay/protocol'

import { type Keep, ruleFor } from './config.js'
import { type Coll, type Ctx, openColl } from './context.js'
import { CliError } from './env.js'
import { type CollectionMeta, type CollectionRef, keyOf, parseRef } from './home.js'
import { Remote, type RemoteCollection } from './remote.js'
import { fetchKept, pull } from './sync.js'
import { cidOf, schemasAt, unpushedOf, viewOf } from './versions.js'

/** Collections the CLI can sync: v3. A v2 collection is left out of every list. */
const syncable = (c: RemoteCollection) => c.protocol === undefined || c.protocol === 3

export const KEEP_MARK: Record<Keep, string> = { all: '■', some: '◧', none: '□' }

export interface RemoteListing {
  remote: string
  signedIn: boolean
  user: { name: string; email: string } | null
  orgs: {
    slug: string
    name: string
    role: string
    collections: (RemoteCollection & { here: CollectionMeta | null })[]
  }[]
}

/** Your orgs on a remote and their collections, each with what is here. */
export async function listRemote(ctx: Ctx, name: string): Promise<RemoteListing> {
  const remote = Remote.open(ctx.env, ctx.settings, name, ctx.say)
  if (!remote.signedIn) return { remote: name, signedIn: false, user: null, orgs: [] }
  const me = await remote.me()
  const here = ctx.home.collections()
  const orgs = await Promise.all(
    me.orgs.map(async (o) => ({
      slug: o.slug,
      name: o.name,
      role: o.role,
      collections: (await remote.orgCollections(o.slug)).filter(syncable).map((c) => ({
        ...c,
        here:
          here.find((h) => h.authority === name && h.org === o.slug && h.name === c.slug) ?? null,
      })),
    })),
  )
  return { remote: name, signedIn: true, user: { name: me.name, email: me.email }, orgs }
}

/** Public collections on a remote, by search. */
export async function listPublic(ctx: Ctx, name: string, q?: string) {
  const remote = Remote.open(ctx.env, ctx.settings, name, ctx.say)
  const here = ctx.home.collections()
  return (await remote.publicCollections(q)).filter(syncable).map((c) => ({
    ...c,
    here:
      here.find((h) => h.authority === name && h.org === c.ownerSlug && h.name === c.slug) ?? null,
  }))
}

/** Add a collection from its authority: its folder, schemas and log, and its files if kept. */
export async function addCollection(
  ctx: Ctx,
  text: string,
  opts: { keep?: Keep; types?: string[] } = {},
): Promise<{ coll: Coll; pulled: Awaited<ReturnType<typeof pull>> }> {
  const ref = parseRef(text, ctx.settings.defaultRemote)
  if (ctx.home.readCollection(ref))
    throw new CliError(`${keyOf(ref)} is here already (underlay pull)`)
  const remote = Remote.open(ctx.env, ctx.settings, ref.authority, ctx.say)
  const info = await remote.collection(ref.org, ref.name)
  // Nothing is written for a collection that can't be followed (a v2 one).
  await remote.checkSyncable(ref.org, ref.name)
  const keep = opts.keep ?? ruleFor(ctx.settings, keyOf(ref)).keep ?? 'all'
  const meta: CollectionMeta = {
    ...ref,
    id: info.id,
    copies: [],
    keep,
    types: opts.types ?? [],
    access: info.public ? 'public' : 'private',
    isNew: false,
    title: info.name ?? null,
    pulled: null,
    pushed: null,
  }
  ctx.home.writeCollection(meta)
  writeFileSync(
    join(ctx.home.collectionDir(ref), 'README.md'),
    `# ${info.name}\n\n${info.description ?? ''}\n\nOn ${ref.authority}: ${remote.url}/${ref.org}/${ref.name}\n`,
  )
  const coll = openColl(ctx, meta)
  try {
    const pulled = await pull(ctx, coll)
    // All the head's schemas, not only those that changed since nothing.
    if ((await v3.headNumber(coll.store.fs, meta.id)) > 0) {
      ctx.home.writeSchemas(meta, await schemasAt(coll.data, await viewOf(coll)))
    }
    return { coll: openColl(ctx, ctx.home.collection(ref)), pulled }
  } catch (err) {
    // A collection half added is worse than none: it would sit in the sidebar, unpulled, and
    // the next add of it would say it is here already.
    rmSync(ctx.home.collectionDir(ref), { recursive: true, force: true })
    await dropLocalLog(coll)
    throw err
  }
}

/** The store's log and notes for a collection (its record files stay: others may name them). */
async function dropLocalLog(c: Coll): Promise<void> {
  const prefix = v3.collectionPrefix(cidOf(c))
  let cursor: string | undefined
  do {
    const page = await c.store.fs.list(prefix, cursor)
    for (const k of page.keys) await c.store.fs.delete(k)
    cursor = page.cursor
  } while (cursor)
  rmSync(c.store.statePath(cidOf(c)), { force: true })
}

/** Start a collection that is not on its authority yet; its first push creates it there. */
export function newCollection(
  ctx: Ctx,
  text: string,
  opts: { access?: 'public' | 'private'; title?: string } = {},
): CollectionMeta {
  const ref = parseRef(text, ctx.settings.defaultRemote)
  if (ctx.home.readCollection(ref)) throw new CliError(`${keyOf(ref)} is here already`)
  const meta: CollectionMeta = {
    ...ref,
    id: crypto.randomUUID(),
    copies: [],
    keep: 'all',
    types: [],
    access: opts.access ?? 'private',
    isNew: true,
    title: opts.title ?? null,
    pulled: null,
    pushed: null,
  }
  ctx.home.writeCollection(meta)
  writeFileSync(
    join(ctx.home.collectionDir(ref), 'README.md'),
    `# ${opts.title ?? ref.name}\n\nNew: not on ${ref.authority} yet. Its first push creates it there.\n`,
  )
  return meta
}

/** Keep all of a collection here (or only some types), fetching what is missing. */
export async function keep(ctx: Ctx, c: Coll, types?: string[]): Promise<number> {
  const meta: CollectionMeta = {
    ...c.meta,
    keep: types?.length ? 'some' : 'all',
    types: types ?? [],
  }
  ctx.home.writeCollection(meta)
  return fetchKept(openColl(ctx, meta))
}

/** Keep only a collection's metadata here: its files go, unless something else names them. */
export async function forget(ctx: Ctx, c: Coll): Promise<number> {
  ctx.home.writeCollection({ ...c.meta, keep: 'none', types: [] })
  if ((await v3.headNumber(c.store.fs, cidOf(c))) === 0) return 0
  const view = await viewOf(c)
  // Files a version not yet pushed names stay: they can't be fetched again.
  const needed = new Set<string>()
  for (const s of await unpushedOf(c)) for (const f of v3.commitFiles(s.commit)) needed.add(f.id)
  for (const other of ctx.home.collections()) {
    if (other.keep === 'none' || keyOf(other) === c.key) continue
    const o = openColl(ctx, other)
    if (o.store.root !== c.store.root || (await v3.headNumber(o.store.fs, other.id)) === 0) continue
    for (const f of (await viewOf(o)).files) needed.add(f.id)
  }
  // A file another kept collection, or a version not yet pushed, names stays; anything else
  // can be fetched again from the authority.
  const drop = view.files.map((f) => f.id).filter((id) => !needed.has(id))
  let n = 0
  for (const id of new Set(drop)) {
    if (!(await c.store.fs.head(v3.recordKey(id)))) continue
    await c.store.fs.delete(v3.recordKey(id))
    n++
  }
  return n
}

export interface CollectionStatus {
  key: string
  ref: CollectionRef
  id: string
  authority: string
  access: 'public' | 'private'
  keep: Keep
  isNew: boolean
  /** The newest version here. */
  head: { number: number; semver: string; id: string } | null
  /** The authority's newest, as of the last pull or push. */
  remote: { number: number; semver: string } | null
  unpushed: number
  store: string
  pulled: string | null
  pushed: string | null
}

export async function collectionStatus(ctx: Ctx, meta: CollectionMeta): Promise<CollectionStatus> {
  const c = openColl(ctx, meta)
  const head = await v3.findHead(c.store.fs, meta.id)
  const state = c.store.state(meta.id)
  return {
    key: c.key,
    ref: { authority: meta.authority, org: meta.org, name: meta.name },
    id: meta.id,
    authority: meta.authority,
    access: meta.access,
    keep: meta.keep,
    isNew: meta.isNew,
    head: head ? { number: head.commit.number, semver: head.commit.semver, id: head.id } : null,
    remote: state.remote ? { number: state.remote.number, semver: state.remote.semver } : null,
    unpushed: (head?.commit.number ?? 0) - (state.remote?.number ?? 0),
    store: c.store.root,
    pulled: meta.pulled,
    pushed: meta.pushed,
  }
}
