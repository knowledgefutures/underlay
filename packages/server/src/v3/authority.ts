/**
 * A collection's authority, and the receipts it writes (docs/protocol/v3.md 8.1 and 8.2).
 *
 * The authority is the one server that accepts a collection's versions: `authority` in its
 * description, or, without it, the server that holds it. This server accepts a version only
 * where it is the authority (`landCommit` asks, so every way a commit lands is covered), and
 * writes a receipt beside each commit it accepts.
 */
import { jcs, v3 } from '@underlay/protocol'
import { eq } from 'drizzle-orm'

import * as schema from '../db/schema.js'
import type { Ports } from '../ports.js'

/** The authority a description names, or this server. */
export const authorityIn = (ports: Ports, d: v3.Description | null): string =>
  typeof d?.authority === 'string' ? d.authority : ports.serverName

/** The address of a collection's authority: its description's `authority`, or this server. */
export async function authorityOf(ports: Ports, collectionId: string): Promise<string> {
  return authorityIn(ports, await v3.readDescription(ports.stores.v3, collectionId))
}

/**
 * Write the collection's description if it has none (its D1 row came first). Asked at
 * every landing, so a collection has one from its first commit however that was sent: an
 * upload as well as a push session. fsck and a bucket mirror both need it.
 */
export async function ensureCollection(store: Ports['stores']['v3'], id: string) {
  if (await v3.readDescription(store, id)) return
  try {
    await v3.createCollection(store, id)
  } catch (err) {
    // Another commit wrote it first.
    if (!(err instanceof v3.CollectionError)) throw err
  }
}

/**
 * Bring a collection's description up to what the protocol asks of it (docs/protocol/v3.md,
 * Section 12): whether it is `public`, and the `keys` that sign its commits and receipts, so
 * a copy of the bucket can be checked without this server. Written only when it changes.
 */
export async function syncDescription(ports: Ports, collectionId: string): Promise<void> {
  const store = ports.stores.v3
  await ensureCollection(store, collectionId)
  const description = await v3.readDescription(store, collectionId)
  if (!description) return
  const [row] = await ports.db
    .select({ public: schema.collections.public })
    .from(schema.collections)
    .where(eq(schema.collections.id, collectionId))
  if (!row) return
  const signer = await ports.signer()
  const key = {
    keyId: signer.keyId,
    alg: 'Ed25519',
    publicKey: signer.publicKey.publicKey,
  }
  const keys = Array.isArray(description.keys)
    ? (description.keys as { keyId: string }[]).filter((k) => k.keyId !== key.keyId)
    : []
  const next = { ...description, public: row.public, keys: [...keys, key] }
  if (jcs(next) === jcs(description)) return
  await store.put(v3.descriptionKey(collectionId), jcs(next), {
    contentType: 'application/json',
  })
}

/** What a client is told when it sends a version to a server that is not the authority. */
export const notAuthority = (authority: string) =>
  `The authority for this collection is ${authority}: send its versions there`

/**
 * The authority's receipt beside a commit it accepted, in the log of `collectionId` (a
 * fork's earlier commits carry the collection they were made for). Created only if absent,
 * so it is safe to write again: a land that stopped before its receipt, a commit found in
 * the bucket that D1 lacked.
 */
export async function writeReceiptFor(
  ports: Ports,
  collectionId: string,
  stored: v3.StoredCommit,
  at = new Date(),
) {
  const receipt = await v3.makeReceipt(stored, ports.serverName, await ports.signer(), at)
  await v3.writeReceipt(ports.stores.v3, receipt, collectionId)
}
