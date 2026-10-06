/**
 * Moving versions between the local repository and a registry
 * (edge-redesign-build.md, "Tree sync").
 *
 * pull   verify the remote's signed log after what was last seen, then receive
 *        the newest version as a pack against the last one pulled or pushed
 *        (receiveVersion re-derives every tree before anything is accepted).
 * push   the local changes since the last sync, sent as a delta push (upserts
 *        and deletes) with the files they need; then the registry's new version
 *        must be the local one. Same hash, or (when the private salt differs)
 *        the same trees, checked by pulling it back.
 */
import {
  compareUtf8,
  type DiffEntry,
  diffTrees,
  fileTree,
  isPrivateSchema,
  keys,
  type PrivateSetObject,
  receiveVersion,
  type RecordEntry,
  recordTree,
  RepoSource,
  type SetObject,
  type SyncSets,
  verifyLogEntries,
} from '@underlay/protocol'

import { Client, type Fetch } from '../client.js'
import { CliError, Local, type LocalVersion, type Tracking } from '../local.js'
import { recordById, versionState, type VersionState } from '../state.js'
import type { Say } from './stage.js'

const BATCH_LINES = 5000
const BATCH_BYTES = 8 * 1024 * 1024
const SMALL_UPLOAD_BYTES = 32 * 1024 * 1024
const POLL_MS = 1000

export interface SyncOptions {
  fetch?: Fetch
  /** pull: replace local commits that weren't pushed. */
  force?: boolean
}

// --- pull ------------------------------------------------------------------------

export async function pull(
  local: Local,
  name: string,
  opts: SyncOptions,
  say: Say,
): Promise<LocalVersion | null> {
  const cfg = local.remote(name)
  const client = new Client(cfg, opts.fetch)
  const t = local.tracking(name)
  const page = await client.log(t?.seq ?? 0)
  if (!page.collection || page.entries.length === 0) {
    say(t ? 'Already up to date.' : 'The remote has no versions yet.')
    return null
  }
  const keys = page.collection.keys
  const verified = await verifyLogEntries(
    page.entries,
    keys,
    t && { seq: t.seq, entryHash: t.entryHash },
    page.collection.id,
  )
  const latest = page.entries[page.entries.length - 1]!
  const head = local.headVersion()
  if (head && head.hash !== t?.hash && !opts.force) {
    throw new CliError(
      t
        ? `${head.semver} isn't on ${name}; push it first, or pull --force to drop it.`
        : `This repository has versions that didn't come from ${name}; pull --force to replace them.`,
    )
  }
  const want: SyncSets = cfg.token ? 'all' : 'public'
  // The last version synced anchors the pack, if this repository holds the sets asked for.
  const base = t && (t.sets === 'all' || want === 'public') ? t.hash : null
  const pack = await client.pack(latest.versionHash, base, want)
  const got = await receiveVersion(local.repo, pack.objects, {
    target: latest.versionHash,
    base,
    sets: pack.sets,
  })
  if (pack.sets === 'all' && got.root.private) {
    local.setSalt((await local.repo.privateSet(got.root.private)).salt)
  }
  const version: LocalVersion = {
    semver: latest.semver,
    hash: latest.versionHash,
    baseSemver: latest.baseSemver,
    message: latest.message,
    createdAt: latest.createdAt,
    refs: null,
    remote: name,
    sets: pack.sets,
  }
  local.writeVersion(version)
  local.setHead(version.semver)
  local.setTracking(name, {
    seq: latest.seq,
    entryHash: verified!.entryHash,
    semver: latest.semver,
    hash: latest.versionHash,
    sets: pack.sets,
    keys,
  })
  const c = got.changes
  say(`Pulled ${latest.semver} from ${name}: +${c.added} ~${c.updated} -${c.removed} record(s)`)
  return version
}

/** `underlay clone <url> <owner/slug> [dir]`: init, add the remote as origin, pull. */
export async function clone(
  url: string,
  collection: string,
  dir: string,
  opts: SyncOptions & { token?: string },
  say: Say,
): Promise<Local> {
  const local = Local.init(dir)
  local.setRemotes({
    origin: { url, collection, ...(opts.token ? { token: opts.token } : {}) },
  })
  await pull(local, 'origin', opts, say)
  return local
}

// --- push ------------------------------------------------------------------------

type Op = { put: string } | { del: string }

/** A record's push line: its canonical form, plus the private flag where it matters. */
function putLine(r: RecordEntry, isPrivate: boolean): string {
  return isPrivate ? `${r.body!.slice(0, -1)},"private":true}` : r.body!
}

/**
 * The upserts and deletes that turn `base` into `head`, per type in key order:
 * a record present in head is sent with the set it's in; one gone from both
 * sets is deleted.
 */
async function* changesToPush(
  local: Local,
  base: VersionState | null,
  head: VersionState,
): AsyncGenerator<Op> {
  const repo = local.repo
  const source = new RepoSource(recordTree, repo)
  for (const [slug, schema] of Object.entries(head.schemas)) {
    const privateType = isPrivateSchema(schema)
    const pubDiff = diffTrees(
      source,
      base?.public.types[slug]?.root ?? null,
      head.public.types[slug]?.root ?? null,
    )[Symbol.asyncIterator]()
    const privDiff = diffTrees(
      source,
      base?.private.types[slug]?.root ?? null,
      head.private.types[slug]?.root ?? null,
    )[Symbol.asyncIterator]()
    let a = await pubDiff.next()
    let b = await privDiff.next()
    while (!a.done || !b.done) {
      const ka = a.done ? null : a.value.key
      const kb = b.done ? null : b.value.key
      const key = ka === null ? kb! : kb === null ? ka : compareUtf8(ka, kb) <= 0 ? ka : kb
      const pd: DiffEntry<RecordEntry> | null = ka === key ? a.value! : null
      const vd: DiffEntry<RecordEntry> | null = kb === key ? b.value! : null
      if (pd) a = await pubDiff.next()
      if (vd) b = await privDiff.next()
      if (pd?.after) {
        const r = await recordById(repo, head.public.types[slug]!.root, key)
        yield { put: putLine(r!, false) }
      } else if (vd?.after) {
        const r = await recordById(repo, head.private.types[slug]!.root, key)
        yield { put: putLine(r!, !privateType) }
      } else {
        yield { del: JSON.stringify({ type: slug, id: key }) }
      }
    }
  }
}

/** Files the head's sets have that the base's don't, which the registry may lack. */
async function newFiles(local: Local, base: VersionState | null, head: VersionState) {
  const out = new Map<string, number>()
  const source = new RepoSource(fileTree, local.repo)
  const pairs: [SetObject | null, SetObject][] = [
    [base?.public ?? null, head.public],
    [base?.private ?? null, head.private],
  ]
  for (const [b, h] of pairs) {
    for await (const d of diffTrees(source, b?.files.root ?? null, h.files.root)) {
      if (d.after) out.set(d.key, d.after.size)
    }
  }
  return out
}

async function uploadFiles(local: Local, client: Client, files: Map<string, number>, say: Say) {
  for (const [hash, size] of files) {
    const obj = await local.repo.blobs.get(keys.file(hash))
    if (!obj)
      throw new CliError(`File ${hash} isn't in this repository; add it with \`underlay file add\``)
    if (size <= SMALL_UPLOAD_BYTES) {
      const res = await client.request(`/files/${hash}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: (await obj.bytes()) as BodyInit,
      })
      if (!res.ok) throw new CliError(`Uploading file ${hash}: ${res.status}`)
      continue
    }
    // Large: a direct upload to storage, then wait for the registry to verify it.
    type Part = { partNumber: number; url: string }
    const ticket = await client.post<{
      id: string
      url?: string
      partBytes?: number
      partCount?: number
      parts?: Part[]
    }>('/files/uploads', { hash, size })
    const fetchRaw = client.fetchImpl
    const parts: { partNumber: number; etag: string }[] = []
    if (ticket.url) {
      const res = await fetchRaw(ticket.url, {
        method: 'PUT',
        body: (await obj.bytes()) as BodyInit,
      })
      if (!res.ok) throw new CliError(`Uploading file ${hash}: ${res.status}`)
    } else {
      const partBytes = ticket.partBytes ?? Math.ceil(size / ticket.parts!.length)
      const partCount = ticket.partCount ?? ticket.parts!.length
      // The ticket presigns the first page of parts; the rest come a page at a time.
      let page = ticket.parts!
      for (let n = 1; n <= partCount; n++) {
        if (!page.some((x) => x.partNumber === n)) {
          page = (
            await client.json<{ parts: Part[] }>(`/files/uploads/${ticket.id}/parts?from=${n}`)
          ).parts
        }
        const p = page.find((x) => x.partNumber === n)
        if (!p) throw new CliError(`No upload URL for part ${n} of ${hash}`)
        const offset = (p.partNumber - 1) * partBytes
        const chunk = await local.repo.blobs.get(keys.file(hash), { offset, length: partBytes })
        const res = await fetchRaw(p.url, {
          method: 'PUT',
          body: (await chunk!.bytes()) as BodyInit,
        })
        if (!res.ok) throw new CliError(`Uploading part ${p.partNumber} of ${hash}: ${res.status}`)
        parts.push({ partNumber: p.partNumber, etag: res.headers.get('etag') ?? '' })
      }
    }
    await client.post(`/files/uploads/${ticket.id}/complete`, parts.length > 0 ? { parts } : {})
    for (;;) {
      const s = await client.json<{ status: string; error?: string }>(`/files/uploads/${ticket.id}`)
      if (s.status === 'verified') break
      if (s.status === 'failed')
        throw new CliError(`File ${hash} failed verification: ${s.error ?? ''}`)
      await new Promise((r) => setTimeout(r, POLL_MS))
    }
  }
  if (files.size > 0) say(`Uploaded ${files.size} file(s)`)
}

/** Send ops in batches under the registry's request limits. */
async function sendOps(client: Client, sid: string, ops: AsyncIterable<Op>) {
  const pending = { put: [] as string[], del: [] as string[] }
  const bytes = { put: 0, del: 0 }
  const counts = { put: 0, del: 0 }
  const flush = async (kind: 'put' | 'del') => {
    if (pending[kind].length === 0) return
    await client.postNdjson(`/push/${sid}/${kind === 'put' ? 'records' : 'deletes'}`, pending[kind])
    counts[kind] += pending[kind].length
    pending[kind] = []
    bytes[kind] = 0
  }
  for await (const op of ops) {
    const kind = 'put' in op ? 'put' : 'del'
    const line = 'put' in op ? op.put : op.del
    pending[kind].push(line)
    bytes[kind] += line.length + 1
    if (pending[kind].length >= BATCH_LINES || bytes[kind] >= BATCH_BYTES) await flush(kind)
  }
  await flush('put')
  await flush('del')
  return counts
}

/** Same records, files and metadata: what a push must reproduce. */
function sameContent(a: VersionState, b: VersionState, sets: SyncSets): boolean {
  const pick = (s: VersionState) => ({
    metadata: s.root.metadata,
    public: s.public,
    private: sets === 'all' ? { types: s.private.types, files: s.private.files } : null,
  })
  return JSON.stringify(pick(a)) === JSON.stringify(pick(b))
}

export async function push(
  local: Local,
  name: string,
  opts: SyncOptions,
  say: Say,
): Promise<LocalVersion | null> {
  const cfg = local.remote(name)
  const client = new Client(cfg, opts.fetch)
  const head = local.headVersion()
  if (!head) throw new CliError('Nothing to push: commit something first.')
  const t: Tracking | null = local.tracking(name)
  if (t && head.hash === t.hash) {
    say('Everything up to date.')
    return head
  }
  const remote = await client.log(t?.seq ?? 0)
  if (remote.entries.length > 0) {
    throw new CliError(`${name} has versions this repository hasn't pulled. Pull first.`)
  }
  const tracked = t ? local.version(t.semver) : null
  const baseState = tracked ? await versionState(local, tracked) : null
  const headState = await versionState(local, head)
  const sets: SyncSets = t?.sets ?? 'all'

  await uploadFiles(local, client, await newFiles(local, baseState, headState), say)
  const session = await client.post<{ session_id: string }>('/push', {
    base: t?.semver ?? null,
    schemas: headState.schemas,
    metadata: headState.root.metadata,
    message: head.message,
  })
  const sid = session.session_id
  const sent = await sendOps(client, sid, changesToPush(local, baseState, headState))

  const res = await client.request(`/push/${sid}/commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  let result = (await res.json()) as { semver?: string; hash?: string; error?: string }
  if (res.status === 202) {
    for (;;) {
      await new Promise((r) => setTimeout(r, POLL_MS))
      const s = await client.json<{
        status: string
        result: { semver: string; hash: string } | null
        error: { error?: string } | null
      }>(`/push/${sid}`)
      if (s.status === 'committed') {
        result = s.result!
        break
      }
      if (s.status !== 'committing')
        throw new CliError(`Push failed: ${s.error?.error ?? s.status}`)
    }
  } else if (res.status !== 201) {
    throw new CliError(`Push failed: ${res.status} ${result.error ?? ''}`)
  }

  // The registry's log now ends with the new version.
  const after = await client.log(t?.seq ?? 0)
  const verified = await verifyLogEntries(
    after.entries,
    after.collection!.keys,
    t && { seq: t.seq, entryHash: t.entryHash },
    after.collection!.id,
  )
  const entry = after.entries[after.entries.length - 1]
  if (!entry || entry.versionHash !== result.hash) {
    throw new CliError('The registry committed, but its log does not end with the new version')
  }
  if (result.hash !== head.hash) {
    // Typically the private salt: the registry's differs from a local one. Pull
    // its version back and compare content, not hashes.
    const pack = await client.pack(result.hash!, t?.hash ?? null, sets)
    const got = await receiveVersion(local.repo, pack.objects, {
      target: result.hash!,
      base: t?.hash ?? null,
      sets: pack.sets,
    })
    const theirs = await versionState(local, {
      ...head,
      hash: result.hash!,
      sets: pack.sets,
    })
    if (!sameContent(theirs, headState, pack.sets)) {
      throw new CliError(
        `${name} built ${result.semver} (${result.hash}) with different content from ${head.semver}`,
      )
    }
    if (got.root.private && pack.sets === 'all') {
      local.setSalt(((await local.repo.privateSet(got.root.private)) as PrivateSetObject).salt)
    }
  }
  const version: LocalVersion = {
    semver: result.semver!,
    hash: result.hash!,
    baseSemver: t?.semver ?? null,
    message: head.message,
    createdAt: entry.createdAt,
    refs: result.hash === head.hash ? head.refs : null,
    remote: name,
    sets,
  }
  local.writeVersion(version)
  local.setHead(version.semver)
  local.setTracking(name, {
    seq: entry.seq,
    entryHash: verified!.entryHash,
    semver: version.semver,
    hash: version.hash,
    sets,
    keys: after.collection!.keys,
  })
  say(`Pushed ${version.semver} to ${name}: ${sent.put} upsert(s), ${sent.del} delete(s)`)
  return version
}
