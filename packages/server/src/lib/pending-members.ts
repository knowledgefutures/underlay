/**
 * Adding people to an org by email, without an invitation to accept.
 *
 * Someone with an account here joins at once. Anyone else is remembered in
 * `pending_members` and joins the first time they sign in with that address
 * (auth.ts calls applyPendingMembers when a session starts). Addresses are
 * matched lower case, as invitations are.
 */
import { and, eq, inArray, sql } from 'drizzle-orm'

import * as schema from '../db/schema.js'
import type { Db } from '../ports.js'

export const normalizeEmail = (email: string) => email.trim().toLowerCase()

/** A plausible address: something@something.tld, no spaces. */
export const looksLikeEmail = (email: string) =>
  email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)

/** The account here with this address, if any. */
export async function userByEmail(db: Db, email: string) {
  const [u] = await db
    .select({ id: schema.user.id, name: schema.user.name })
    .from(schema.user)
    .where(sql`lower(${schema.user.email}) = ${normalizeEmail(email)}`)
    .limit(1)
  return u ?? null
}

/**
 * Make the user a member of every org that added their address, then forget those
 * adds. An org they already belong to keeps the role they have.
 */
export async function applyPendingMembers(db: Db, userId: string, email: string): Promise<number> {
  const pending = await db
    .select()
    .from(schema.pendingMembers)
    .where(eq(schema.pendingMembers.email, normalizeEmail(email)))
  if (!pending.length) return 0
  const orgIds = pending.map((p) => p.organizationId)
  const existing = await db
    .select({ organizationId: schema.member.organizationId })
    .from(schema.member)
    .where(and(eq(schema.member.userId, userId), inArray(schema.member.organizationId, orgIds)))
  const have = new Set(existing.map((m) => m.organizationId))
  const joins = pending.filter((p) => !have.has(p.organizationId))
  await db.batch([
    ...joins.map((p) =>
      db.insert(schema.member).values({ organizationId: p.organizationId, userId, role: p.role }),
    ),
    db.delete(schema.pendingMembers).where(
      inArray(
        schema.pendingMembers.id,
        pending.map((p) => p.id),
      ),
    ),
  ] as unknown as Parameters<Db['batch']>[0])
  return joins.length
}
