/**
 * A collection's authority, and the receipts it writes (protocol-v3 4.6 and 4.7).
 *
 * The authority is the one server that accepts a collection's versions: `authority` in its
 * description, or, without it, the server that holds it. This server accepts a version only
 * where it is the authority (`landCommit` asks, so every way a commit lands is covered), and
 * writes a receipt beside each commit it accepts.
 */
import { v3 } from '@underlay/protocol'

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
