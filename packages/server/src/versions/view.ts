/**
 * What a caller can see of a version: the read path's single place for privacy.
 *
 * Authorization picks the sets (public, or public + private) once; everything
 * after that is set-scoped reading of trees. Nothing filters individual records.
 */
import {
  compareUtf8,
  entryAt,
  getEntry,
  iterate,
  parseSemver,
  type PrivateSetObject,
  rankOf,
  type RecordEntry,
  recordTree,
  type Repo,
  RepoSource,
  type SetObject,
  type TreeSummary,
  type VersionRoot,
} from '@underlay/protocol'
import { and, desc, eq } from 'drizzle-orm'

import * as schema from '../db/schema.js'
import type { Db } from '../ports.js'

export type VersionRow = typeof schema.versions.$inferSelect

/** Find a version by semver ("v1.2.3", "1.2"), "latest", or v2 hash. */
export async function findVersion(
  db: Db,
  collectionId: string,
  n: string,
  headVersionId: string | null,
): Promise<VersionRow | null> {
  let where
  if (n === 'latest') {
    if (!headVersionId) return null
    where = eq(schema.versions.id, headVersionId)
  } else if (n.startsWith('ulv2:')) {
    where = and(eq(schema.versions.collectionId, collectionId), eq(schema.versions.hash, n))
  } else {
    where = and(
      eq(schema.versions.collectionId, collectionId),
      eq(schema.versions.semver, parseSemver(n).semver),
    )
  }
  const [v] = await db
    .select()
    .from(schema.versions)
    .where(where)
    .orderBy(desc(schema.versions.seq))
    .limit(1)
  return v ?? null
}

export interface TypeView {
  slug: string
  schemaHash: string
  /** Trees this caller may read, per set. */
  public: TreeSummary | null
  private: TreeSummary | null
  /** Records visible to this caller. */
  count: number
  bytes: number
  /** True when the whole type is private. */
  privateType: boolean
}

export interface VersionView {
  version: VersionRow
  repo: Repo
  root: VersionRoot
  public: SetObject
  /** Only when the caller may read the private set. */
  private: PrivateSetObject | null
  types: TypeView[]
  owner: boolean
  /** Record hashes never served (the denylist); typeRecords and getRecord skip them. */
  withheld: ReadonlySet<string>
}

export async function loadView(
  repo: Repo,
  version: VersionRow,
  owner: boolean,
  withheld: ReadonlySet<string> = new Set(),
): Promise<VersionView> {
  const root = await repo.root(version.hash)
  const priv = owner && root.private ? await repo.privateSet(root.private) : null
  const slugs = new Set([...Object.keys(root.public.types), ...Object.keys(priv?.types ?? {})])
  const types = [...slugs].sort(compareUtf8).map((slug): TypeView => {
    const pub = root.public.types[slug] ?? null
    const pri = priv?.types[slug] ?? null
    return {
      slug,
      schemaHash: (pub ?? pri)!.schema,
      public: pub,
      private: pri,
      count: (pub?.count ?? 0) + (pri?.count ?? 0),
      bytes: (pub?.bytes ?? 0) + (pri?.bytes ?? 0),
      privateType: !pub && !!pri,
    }
  })
  return { version, repo, root, public: root.public, private: priv, types, owner, withheld }
}

export type VisibleRecord = RecordEntry & { type: string; set: 'public' | 'private' }

/** Merge two sorted streams by key (keys are unique across sets). */
async function* mergeById(
  a: AsyncIterable<RecordEntry>,
  b: AsyncIterable<RecordEntry>,
): AsyncGenerator<{ e: RecordEntry; set: 'public' | 'private' }> {
  const ai = a[Symbol.asyncIterator]()
  const bi = b[Symbol.asyncIterator]()
  let x = await ai.next()
  let y = await bi.next()
  while (!x.done || !y.done) {
    if (y.done || (!x.done && compareUtf8(x.value.key, y.value.key) < 0)) {
      yield { e: x.value, set: 'public' }
      x = await ai.next()
    } else {
      yield { e: y.value, set: 'private' }
      y = await bi.next()
    }
  }
}

/**
 * Records of one type, in id order, from a position. `offset` seeks in
 * O(height × log n) even across two sets, by binary search on ranks.
 */
export async function* typeRecords(
  view: VersionView,
  type: TypeView,
  opts: { after?: string; offset?: number; bodies?: boolean } = {},
): AsyncGenerator<VisibleRecord> {
  const source = new RepoSource(recordTree, view.repo)
  const pubRoot = type.public?.root ?? null
  const privRoot = view.owner ? (type.private?.root ?? null) : null
  let after = opts.after
  if (opts.offset && opts.offset > 0) {
    if (opts.offset >= type.count) return
    after = await keyBeforeOffset(source, pubRoot, privRoot, opts.offset)
  }
  const it = (root: string | null) =>
    iterate(source, root, {
      payloads: opts.bodies ?? false,
      ...(after !== undefined ? { after } : {}),
    })
  for await (const { e, set } of mergeById(it(pubRoot), it(privRoot))) {
    if (view.withheld.has(e.hash)) continue
    yield { ...e, type: type.slug, set }
  }
}

/** The key just before global position `offset` across two trees. */
async function keyBeforeOffset(
  source: RepoSource<RecordEntry>,
  a: string | null,
  b: string | null,
  offset: number,
): Promise<string> {
  if (b === null) return (await entryAt(source, a, offset - 1))!.key
  if (a === null) return (await entryAt(source, b, offset - 1))!.key
  // The (offset-1)th key overall is the larger of the last keys taken from each
  // tree; find how many come from `a` by binary search on ranks in `b`.
  let lo = Math.max(0, offset - (await countOf(source, b)))
  let hi = Math.min(offset, await countOf(source, a))
  while (lo < hi) {
    const i = (lo + hi) >> 1 // take i from a, offset - i from b
    const ka = (await entryAt(source, a, i))!.key
    if ((await rankOf(source, b, ka)) + i < offset) lo = i + 1
    else hi = i
  }
  const fromA = lo
  const lastA = fromA > 0 ? (await entryAt(source, a, fromA - 1))!.key : null
  const lastB = offset - fromA > 0 ? (await entryAt(source, b, offset - fromA - 1))!.key : null
  if (lastA === null) return lastB!
  if (lastB === null) return lastA
  return compareUtf8(lastA, lastB) > 0 ? lastA : lastB
}

async function countOf(source: RepoSource<RecordEntry>, root: string): Promise<number> {
  const n = await source.node(root)
  return n.kind === 'leaf' ? n.entries.length : n.children.reduce((s, c) => s + c.count, 0)
}

/** One record by type and id, with its body. */
export async function getRecord(
  view: VersionView,
  type: TypeView,
  id: string,
): Promise<VisibleRecord | null> {
  const source = new RepoSource(recordTree, view.repo)
  for (const [set, tree] of [
    ['public', type.public],
    ['private', view.owner ? type.private : null],
  ] as const) {
    if (!tree?.root) continue
    const hit = await getEntry(source, tree.root, id)
    if (!hit) continue
    if (view.withheld.has(hit.hash)) return null
    const body = await bodyOf(source, tree.root, id)
    return { ...hit, body, type: type.slug, set }
  }
  return null
}

async function bodyOf(source: RepoSource<RecordEntry>, root: string, key: string): Promise<string> {
  let hash = root
  for (;;) {
    const node = await source.node(hash)
    if (node.kind === 'leaf')
      return (await source.leafEntries(hash)).find((e) => e.key === key)!.body!
    hash = node.children.find((c) => compareUtf8(key, c.lastKey) <= 0)!.hash
  }
}
