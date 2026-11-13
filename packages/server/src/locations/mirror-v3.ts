/**
 * Bucket mirrors of v3 collections (v3-deploy-plan.md, decision 8). A v3 mirror is the
 * collection as docs/protocol-v3.md Section 8 defines it, at the keys Section 9 stores it
 * under: its description, its commits, its current layout, and the sorted-record-files and
 * assets those name. A reader with `@underlay/protocol` opens the bucket as it opens the
 * server's own store.
 *
 * Each job copies what the placement lacks, up to a byte budget, and queues the next:
 * record files first, then assets, then the description, commits and layout, and the
 * hints last, so a reader that follows the hints never finds a commit whose files are
 * missing. What was copied is remembered in the internal store, never found by reading
 * the bucket (a write-only mirror can't read). Nothing is deleted from the bucket: files a
 * rebuild replaced stay there.
 *
 * A v3 collection is public or private as a whole. A mirror of the public set (`sets`
 * `public`) copies a public collection and refuses a private one, so an organization's
 * default mirror to an open bucket never receives a private collection.
 */
import { putFromParts, readParts, type Store, v3 } from '@underlay/protocol'
import { eq } from 'drizzle-orm'

import * as schema from '../db/schema.js'
import type { Ports } from '../ports.js'
import { assetKey } from '../v3/rules.js'
import { mirrorConfig } from './mirror.js'

type Placement = typeof schema.placements.$inferSelect

export const PRIVATE_COLLECTION_ERROR =
  'This mirror copies public collections only, and this collection is private. Mirror it to a location that holds private data too.'

interface Copied {
  files: string[]
  assets: string[]
}

const copiedKey = (placementId: string) => `mirrors/${placementId}/v3.json`

async function readCopied(ports: Ports, placementId: string): Promise<Copied> {
  const saved = await ports.stores.internal.get(copiedKey(placementId))
  if (!saved) return { files: [], assets: [] }
  return JSON.parse(await saved.text()) as Copied
}

/** The stored object for a key, or the copy the sweep moved to trash. */
async function located(store: Store, key: string): Promise<{ key: string; size: number } | null> {
  for (const k of [key, `trash/${key}`]) {
    const head = await store.head(k)
    if (head) return { key: k, size: head.size }
  }
  return null
}

const coversAssets = (f: v3.LayoutFile) =>
  f.first !== null &&
  f.last !== null &&
  v3.compareKeys(f.first[0], '', v3.ASSET_TYPE, '') <= 0 &&
  v3.compareKeys(v3.ASSET_TYPE, '', f.last[0], '') <= 0

/** The assets the listed files name: every `$asset` row that is not a removal. */
async function listedAssets(store: Store, files: v3.LayoutFile[]): Promise<string[]> {
  const out = new Set<string>()
  for (const f of files.filter(coversAssets)) {
    const at = await located(store, v3.recordKey(f.id))
    if (!at) throw new Error(`Record file ${f.id} is listed but missing`)
    const file = await v3.SortedFile.open(store, at.key, { id: f.id })
    const cursor = new v3.EntryCursor(file.reader(), file.content.labeled ? null : 1)
    await cursor.seek({ type: v3.ASSET_TYPE, id: '' })
    while (cursor.current && cursor.current.type === v3.ASSET_TYPE) {
      if (cursor.current.kind !== 'x') out.add(cursor.current.id)
      await cursor.next()
    }
  }
  return [...out].sort()
}

/**
 * Copy (part of) what a mirror of a v3 collection lacks. Called by `mirrorStep` holding
 * the placement's lease. Returns true when a job has been queued for the rest.
 */
export async function v3MirrorStep(
  ports: Ports,
  p: Placement,
  dest: Store,
  collection: { id: string; public: boolean },
): Promise<boolean> {
  const { db } = ports
  if (p.sets !== 'public+private' && !collection.public) {
    await db
      .update(schema.placements)
      .set({
        state: 'error',
        lastError: PRIVATE_COLLECTION_ERROR,
        leaseUntil: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.placements.id, p.id))
    return false
  }

  const store = ports.stores.v3
  const id = collection.id
  const { layout, head, files } = await v3.currentFiles(store, id)
  const copied = await readCopied(ports, p.id)
  const doneFiles = new Set(copied.files)
  const doneAssets = new Set(copied.assets)
  const requeue = async () => {
    await ports.stores.internal.put(
      copiedKey(p.id),
      JSON.stringify({ files: [...doneFiles], assets: [...doneAssets] }),
    )
    await db
      .update(schema.placements)
      .set({ state: 'backfilling', lastError: null, leaseUntil: null, updatedAt: new Date() })
      .where(eq(schema.placements.id, p.id))
    await ports.jobs.enqueue({ type: 'mirror.version', placementId: p.id })
    return true
  }
  let bytes = 0
  const budget = mirrorConfig.fileBytesPerJob

  // The sorted-record-files the layout and later commits name.
  for (const f of files) {
    if (doneFiles.has(f.id)) continue
    const key = v3.recordKey(f.id)
    const at = await located(store, key)
    if (!at) throw new Error(`Record file ${f.id} is listed but missing`)
    await putFromParts(dest, key, readParts(store, at.key, at.size, mirrorConfig.partBytes))
    doneFiles.add(f.id)
    bytes += at.size
    if (bytes >= budget) return requeue()
  }

  // The assets they name.
  for (const hash of await listedAssets(store, files)) {
    if (doneAssets.has(hash)) continue
    const key = assetKey(hash)
    const at = await located(store, key)
    if (!at) throw new Error(`Asset ${hash} is listed but not stored`)
    const [row] = await db
      .select({ mimeType: schema.files.mimeType })
      .from(schema.files)
      .where(eq(schema.files.hash, hash))
      .limit(1)
    await putFromParts(dest, key, readParts(store, at.key, at.size, mirrorConfig.partBytes), {
      ...(row?.mimeType ? { contentType: row.mimeType } : {}),
    })
    doneAssets.add(hash)
    bytes += at.size
    if (bytes >= budget) return requeue()
  }
  await ports.stores.internal.put(
    copiedKey(p.id),
    JSON.stringify({ files: [...doneFiles], assets: [...doneAssets] }),
  )

  // The collection itself: its description, commits, and current layout, then the hints.
  const json = { contentType: 'application/json' }
  const copyObject = async (key: string) => {
    const obj = await store.get(key)
    if (!obj) throw new Error(`Missing object ${key}`)
    await dest.put(key, await obj.bytes(), json)
  }
  await copyObject(v3.descriptionKey(id))
  for (let n = Math.max(1, p.syncedSeq + 1); n <= head; n++) await copyObject(v3.commitKey(id, n))
  if (layout) await copyObject(v3.layoutKey(id, layout.number))
  if (layout) await v3.writeLayoutHint(dest, id, layout.number)
  await v3.writeCommitHint(dest, id, head)

  // A commit landed while this ran: go again.
  const [latest] = await db
    .select({ seq: schema.versions.seq })
    .from(schema.collections)
    .innerJoin(schema.versions, eq(schema.versions.id, schema.collections.headVersionId))
    .where(eq(schema.collections.id, id))
  const more = (latest?.seq ?? 0) > head
  await db
    .update(schema.placements)
    .set({
      syncedSeq: head,
      cursor: null,
      state: more ? 'backfilling' : 'active',
      lastError: null,
      leaseUntil: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.placements.id, p.id))
  if (more) await ports.jobs.enqueue({ type: 'mirror.version', placementId: p.id })
  return more
}
