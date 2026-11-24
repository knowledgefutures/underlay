/**
 * Links in record data, for the pages (docs/protocol.md, Section 5.2). The rule is
 * `@underlay/protocol`'s `links`; it is repeated here so the page bundle doesn't carry the
 * protocol package. An object with `$link: "ul:<kind>:<hex>"` is a link, with where it was
 * found in `collection`, `type`, and `id`. An asset reference, `{"$asset": "ul:asset:<hex>"}`,
 * attaches an asset of the record's collection and is read as a link to it.
 */

export type LinkKind = 'rec' | 'asset' | 'ver'

export interface DataLink {
  kind: LinkKind
  hash: string
  collection?: string
  type?: string
  id?: string
  /** Where it is in the record's data, as a JSON Pointer. */
  path: string
  /** An asset reference (`$asset`): an asset of the collection the record is in. */
  attached?: boolean
  /** An asset reference's `mediaType`: what the bytes are. */
  mediaType?: string
  /** An asset reference's `fileName`: what to save them as. */
  fileName?: string
}

/**
 * Where to download an attached asset: the collection's asset route, saved under the
 * reference's `fileName` when it gives one.
 */
export function assetDownloadUrl(owner: string, collection: string, link: DataLink): string {
  const base = `/api/collections/${owner}/${collection}/assets/${link.hash}`
  return link.fileName ? `${base}?${new URLSearchParams({ fileName: link.fileName })}` : base
}

const UL_ID = /^ul:(rec|asset|ver):([0-9a-f]{64})$/
const ASSET_ID = /^ul:asset:([0-9a-f]{64})$/

const pointer = (path: string, key: string | number) =>
  `${path}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`

/** A link object's target and where it was found, or null if the value is no link. */
export function asLink(v: unknown, path = ''): DataLink | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const m = typeof o.$link === 'string' ? UL_ID.exec(o.$link) : null
  if (m) {
    const link: DataLink = { kind: m[1] as LinkKind, hash: m[2]!, path }
    for (const k of ['collection', 'type', 'id'] as const)
      if (typeof o[k] === 'string') link[k] = o[k] as string
    return link
  }
  const a = typeof o.$asset === 'string' ? ASSET_ID.exec(o.$asset) : null
  if (!a) return null
  const ref: DataLink = { kind: 'asset', hash: a[1]!, path, attached: true }
  if (typeof o.mediaType === 'string' && o.mediaType.includes('/')) ref.mediaType = o.mediaType
  if (typeof o.fileName === 'string' && o.fileName.trim() && !/[/\\]/.test(o.fileName))
    ref.fileName = o.fileName.trim()
  return ref
}

/** Every link in a record's data, in document order. A link object is not searched further. */
export function linksIn(data: unknown): DataLink[] {
  const out: DataLink[] = []
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, pointer(path, i)))
    if (v === null || typeof v !== 'object') return
    const link = asLink(v, path)
    if (link) return void out.push(link)
    const o = v as Record<string, unknown>
    for (const k in o) walk(o[k], pointer(path, k))
  }
  walk(data, '')
  return out
}

export const ulId = (kind: LinkKind, hash: string) => `ul:${kind}:${hash}`

/** The `ul:` id with its hash cut to `n` digits, for display. */
export const shortUlId = (kind: LinkKind, hash: string, n = 12) => `ul:${kind}:${hash.slice(0, n)}…`

/**
 * Where to follow a link: the server's resolver, which redirects to the page or asset. An asset
 * reference and a link without a collection are looked for in `here`, the record's own
 * collection, when the target is an asset or version (they are found through a collection).
 */
export function linkUrl(link: DataLink, here?: string): string {
  const collection = link.collection ?? (link.kind === 'rec' ? undefined : here)
  const q = new URLSearchParams({ to: ulId(link.kind, link.hash) })
  if (collection) q.set('collection', collection)
  if (link.type) q.set('type', link.type)
  if (link.id) q.set('id', link.id)
  return `/api/links/resolve?${q}`
}

/** The `$link` object that points at a record, as a publisher writes it in another record. */
export function recordLinkObject(
  hash: string,
  place: { collection: string; type: string; id: string },
) {
  return { $link: ulId('rec', hash), collection: place.collection, type: place.type, id: place.id }
}
