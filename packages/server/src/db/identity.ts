/**
 * What per-isolate caches key a database by. On Workers each request opens its
 * own Db (anonymous reads go through a D1 session of their own), so a cache keyed
 * by the Db never hit: the isolate's caches key by the binding behind it instead.
 */
import type { Db } from '../ports.js'

const identities = new WeakMap<object, object>()

/** Record that `db` is a view of `identity` (a D1 binding). */
export function setDbIdentity(db: Db, identity: object): void {
  identities.set(db, identity)
}

/** The database `db` reads: its binding where one was recorded, else the Db itself. */
export function dbIdentity(db: Db): object {
  return identities.get(db) ?? db
}
