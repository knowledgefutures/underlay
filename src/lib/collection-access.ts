/**
 * Access decisions for collection-scoped routes, kept free of the database so
 * they can be tested directly. The server wrappers that resolve rows and turn a
 * denial into a response are `authorizeCollectionWrite` and
 * `resolveAccessibleCollection` (version-helpers.server.ts) and `loadOwnSession`
 * (api/negotiate.ts).
 *
 * The options exist to keep each route's historical status codes, messages and
 * check order; they are not a menu of policies.
 */

export const NOT_SCOPED_MESSAGE = 'API key is not scoped to this collection'

export interface Denial {
  status: 403 | 404
  error: string
}

/**
 * Whether a collection-scoped API key (share/agent link) covers this collection.
 * Callers without a scoped key — sessions and unscoped keys — always pass.
 */
export function keyScopeAllows(scopedCollectionIds: string[] | undefined, collectionId: string) {
  return !scopedCollectionIds || scopedCollectionIds.includes(collectionId)
}

/** 'member' admits any membership row; 'admin' admits owner or admin. */
export type MinRole = 'member' | 'admin'

export function roleMeets(role: string | null, minRole: MinRole): boolean {
  if (role === null) return false
  if (minRole === 'admin') return role === 'owner' || role === 'admin'
  return true
}

export interface CollectionWriteOptions {
  minRole?: MinRole
  /**
   * Check the key's scope before the caller's role. Uploads and the ARK
   * settings do; everything else checks role first.
   */
  scopeFirst?: boolean
  /** 404 body. Defaults to 'Collection not found'. */
  notFoundMessage?: string
  /** 403 body for a key scoped to other collections. Defaults to NOT_SCOPED_MESSAGE. */
  scopeMessage?: string
}

/**
 * Decide whether the caller may write to `collection` (null when owner/slug did
 * not resolve). `getRole` is only called when the decision needs it, so a
 * scope-first denial costs no membership lookup.
 */
export async function decideCollectionWrite(
  collection: { id: string } | null,
  caller: { scopedCollectionIds: string[] | undefined; getRole: () => Promise<string | null> },
  options: CollectionWriteOptions = {},
): Promise<{ denial: Denial } | { role: string }> {
  const {
    minRole = 'member',
    scopeFirst = false,
    notFoundMessage = 'Collection not found',
    scopeMessage = NOT_SCOPED_MESSAGE,
  } = options

  if (!collection) return { denial: { status: 404, error: notFoundMessage } }

  const scopeDenial: Denial | null = keyScopeAllows(caller.scopedCollectionIds, collection.id)
    ? null
    : { status: 403, error: scopeMessage }
  if (scopeFirst && scopeDenial) return { denial: scopeDenial }

  const role = await caller.getRole()
  if (!roleMeets(role, minRole)) return { denial: { status: 403, error: 'Forbidden' } }

  if (scopeDenial) return { denial: scopeDenial }
  return { role: role! }
}

export interface SessionAccessRow {
  userId: string
  collectionId: string
  status: string
  expiresAt: Date
  /** Owner org slug and collection slug of the session's collection. */
  ownerSlug: string
  collectionSlug: string
}

export interface OwnSessionOptions {
  /** Refuse sessions that are not open or have passed their idle timeout. */
  requireOpen?: boolean
  /**
   * Expire a refused session even when it is not open. Only the records route
   * does this, and it looks wrong: it rewrites a committing, committed or failed
   * session to 'expired'. Kept as-is when the session checks were
   * consolidated, since fixing it changes behavior.
   */
  expireAnyStatus?: boolean
}

/**
 * Decide whether the caller may act on a negotiate session reached through
 * `/:owner/:slug/versions/negotiate/:sessionId`.
 *
 * A session reached through another collection's URL is treated as missing:
 * same 404, and no side effects on it.
 *
 * Returns null when the caller may proceed. Key scope is checked separately
 * (`sessionScopeDenial`) because commit rechecks membership in between.
 */
export function decideOwnSession(
  session: SessionAccessRow | undefined,
  request: {
    owner: string
    slug: string
    userId: string | undefined
    now: Date
  },
  options: OwnSessionOptions = {},
): { denial: Denial; expire: boolean } | null {
  const notFound = options.requireOpen ? 'Session expired or not found' : 'Session not found'

  if (!session || session.ownerSlug !== request.owner || session.collectionSlug !== request.slug) {
    return { denial: { status: 404, error: notFound }, expire: false }
  }

  if (options.requireOpen && (session.status !== 'open' || session.expiresAt < request.now)) {
    return {
      denial: { status: 404, error: notFound },
      expire: options.expireAnyStatus || session.status === 'open',
    }
  }

  if (session.userId !== request.userId) {
    return { denial: { status: 403, error: 'Not authorized' }, expire: false }
  }

  return null
}

/** The scope half of the session guard, which commit runs after its membership recheck. */
export function sessionScopeDenial(
  session: { collectionId: string },
  scopedCollectionIds: string[] | undefined,
): Denial | null {
  return keyScopeAllows(scopedCollectionIds, session.collectionId)
    ? null
    : { status: 403, error: NOT_SCOPED_MESSAGE }
}
