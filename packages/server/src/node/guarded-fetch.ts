/**
 * Node only: fetch for user-supplied URLs that refuses private addresses.
 *
 * Resolves the host first and refuses if any address is private. There is a
 * window between this lookup and the connection (DNS rebinding); v1 closed it by
 * pinning the address with an undici Agent, which is the next step here if Node
 * deployments take untrusted webhook URLs. Workers have no private network.
 */
import { lookup } from 'node:dns/promises'

import { ipKind, isPrivateIp } from '../webhooks/webhooks.js'

export async function guardedFetch(url: string, init: RequestInit): Promise<Response> {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '')
  const addresses = ipKind(host) ? [{ address: host }] : await lookup(host, { all: true })
  if (addresses.some((a) => isPrivateIp(a.address))) {
    throw new Error('Webhook host resolves to a private address')
  }
  return fetch(url, init)
}
