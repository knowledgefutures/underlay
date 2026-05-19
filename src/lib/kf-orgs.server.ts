/**
 * Fetch a user's KF org memberships on demand from KF Auth's internal API.
 * Used for the org-creation dropdown (availableKfOrgs).
 */

import type { KFOrg } from './kf-auth.server.js'

const KF_AUTH_URL = process.env.KF_AUTH_URL ?? 'http://localhost:3000'
const KF_AUTH_INTERNAL_URL = process.env.KF_AUTH_INTERNAL_URL ?? KF_AUTH_URL
const KF_INTERNAL_API_KEY = process.env.KF_INTERNAL_API_KEY ?? ''

/**
 * Fetch all KF orgs the given user belongs to.
 * Calls KF Auth internal API with API key auth.
 */
export async function fetchKfOrgs(kfUserId: string): Promise<KFOrg[]> {
  const res = await fetch(`${KF_AUTH_INTERNAL_URL}/api/internal/users/${kfUserId}/orgs`, {
    headers: { Authorization: `Bearer ${KF_INTERNAL_API_KEY}` },
  })
  if (!res.ok) {
    console.error(`Failed to fetch KF orgs for ${kfUserId}: ${res.status}`)
    return []
  }
  const data = (await res.json()) as { orgs?: KFOrg[] } | KFOrg[]
  // Handle both { orgs: [...] } and bare array shapes
  if (Array.isArray(data)) return data
  return data.orgs ?? []
}
