/**
 * Pull and push (local-tool-build.md phase 4, on phase 0's routes).
 *
 * Pull follows the authority's log: its new commits go into the store's log as they are,
 * with their receipts, and any versions not yet pushed are built again on top of them
 * (renumbered, with new ids, their change ids kept). Then the record files and assets of what
 * is kept.
 *
 * Push sends the assets its versions name first, then copies each version not yet pushed to
 * the authority, in order, unchanged: its record files through an upload, then the commit as built here. The authority stores it as it is, so
 * the version has the same id there, and signs a receipt. If someone pushed first, the
 * authority refuses with its newest version: pull, replay, renumber, and say so.
 */
import { createObject, jcs, v3 } from '@underlay/protocol'

import { fetchAssets, sendAssets, unpushedAssets } from './assets.js'
import type { Coll, Ctx } from './context.js'
import { CliError } from './env.js'
import { isLocal } from './home.js'
import { RemoteError } from './remote.js'
import { cidOf, headOf, logOf, replayOnto, schemasAt, unpushedOf, viewOf } from './versions.js'

const enc = new TextEncoder()

export interface PullResult {
  /** Assets fetched, for a collection that keeps everything. */
  assets?: number
  fetched: number
  replayed: { from: v3.StoredCommit; to: v3.StoredCommit }[]
  files: number
  schemas: string[]
}

/** A file going up in a push or coming down in a pull, for whatever shows progress. */
export interface FileProgress {
  key: string
  authority: string
  direction: 'up' | 'down'
  /** The version being pushed; null for a pull, and for assets. */
  semver: string | null
  /** Assets (PDFs, images) rather than record files. */
  assets?: boolean
  done: number
  total: number
}
export type OnFile = (p: FileProgress) => void

/** Follow the authority's log, replay what is not pushed on top, and fetch what is kept. */
export async function pull(
  ctx: Ctx,
  c: Coll,
  now = ctx.env.now(),
  onFile?: OnFile,
): Promise<PullResult> {
  const result: PullResult = { fetched: 0, replayed: [], files: 0, schemas: [] }
  if (c.meta.isNew) return result
  const cid = cidOf(c)
  const fs = c.store.fs
  const remote = c.remote()
  const state = c.store.state(cid)
  const known = state.remote?.number ?? 0
  const page = await remote.commitsAfter(c.meta.org, c.meta.name, known)
  if (page.collection.id !== cid)
    throw new CliError(
      `${c.key} is now another collection on ${c.meta.authority} (id ${page.collection.id}, not ${cid})`,
    )
  if (page.collection.authority !== c.meta.authority)
    ctx.say(`${c.key}: its authority is now ${page.collection.authority}`)
  if (page.head < known)
    throw new CliError(
      `${c.key}: ${c.meta.authority} has ${page.head} versions, fewer than the ${known} pulled`,
    )

  if (known > 0 && state.remote) await followRewrite(ctx, c, state.remote, now)

  // Each new commit is what its id says, and follows the one before.
  let previous = c.store.state(cid).remote?.id ?? null
  const incoming: { stored: v3.StoredCommit; receipt: v3.Receipt | null }[] = []
  for (const [i, e] of page.commits.entries()) {
    const bytes = enc.encode(e.commit)
    const stored = { commit: v3.parseCommit(bytes), id: v3.versionId(bytes), bytes }
    // Ids compare by hash.
    if (!v3.sameVersion(stored.id, e.id))
      throw new CliError(`${c.key}: commit ${e.number} is not what its id says`)
    const follows =
      previous === null
        ? stored.commit.previous === null
        : v3.sameVersion(stored.commit.previous, previous)
    if (stored.commit.number !== known + 1 + i || !follows)
      throw new CliError(`${c.key}: commit ${e.number} does not follow the one pulled before it`)
    if (
      e.receipt &&
      (!v3.sameVersion(e.receipt.version, stored.id) || e.receipt.number !== stored.commit.number)
    )
      throw new CliError(`${c.key}: commit ${e.number}'s receipt is for another version`)
    incoming.push({ stored, receipt: e.receipt })
    previous = stored.id
  }

  const oldView = await viewOf(c, known === 0 ? undefined : known).catch(() => null)
  const oldSchemas = known > 0 && oldView ? await schemasAt(c.data, oldView) : {}
  if (incoming.length > 0) {
    // Versions here the authority now has (a push whose answer was lost) are pushed already.
    let unpushed = await unpushedOf(c)
    let same = 0
    while (
      same < unpushed.length &&
      same < incoming.length &&
      unpushed[same]!.id === incoming[same]!.stored.id
    )
      same++
    unpushed = unpushed.slice(same)
    for (const s of await unpushedOf(c)) {
      await fs.delete(v3.commitKey(cid, s.commit.number))
      await fs.delete(v3.receiptKey(cid, s.commit.number))
    }
    for (const { stored, receipt } of incoming) {
      await createObject(fs, v3.commitKey(cid, stored.commit.number), stored.bytes)
      if (receipt) await v3.writeReceipt(fs, receipt)
    }
    const last = incoming.at(-1)!.stored
    await v3.writeCommitHint(fs, cid, last.commit.number)
    const s = c.store.state(cid)
    s.remote = { number: last.commit.number, id: last.id, semver: last.commit.semver }
    c.store.setState(cid, s)
    result.fetched = incoming.length
    if (unpushed.length > 0) result.replayed = await replayOnto(c, unpushed, last, now)
  }

  // The authority's current layout, so a version reads from its rebuilt files.
  const layout = await remote.layout(c.meta.org, c.meta.name)
  if (layout && !(await fs.head(v3.layoutKey(cid, layout.number)))) {
    await createObject(fs, v3.layoutKey(cid, layout.number), JSON.stringify(layout))
    await v3.writeLayoutHint(fs, cid, layout.number)
  }

  result.files = await fetchKept(c, onFile)
  result.assets = await fetchAssets(c, onFile)
  // Schemas the authority changed come into home; others are left as edited here.
  if (incoming.length > 0) {
    const view = await viewOf(c, c.store.state(cid).remote!.number)
    const now2 = await schemasAt(c.data, view)
    const here = ctx.home.schemas(c.meta)
    const changed: Record<string, unknown> = {}
    for (const [t, body] of Object.entries(now2)) {
      if (JSON.stringify(oldSchemas[t]) === JSON.stringify(body)) continue
      if (
        here[t] !== undefined &&
        oldSchemas[t] !== undefined &&
        JSON.stringify(here[t]) !== JSON.stringify(oldSchemas[t])
      )
        ctx.say(
          `${c.key}: schemas/${t}.json was edited here and changed on ${c.meta.authority}; theirs is kept`,
        )
      changed[t] = body
    }
    ctx.home.writeSchemas(c.meta, changed)
    result.schemas = Object.keys(changed)
  }
  ctx.home.writeCollection({ ...c.meta, pulled: now.toISOString() })
  return result
}

/**
 * When the authority rewrote its history into the protocol's one spelling (docs/protocol/v3.md
 * Appendix D: `ulv3:` ids and `$file` references, 2026-11), every commit from the first it
 * changed has a new id, and the one last pulled here no longer follows. The authority still
 * answers to the old id (a version's former id); when it names the same version, the pulled
 * commits are replaced with the authority's, notes move to the new ids, and versions not yet
 * pushed are built again on top. Anything else is a history that differs, and is refused.
 */
async function followRewrite(
  ctx: Ctx,
  c: Coll,
  was: { number: number; id: string; semver: string },
  now: Date,
): Promise<void> {
  const cid = cidOf(c)
  const fs = c.store.fs
  const remote = c.remote()
  const theirs = await remote.commit(c.meta.org, c.meta.name, was.number)
  if (v3.sameVersion(theirs.id, was.id)) return
  const formerly = await remote.version(c.meta.org, c.meta.name, was.id)
  if (formerly?.semver !== was.semver)
    throw new CliError(
      `${c.key}: ${c.meta.authority}'s version ${was.number} is not the one pulled here. To start again from theirs: underlay remove ${c.key}, then add it again`,
    )

  // Versions made here and not pushed: kept, to build again on top.
  let unpushed: v3.StoredCommit[]
  try {
    unpushed = await unpushedOf(c)
  } catch {
    throw new CliError(
      `${c.key}: ${c.meta.authority} rewrote its history, and the versions not pushed here were saved by an older CLI. Undo them (underlay undo), pull, and save them again`,
    )
  }

  // The authority's commits, from the first, in place of the ones pulled.
  const page = await remote.commitsAfter(c.meta.org, c.meta.name, 0)
  const s = c.store.state(cid)
  let previous: string | null = null
  let last: v3.StoredCommit | null = null
  for (const e of page.commits) {
    if (e.number > was.number) break
    const bytes = enc.encode(e.commit)
    const stored = { commit: v3.parseCommit(bytes), id: v3.versionId(bytes), bytes }
    if (!v3.sameVersion(stored.id, e.id) || stored.commit.number !== e.number)
      throw new CliError(`${c.key}: commit ${e.number} is not what its id says`)
    const follows =
      previous === null
        ? stored.commit.previous === null
        : v3.sameVersion(stored.commit.previous, previous)
    if (!follows) throw new CliError(`${c.key}: commit ${e.number} does not follow the one before`)
    const key = v3.commitKey(cid, e.number)
    const mine = await fs.get(key)
    if (mine) {
      const oldId = v3.versionId(await mine.bytes())
      if (oldId !== stored.id && s.versions[oldId]) {
        s.versions[stored.id] = s.versions[oldId]!
        delete s.versions[oldId]
      }
    }
    await fs.put(key, bytes)
    if (e.receipt) await fs.put(v3.receiptKey(cid, e.number), jcs(e.receipt))
    previous = stored.id
    last = stored
  }
  if (!last || last.commit.number !== was.number)
    throw new CliError(`${c.key}: ${c.meta.authority} did not send its first ${was.number} commits`)
  s.remote = { number: last.commit.number, id: last.id, semver: last.commit.semver }
  c.store.setState(cid, s)
  if (unpushed.length > 0) {
    for (const u of unpushed) {
      await fs.delete(v3.commitKey(cid, u.commit.number))
      await fs.delete(v3.receiptKey(cid, u.commit.number))
    }
    await replayOnto(c, unpushed, last, now)
  }
  await v3.writeCommitHint(fs, cid, was.number + unpushed.length)
  ctx.say(
    `${c.key}: ${c.meta.authority} rewrote its history (new version ids, \`$asset\` for \`$file\`); pulled it again`,
  )
}

/** Fetch the record files of the newest version that the collection keeps; how many were fetched. */
export async function fetchKept(c: Coll, onFile?: OnFile): Promise<number> {
  if (c.meta.keep === 'none' || c.meta.isNew) return 0
  if ((await v3.headNumber(c.store.fs, cidOf(c))) === 0) return 0
  const view = await viewOf(c)
  const need: string[] = []
  for (const f of view.files) {
    if (c.meta.keep === 'some') {
      const types = c.meta.types
      const holds = types.some(
        (t) =>
          f.first &&
          f.last &&
          v3.compareKeys(f.first[0], '', t, '') <= 0 &&
          v3.compareKeys(t, '', f.last[0], '\u{10FFFF}') <= 0,
      )
      if (!holds) continue
    }
    if (await c.store.fs.head(v3.recordKey(f.id))) continue
    need.push(f.id)
  }
  const tell = (done: number) =>
    onFile?.({
      key: c.key,
      authority: c.meta.authority,
      direction: 'down',
      semver: null,
      done,
      total: need.length,
    })
  if (need.length) tell(0)
  let n = 0
  for (const id of need) {
    await c.data.head(v3.recordKey(id))
    tell(++n)
  }
  return n
}

export interface PushVersion {
  number: number
  semver: string
  id: string
  message: string | null
  stats: { added: number; changed: number; removed: number } | null
}

export interface PushPlan {
  coll: Coll
  access: 'public' | 'private'
  isNew: boolean
  /** The authority's newest before the push. */
  from: { number: number; semver: string } | null
  versions: PushVersion[]
  removed: number
  /** Assets its versions name that the authority's newest doesn't: sent first. */
  assets: number
}

/** What a push would copy, for the confirmation. None for a local collection: it has no server. */
export async function pushPlan(c: Coll): Promise<PushPlan | null> {
  if (isLocal(c.meta)) return null
  const list = await unpushedOf(c)
  if (list.length === 0) return null
  const state = c.store.state(cidOf(c))
  const versions = list.map((s) => {
    const note = state.versions[s.id]
    return {
      number: s.commit.number,
      semver: s.commit.semver,
      id: s.id,
      message: s.commit.changes[0]!.message,
      stats: note?.stats ?? null,
    }
  })
  return {
    coll: c,
    access: c.meta.access,
    isNew: c.meta.isNew,
    from: state.remote ? { number: state.remote.number, semver: state.remote.semver } : null,
    versions,
    removed: versions.reduce((n, v) => n + (v.stats?.removed ?? 0), 0),
    assets: (await unpushedAssets(c)).length,
  }
}

/** Removals past this in one push need `push` typed, as a public collection does. */
export const MANY_REMOVALS = 1000

export const isLoud = (p: PushPlan) => p.access === 'public' || p.removed >= MANY_REMOVALS

export class StaleError extends CliError {
  constructor(
    readonly key: string,
    readonly replayed: { from: v3.StoredCommit; to: v3.StoredCommit }[],
  ) {
    super(
      `${key}: someone pushed first. Pulled their versions and replayed yours on top:\n` +
        replayed
          .map(
            (r) =>
              `  ${r.from.commit.semver} (${r.from.commit.number}) → ${r.to.commit.semver} (${r.to.commit.number})`,
          )
          .join('\n') +
        '\nLook them over, then push again.',
    )
    this.name = 'StaleError'
  }
}

/** Copy a collection's versions not yet pushed to its authority, in order. */
export async function push(
  ctx: Ctx,
  c: Coll,
  say = ctx.say,
  onFile?: OnFile,
): Promise<v3.StoredCommit[]> {
  const cid = cidOf(c)
  const remote = c.remote()
  const { org, name } = c.meta
  if (!remote.signedIn)
    throw new CliError(`Not signed in to ${c.meta.authority}: underlay login ${c.meta.authority}`)
  if (c.meta.isNew) {
    // Created with the id its commits carry, so they are taken as they are.
    try {
      await remote.createCollection(org, {
        slug: name,
        id: cid,
        public: c.meta.access === 'public',
        ...(c.meta.title ? { name: c.meta.title } : {}),
      })
      say(`Created ${c.key}`)
    } catch (err) {
      const there = await remote.collection(org, name).catch(() => null)
      if (!(err instanceof RemoteError && err.status === 409 && there?.id === cid)) throw err
    }
    ctx.home.writeCollection({ ...c.meta, isNew: false })
    c.meta.isNew = false
  }
  // Assets first: the authority takes a `$asset` row only for bytes already sent to it.
  const sentAssets = await sendAssets(c, onFile)
  if (sentAssets) say(`  sent ${sentAssets} asset${sentAssets === 1 ? '' : 's'}`)
  const pushed: v3.StoredCommit[] = []
  for (const s of await unpushedOf(c)) {
    const files = v3.commitFiles(s.commit)
    const change = s.commit.changes[0]!
    const up = await remote.openUpload(org, name, { message: change.message, base: change.base })
    const present = new Set((await remote.uploadStatus(org, name, up.upload_id)).present ?? [])
    const toSend = files.filter((f) => !present.has(f.id))
    const tell = (done: number) =>
      onFile?.({
        key: c.key,
        authority: c.meta.authority,
        direction: 'up',
        semver: s.commit.semver,
        done,
        total: toSend.length,
      })
    tell(0)
    let sent = 0
    for (const f of toSend) {
      const obj = await c.data.get(v3.recordKey(f.id))
      if (!obj)
        throw new CliError(
          `${c.key}: record file ${f.id} of version ${s.commit.number} is missing here`,
        )
      await remote.sendFile(org, name, up.upload_id, f.id, await obj.bytes())
      tell(++sent)
    }
    say(`  ${s.commit.semver}: sent ${sent} of ${files.length} record files; committing`)
    const st = await remote.commitUpload(org, name, up.upload_id, {
      record_files: files,
      commit: new TextDecoder().decode(s.bytes),
    })
    if (st.status === 'failed' && st.error?.statusCode === 409 && st.error.latest !== undefined) {
      const pulled = await pull(ctx, c)
      throw new StaleError(c.key, pulled.replayed)
    }
    if (st.status !== 'committed')
      throw new CliError(
        `${c.key} ${s.commit.semver}: ${st.status}: ${st.error?.error ?? ''}${st.error?.problems ? '\n  ' + st.error.problems.join('\n  ') : ''}`,
      )
    if (st.result?.hash !== s.id)
      throw new CliError(`${c.key}: ${c.meta.authority} stored ${st.result?.hash}, not ${s.id}`)
    const entry = await remote.commit(org, name, s.commit.number)
    if (entry.receipt) await v3.writeReceipt(c.store.fs, entry.receipt)
    const state = c.store.state(cid)
    state.remote = { number: s.commit.number, id: s.id, semver: s.commit.semver }
    c.store.setState(cid, state)
    pushed.push(s)
    say(`  ${s.commit.semver} ✓ ${c.meta.authority}`)
  }
  ctx.home.writeCollection({ ...ctx.home.collection(c.meta), pushed: ctx.env.now().toISOString() })
  return pushed
}

/** Whether a collection's newest version here is ahead of, behind, or level with its authority. */
export async function remoteHead(c: Coll): Promise<number | null> {
  if (c.meta.isNew) return null
  const page = await c
    .remote()
    .json<{ head: number }>(
      `${c.remote().collectionPath(c.meta.org, c.meta.name)}/commits?after=0&limit=1`,
    )
  return page.head
}

export { headOf, logOf }
