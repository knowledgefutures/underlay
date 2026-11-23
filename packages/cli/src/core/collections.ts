/**
 * Collections on this machine: listing a remote's, adding them, starting new ones, what is
 * kept, and how each stands (local-tool-build.md phase 1).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { v3 } from '@underlay/protocol'

import { assetsHere, fetchAssets, forgetAssets, listAssets } from './assets.js'
import { type Keep, ruleFor } from './config.js'
import { type Coll, type Ctx, openColl } from './context.js'
import { CliError } from './env.js'
import { type CollectionMeta, type CollectionRef, isLocal, keyOf, parseRef } from './home.js'
import { nameProblem } from './names.js'
import { Remote, type RemoteCollection } from './remote.js'
import { fetchKept, pull } from './sync.js'
import { cidOf, schemasAt, unpushedOf, viewOf } from './versions.js'

/** Collections the CLI can sync: v3. A v2 collection is left out of every list. */
const syncable = (c: RemoteCollection) => c.protocol === undefined || c.protocol === 3

/** What a collection keeps here, as a mark: nothing when all of it is here. */
export const KEEP_MARK: Record<Keep, string> = { all: ' ', records: '◐', some: '◐', none: '○' }
/** Each level in words. */
export const KEEP_LABEL: Record<Keep, string> = {
  all: 'everything',
  records: 'data, no assets',
  some: 'some types',
  none: 'metadata only',
}

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

/**
 * Take a collection off this machine: its folder, and the store's copy of its history. It is
 * untouched on its authority, and can be added again. Versions not yet pushed would be lost,
 * so a collection with any is kept unless `force`.
 */
export async function removeCollection(ctx: Ctx, c: Coll, force = false): Promise<void> {
  const unpushed =
    c.meta.isNew || (await v3.headNumber(c.store.fs, cidOf(c))) === 0 ? [] : await unpushedOf(c)
  const n = c.meta.isNew ? await v3.headNumber(c.store.fs, cidOf(c)) : unpushed.length
  if (n > 0 && !force)
    throw new CliError(
      isLocal(c.meta)
        ? `${c.key} has ${n} version${n === 1 ? '' : 's'}, here only, which would be lost: --force to delete them`
        : `${c.key} has ${n} version${n === 1 ? '' : 's'} not pushed, which would be lost: push first, or --force`,
    )
  rmSync(ctx.home.collectionDir(c.meta), { recursive: true, force: true })
  await dropLocalLog(c)
}

const readmeOf = (ref: CollectionRef, title: string | null) =>
  isLocal(ref)
    ? `# ${title ?? ref.name}\n\nOn this machine only. \`underlay publish ${ref.name} <server>/<org>/${ref.name}\` sends it to a server.\n`
    : `# ${title ?? ref.name}\n\nNew: not on ${ref.authority} yet. Its first push creates it there.\n`

/**
 * Start a collection. A name alone makes one on this machine only; `org/name` or
 * `authority/org/name` makes one that is not on its authority yet, which its first push creates.
 */
export function newCollection(
  ctx: Ctx,
  text: string,
  opts: { access?: 'public' | 'private'; title?: string } = {},
): CollectionMeta {
  const ref = parseRef(text, ctx.settings.defaultRemote)
  if (ctx.home.readCollection(ref)) throw new CliError(`${keyOf(ref)} is here already`)
  const bad = nameProblem(ref.name, isLocal(ref) ? null : ref.authority)
  if (bad) throw new CliError(bad)
  const meta: CollectionMeta = {
    ...ref,
    id: crypto.randomUUID(),
    copies: [],
    keep: 'all',
    types: [],
    access: isLocal(ref) ? 'private' : (opts.access ?? 'private'),
    isNew: true,
    title: opts.title ?? null,
    pulled: null,
    pushed: null,
  }
  ctx.home.writeCollection(meta)
  writeFileSync(join(ctx.home.collectionDir(ref), 'README.md'), readmeOf(ref, meta.title))
  return meta
}

/**
 * Give a local collection a server: its folder moves under `authority/org/name` and it becomes
 * new there, so its first push creates it with the versions made here, unchanged (they are
 * stored by the collection's id, which stays). Nothing is sent: push does that.
 */
export function publish(
  ctx: Ctx,
  meta: CollectionMeta,
  text: string,
  opts: { access?: 'public' | 'private'; title?: string } = {},
): CollectionMeta {
  if (!isLocal(meta)) throw new CliError(`${keyOf(meta)} is on ${meta.authority} already`)
  const ref = parseRef(text, ctx.settings.defaultRemote)
  if (isLocal(ref))
    throw new CliError(`Publish to a server: org/${ref.name} or <server>/<org>/${ref.name}`)
  const bad = nameProblem(ref.name, ref.authority)
  if (bad) throw new CliError(bad)
  if (ctx.home.readCollection(ref)) throw new CliError(`${keyOf(ref)} is here already`)
  const from = ruleFor(ctx.settings, keyOf(meta)).path
  const to = ruleFor(ctx.settings, keyOf(ref)).path
  if (from !== to)
    throw new CliError(
      `A store rule keeps ${keyOf(ref)} in ${to}, and ${meta.name}'s versions are in ${from}: change the rule first`,
    )
  const oldDir = ctx.home.collectionDir(meta)
  const newDir = ctx.home.collectionDir(ref)
  mkdirSync(dirname(newDir), { recursive: true })
  renameSync(oldDir, newDir)
  const title = opts.title ?? meta.title
  const next: CollectionMeta = {
    ...meta,
    ...ref,
    access: opts.access ?? meta.access,
    title,
    isNew: true,
  }
  ctx.home.writeCollection(next)
  // The README says where it is: rewritten unless it was edited.
  const readme = join(newDir, 'README.md')
  if (!existsSync(readme) || readFileSync(readme, 'utf8') === readmeOf(meta, meta.title))
    writeFileSync(readme, readmeOf(ref, title))
  return next
}

/** Keep all of a collection here (or only some types), fetching what is missing. */
export async function keep(ctx: Ctx, c: Coll, types?: string[]): Promise<number> {
  return (await setKeep(ctx, c, types?.length ? 'some' : 'all', types ?? [])).fetched
}

export interface KeepResult {
  /** Record files and assets fetched. */
  fetched: number
  /** Record files and assets let go. */
  letGo: number
}

/**
 * Keep a collection here at a level: everything, records without assets, some types' records, or
 * metadata only. Fetches what the level wants that is missing, and lets go of what it doesn't
 * (never what a version not yet pushed needs, or another collection here keeps).
 */
export async function setKeep(
  ctx: Ctx,
  c: Coll,
  level: Keep,
  types: string[] = [],
): Promise<KeepResult> {
  if (level === 'none') {
    const records = await forget(ctx, c)
    return {
      fetched: 0,
      letGo: records + (await forgetAssets(ctx, openColl(ctx, ctx.home.collection(c.meta)))),
    }
  }
  const meta: CollectionMeta = { ...c.meta, keep: level, types: level === 'some' ? types : [] }
  ctx.home.writeCollection(meta)
  const now = openColl(ctx, meta)
  const fetched = (await fetchKept(now)) + (await fetchAssets(now))
  const letGo = level === 'all' ? 0 : await forgetAssets(ctx, now)
  return { fetched, letGo }
}

/** What letting a collection go down to a level would remove here, for the question first. */
export async function wouldLetGo(
  c: Coll,
  level: Keep,
): Promise<{ records: number; recordBytes: number; assets: number; assetBytes: number }> {
  const out = { records: 0, recordBytes: 0, assets: 0, assetBytes: 0 }
  if (level === 'all' || (await v3.headNumber(c.store.fs, cidOf(c))) === 0) return out
  for (const a of await assetsHere(c, await listAssets(c))) {
    out.assets++
    out.assetBytes += a.size
  }
  if (level === 'none')
    for (const f of (await viewOf(c)).files) {
      const h = await c.store.fs.head(v3.recordKey(f.id))
      if (!h) continue
      out.records++
      out.recordBytes += h.size
    }
  return out
}

/** Keep only a collection's metadata here: its record files go, unless something else names them. */
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
