/**
 * In-memory cache for KF Auth user profile data.
 * Fetches name + image from KF Auth's internal API with a 5-minute TTL.
 */

const KF_AUTH_URL = process.env.KF_AUTH_URL ?? 'http://localhost:3000'
const KF_AUTH_INTERNAL_URL = process.env.KF_AUTH_INTERNAL_URL ?? KF_AUTH_URL
const KF_INTERNAL_API_KEY = process.env.KF_INTERNAL_API_KEY ?? ''

const TTL_MS = 5 * 60 * 1000 // 5 minutes

interface CachedProfile {
  name: string
  image: string | null
  fetchedAt: number
}

const cache = new Map<string, CachedProfile>()

export interface KFProfile {
  name: string
  image: string | null
}

/**
 * Get a KF Auth user's profile (name, image).
 * Uses an in-memory cache with a 5-minute TTL.
 * On miss/expiry, calls KF Auth internal API.
 */
export async function getKfProfile(userId: string): Promise<KFProfile | null> {
  const cached = cache.get(userId)
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) {
    return { name: cached.name, image: cached.image }
  }

  try {
    const res = await fetch(`${KF_AUTH_INTERNAL_URL}/api/internal/users/${userId}`, {
      headers: { Authorization: `Bearer ${KF_INTERNAL_API_KEY}` },
    })
    if (!res.ok) return null

    const data = (await res.json()) as {
      id: string
      name: string
      email: string
      image: string | null
    }
    const entry: CachedProfile = { name: data.name, image: data.image, fetchedAt: Date.now() }
    cache.set(userId, entry)
    return { name: entry.name, image: entry.image }
  } catch (e) {
    console.error(`Failed to fetch KF profile for ${userId}:`, e)
    // Return stale cache on error if available
    if (cached) return { name: cached.name, image: cached.image }
    return null
  }
}
