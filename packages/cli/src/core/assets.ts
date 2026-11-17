/**
 * A collection's assets: the files its `$asset` rows name by SHA-256, such as PDFs and images.
 * They are kept here, at `assets/<sha256>` in the store as on a server, when a collection keeps
 * everything (keep = "all"), fetched from its authority. One added here is sent to the
 * authority before the push that names it, since a server takes a `$asset` row only for bytes
 * sent to that collection.
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'

import { v3 } from '@underlay/protocol'

import { type Coll, type Ctx, openColl } from './context.js'
import { CliError } from './env.js'
import { keyOf } from './home.js'
import type { OnFile } from './sync.js'
import { cidOf, unpushedOf, viewOf } from './versions.js'

export interface AssetRow {
  hash: string
  size: number
  mediaType: string | null
}

export const assetKey = (hash: string) => `assets/${hash}`

const dec = new TextDecoder()

/** The assets a version names (the newest when none is given). */
export async function listAssets(c: Coll, version?: number): Promise<AssetRow[]> {
  if ((await v3.headNumber(c.store.fs, cidOf(c))) === 0) return []
  const view = await viewOf(c, version)
  const out: AssetRow[] = []
  for await (const r of v3.exportAll(c.data, view, { type: v3.ASSET_TYPE })) {
    if (r.type !== v3.ASSET_TYPE) break
    if (!r.line) continue
    const d = (JSON.parse(dec.decode(r.line)) as { data: { size: number; mediaType?: string } })
      .data
    out.push({ hash: r.id, size: d.size, mediaType: d.mediaType ?? null })
  }
  return out
}

/** Which of these are here. */
export async function assetsHere(c: Coll, rows: AssetRow[]): Promise<AssetRow[]> {
  const here: AssetRow[] = []
  for (const a of rows) if (await c.store.fs.head(assetKey(a.hash))) here.push(a)
  return here
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

/** Fetch the newest version's assets that are not here; how many were fetched. */
export async function fetchAssets(c: Coll, onFile?: OnFile): Promise<number> {
  if (c.meta.keep !== 'all' || c.meta.isNew) return 0
  const listed = await listAssets(c)
  const here = new Set((await assetsHere(c, listed)).map((a) => a.hash))
  const need = listed.filter((a) => !here.has(a.hash))
  if (!need.length) return 0
  const remote = c.remote()
  const urls = await remote.assetUrls(
    c.meta.org,
    c.meta.name,
    need.map((a) => a.hash),
  )
  const tell = (done: number) =>
    onFile?.({
      key: c.key,
      authority: c.meta.authority,
      direction: 'down',
      semver: null,
      done,
      total: need.length,
    })
  tell(0)
  let n = 0
  for (const a of need) {
    const url = urls.get(a.hash)
    if (!url)
      throw new CliError(`${c.key}: ${c.meta.authority} has no asset ${a.hash.slice(0, 12)}`)
    const bytes = await remote.fetchAsset(url)
    if (sha256(bytes) !== a.hash)
      throw new CliError(`${c.key}: asset ${a.hash.slice(0, 12)} came back with other bytes`)
    await c.store.fs.put(assetKey(a.hash), bytes, { ifAbsent: true })
    tell(++n)
  }
  return n
}

/**
 * The assets versions not yet pushed name that the authority's newest doesn't: these can't be
 * fetched again, and are sent before the push.
 */
export async function unpushedAssets(c: Coll): Promise<AssetRow[]> {
  if (!(await unpushedOf(c)).length) return []
  const there = c.store.state(cidOf(c)).remote?.number
  const before = new Set(there ? (await listAssets(c, there)).map((a) => a.hash) : [])
  return (await listAssets(c)).filter((a) => !before.has(a.hash))
}

/** Send the assets a push will name that the authority doesn't hold yet; how many were sent. */
export async function sendAssets(c: Coll, onFile?: OnFile): Promise<number> {
  const rows = await unpushedAssets(c)
  if (!rows.length) return 0
  const remote = c.remote()
  const { org, name } = c.meta
  const send: AssetRow[] = []
  for (const a of rows)
    if (c.meta.isNew || !(await remote.hasAsset(org, name, a.hash))) send.push(a)
  let n = 0
  for (const a of send) {
    onFile?.({
      key: c.key,
      authority: c.meta.authority,
      direction: 'up',
      semver: 'assets',
      done: n,
      total: send.length,
    })
    const obj = await c.store.fs.get(assetKey(a.hash))
    if (!obj)
      throw new CliError(
        `${c.key}: asset ${a.hash.slice(0, 12)} is named by a version not yet pushed, but its bytes are not here`,
      )
    await remote.sendAsset(org, name, a.hash, await obj.bytes(), a.mediaType)
    n++
  }
  return n
}

/**
 * Let go of a collection's assets here, but not ones a version not yet pushed names (they
 * can't be fetched again) or another collection in the same store keeps.
 */
export async function forgetAssets(ctx: Ctx, c: Coll): Promise<number> {
  const listed = await listAssets(c)
  if (!listed.length) return 0
  const needed = new Set((await unpushedAssets(c)).map((a) => a.hash))
  for (const other of ctx.home.collections()) {
    if (other.keep !== 'all' || keyOf(other) === c.key) continue
    const o = openColl(ctx, other)
    if (o.store.root !== c.store.root) continue
    for (const a of await listAssets(o)) needed.add(a.hash)
  }
  let n = 0
  for (const a of listed) {
    if (needed.has(a.hash) || !(await c.store.fs.head(assetKey(a.hash)))) continue
    await c.store.fs.delete(assetKey(a.hash))
    n++
  }
  return n
}

const MEDIA: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
}

/** Store files here as assets, by their SHA-256: the rows a version adds to name them. */
export async function storeAssets(
  c: Coll,
  paths: string[],
): Promise<(AssetRow & { from: string })[]> {
  const out: (AssetRow & { from: string })[] = []
  for (const p of paths) {
    if (!statSync(p).isFile()) throw new CliError(`${p} is not a file`)
    const bytes = new Uint8Array(readFileSync(p))
    const hash = sha256(bytes)
    await c.store.fs.put(assetKey(hash), bytes, { ifAbsent: true })
    out.push({
      hash,
      size: bytes.byteLength,
      mediaType: MEDIA[extname(p).toLowerCase()] ?? null,
      from: basename(p),
    })
  }
  return out
}

/** A file's media type from its extension, where it is a common one. */
export const mediaOf = (path: string) => MEDIA[extname(path).toLowerCase()] ?? null

/**
 * The files a record points to: any object in its data, at any depth, whose `$file` is
 * `sha256:<64 lowercase hex>` (the protocol's file reference), with the field it sits under.
 */
const FILE_REF = /^sha256:([0-9a-f]{64})$/
export function fileRefsIn(data: unknown, field = ''): { hash: string; field: string }[] {
  const out: { hash: string; field: string }[] = []
  const walk = (v: unknown, at: string) => {
    if (v === null || typeof v !== 'object') return
    if (Array.isArray(v)) return v.forEach((x) => walk(x, at))
    const o = v as Record<string, unknown>
    const m = typeof o.$file === 'string' ? FILE_REF.exec(o.$file) : null
    if (m) return void out.push({ hash: m[1]!, field: at })
    for (const k in o) walk(o[k], at ? `${at}.${k}` : k)
  }
  walk(data, field)
  return out
}

/** The files a run wrote into `$UNDERLAY_OUT/files/` (any names, any folders), by SHA-256. */
export function runFiles(
  dir: string,
): Map<string, { path: string; size: number; mediaType: string | null }> {
  const out = new Map<string, { path: string; size: number; mediaType: string | null }>()
  const walk = (d: string) => {
    if (!existsSync(d)) return
    for (const n of readdirSync(d)) {
      const abs = join(d, n)
      if (statSync(abs).isDirectory()) walk(abs)
      else {
        const bytes = readFileSync(abs)
        out.set(sha256(bytes), { path: abs, size: bytes.byteLength, mediaType: mediaOf(abs) })
      }
    }
  }
  walk(dir)
  return out
}
