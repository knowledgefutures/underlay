/**
 * Verify that file access checks and the file listing, read from
 * `version_file_refs`, give exactly the answers the record-body scans they
 * replaced gave, and that the migration's backfill writes the same rows as the
 * commit path.
 *
 * Not part of `pnpm test`: it needs a real Postgres, and the rest of the suite is
 * pure unit tests that run anywhere. Point it at a SCRATCH database — it writes a
 * fixture and does not clean up:
 *
 *   createdb underlay_filerefs_test
 *   DATABASE_URL=postgresql://localhost:5432/underlay_filerefs_test pnpm db:migrate
 *   DATABASE_URL=postgresql://localhost:5432/underlay_filerefs_test pnpm tool:verifyFileRefs
 *
 * `oldAccessible` and `oldListing` are the removed implementations, kept here
 * verbatim apart from their inputs, as the reference.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { and, eq, sql } from 'drizzle-orm'

import { db, schema } from '../src/db/client.server.js'
import { hashRecord, hashSchema } from '../src/lib/core/hash.js'
import { getPrivateFields, getPrivateTypes } from '../src/lib/core/privacy.js'
import {
  accessibleFileHashes,
  copyVersionFileRefs,
  indexVersionFileRefs,
  listedFileRefs,
} from '../src/lib/file-refs.server.js'
import {
  loadVersionSchemas,
  recordsVersionId,
  resolveAccessibleCollection,
} from '../src/lib/version-helpers.server.js'

const fail: string[] = []
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) console.log(`  ok   ${name}`)
  else {
    console.log(`  FAIL ${name} ${detail}`)
    fail.push(name)
  }
}

const H = Object.fromEntries(
  'ABCDEFGHIJKLM'.split('').map((l) => [l, createHash('sha256').update(l).digest('hex')]),
) as Record<string, string>
const ref = (h: string) => ({ $file: `sha256:${h}` })

const SCHEMAS = {
  Thing: {
    type: 'object',
    properties: { doc: {}, secret: { private: true }, list: {}, meta: {}, note: {} },
  },
  Hidden: { type: 'object', private: true, properties: { doc: {} } },
}

type Rec = { id: string; type: string; data: Record<string, unknown>; private?: boolean }

const MAIN: Rec[] = [
  // top-level ref, and one in a private field
  { id: 'r1', type: 'Thing', data: { doc: ref(H.A!), secret: ref(H.B!) } },
  // nested in an array, and deeper inside an object
  { id: 'r2', type: 'Thing', data: { list: [ref(H.C!), { x: ref(H.D!) }] } },
  // private record
  { id: 'r3', type: 'Thing', data: { doc: ref(H.E!) }, private: true },
  // private type
  { id: 'r4', type: 'Hidden', data: { doc: ref(H.F!) } },
  // no `sha256:` prefix, type without a schema
  { id: 'r5', type: 'Other', data: { doc: { $file: H.G } } },
  // mentions "$file" in a string but holds no reference
  { id: 'r7', type: 'Thing', data: { doc: ref(H.A!), note: 'a "$file" key' } },
  // prefix not at the start
  { id: 'r8', type: 'Thing', data: { doc: { $file: `xsha256:${H.I}` } } },
  // nested under a public field, and under a private one
  {
    id: 'r9',
    type: 'Thing',
    data: { doc: { inner: ref(H.J!) }, secret: { deep: [ref(H.K!)] } },
  },
  // the same file twice in one field
  { id: 'r10', type: 'Thing', data: { list: [ref(H.C!), ref(H.C!)] } },
]
// A non-string `$file`: the old listing threw on this, so it lives apart.
const ODD: Rec[] = [{ id: 'r6', type: 'Thing', data: { meta: { $file: ref(H.H!) } } }]

const ALL_FILES = Object.values(H)

async function main() {
  // --- fixture ---
  const run = Date.now().toString(36)
  const orgId = `org_${run}`
  await db.insert(schema.organization).values({ id: orgId, name: 'Org', slug: `org-${run}` })
  for (const u of ['in', 'out']) {
    await db.insert(schema.user).values({ id: `u_${u}_${run}`, name: u, email: `${u}${run}@x.y` })
  }
  await db
    .insert(schema.member)
    .values({ id: `m_${run}`, organizationId: orgId, userId: `u_in_${run}` })
  await db
    .insert(schema.files)
    .values(ALL_FILES.map((h) => ({ hash: h, size: 1, mimeType: 'x/y', storageKey: h })))
    .onConflictDoNothing()

  const schemaIds: Record<string, string> = {}
  for (const [slug, body] of Object.entries(SCHEMAS)) {
    const schemaHash = hashSchema(body)
    await db.insert(schema.schemas).values({ schema: body, schemaHash }).onConflictDoNothing()
    const [row] = await db
      .select({ id: schema.schemas.id })
      .from(schema.schemas)
      .where(eq(schema.schemas.schemaHash, schemaHash))
    schemaIds[slug] = row!.id
  }

  const makeCollection = async (slug: string, isPublic: boolean) => {
    const [c] = await db
      .insert(schema.collections)
      .values({ organizationId: orgId, slug, name: slug, public: isPublic })
      .returning()
    return c!
  }

  let semverN = 0
  const makeVersion = async (
    collectionId: string,
    records: Rec[],
    opts: { status?: string; recordsFrom?: number } = {},
  ) => {
    const n = ++semverN
    const [v] = await db
      .insert(schema.versions)
      .values({
        collectionId,
        semver: `v${n}.0.0`,
        major: n,
        minor: 0,
        patch: 0,
        hash: `h${run}${n}`,
        recordCount: records.length,
        fileCount: ALL_FILES.length,
        totalBytes: 0,
        status: opts.status ?? 'ready',
        recordsFromVersionId: opts.recordsFrom ?? null,
      })
      .returning()
    await db.insert(schema.versionSchemas).values(
      Object.keys(SCHEMAS).map((slug) => ({
        versionId: v!.id,
        slug,
        schemaId: schemaIds[slug]!,
      })),
    )
    await db
      .insert(schema.versionFiles)
      .values(ALL_FILES.map((fileHash) => ({ versionId: v!.id, fileHash })))
    if (opts.recordsFrom == null) {
      for (const r of records) {
        const { hash } = hashRecord({ id: r.id, type: r.type, data: r.data })
        await db
          .insert(schema.recordObjects)
          .values({ hash, recordId: r.id, type: r.type, data: r.data, size: 1 })
          .onConflictDoNothing()
        await db.insert(schema.versionRecords).values({
          versionId: v!.id,
          recordHash: hash,
          recordId: r.id,
          type: r.type,
          private: r.private ?? false,
        })
      }
      await indexVersionFileRefs(v!.id)
    }
    return v!
  }

  const pub = await makeCollection(`pub-${run}`, true)
  const pubV1 = await makeVersion(pub.id, MAIN)
  // A later version that dropped most records: files stay reachable through v1.
  const pubV2 = await makeVersion(pub.id, MAIN.slice(0, 1))
  // A metadata patch sharing v1's rows.
  const pubPatch = await makeVersion(pub.id, [], { recordsFrom: pubV1.id })

  const priv = await makeCollection(`priv-${run}`, false)
  const privV1 = await makeVersion(priv.id, MAIN)

  const creating = await makeCollection(`creating-${run}`, true)
  await makeVersion(creating.id, MAIN, { status: 'creating' })

  const odd = await makeCollection(`odd-${run}`, true)
  const oddV1 = await makeVersion(odd.id, ODD)

  // --- access checks ---
  console.log('access')
  const callers = [
    { name: 'anonymous', userId: undefined, scope: undefined },
    { name: 'non-member', userId: `u_out_${run}`, scope: undefined },
    { name: 'member', userId: `u_in_${run}`, scope: undefined },
    { name: 'member, key scoped elsewhere', userId: `u_in_${run}`, scope: [odd.id] },
  ]
  for (const coll of [pub, priv, creating, odd]) {
    for (const caller of callers) {
      const resolved = await resolveAccessibleCollection(
        `org-${run}`,
        coll.slug,
        caller.userId,
        caller.scope,
      )
      const batch = await accessibleFileHashes(resolved, ALL_FILES)
      for (const [letter, h] of Object.entries(H)) {
        const before = await oldAccessible(coll, caller.userId, caller.scope, h)
        check(
          `${coll.slug.split('-')[0]} ${caller.name} ${letter}`,
          batch.has(h) === before,
          `index=${batch.has(h)} scan=${before}`,
        )
      }
    }
  }
  const anonPub = await accessibleFileHashes(
    await resolveAccessibleCollection(`org-${run}`, pub.slug, undefined),
    ALL_FILES,
  )
  const letters = Object.entries(H)
    .filter(([, h]) => anonPub.has(h))
    .map(([l]) => l)
    .join('')
  check('public files are exactly A C D J', letters === 'ACDJ', letters)

  // --- listing ---
  console.log('listing')
  for (const v of [pubV1, pubV2, pubPatch, privV1]) {
    for (const ownerAccess of [true, false]) {
      const after = normalize(await listedFileRefs(recordsVersionId(v), ownerAccess))
      const before = normalize(await oldListing(v, ownerAccess))
      check(`${v.semver} owner=${ownerAccess}`, after === before, `\n${after}\n${before}`)
    }
  }
  let oldThrew = false
  try {
    await oldListing(oddV1, true)
  } catch {
    oldThrew = true
  }
  check('old listing threw on a non-string $file', oldThrew)
  check('new listing omits it', (await listedFileRefs(recordsVersionId(oddV1), true)).size === 0)

  // --- fork copies ---
  console.log('fork')
  const fork = await makeCollection(`fork-${run}`, false)
  const forkV = await makeVersion(fork.id, [], { recordsFrom: pubV1.id })
  // makeVersion with recordsFrom indexes nothing; a fork owns a copy instead.
  await db
    .update(schema.versions)
    .set({ recordsFromVersionId: null })
    .where(eq(schema.versions.id, forkV.id))
  await copyVersionFileRefs(pubV1.id, forkV.id)
  check('fork has the same refs', (await refRows(forkV.id)) === (await refRows(pubV1.id)))

  // --- backfill ---
  console.log('backfill')
  const owners = [pubV1, pubV2, privV1, oddV1]
  const committed = await Promise.all(owners.map((v) => refRows(v.id)))
  await db.execute(sql`DELETE FROM version_file_refs`)
  const backfill = readFileSync(
    resolve(import.meta.dirname, '../src/db/migrations/0017_version_file_refs.sql'),
    'utf8',
  )
    .split('--> statement-breakpoint')
    .find((s) => s.includes('INSERT INTO version_file_refs'))!
  await db.execute(sql.raw(backfill))
  const backfilled = await Promise.all(owners.map((v) => refRows(v.id)))
  owners.forEach((v, i) =>
    check(`backfill ${v.semver}`, backfilled[i] === committed[i], `\n${backfilled[i]}`),
  )
  check('backfill wrote nothing for the patch', (await refRows(pubPatch.id)) === '')

  console.log(
    fail.length === 0 ? '\nALL PASSED\n' : `\n${fail.length} FAILED: ${fail.join(', ')}\n`,
  )
  process.exit(fail.length === 0 ? 0 : 1)
}

function normalize(refs: Map<string, { recordId: string; type: string; field: string }[]>) {
  return [...refs]
    .map(([h, rs]) => `${h.slice(0, 6)}:${rs.map((r) => `${r.recordId}/${r.field}`).sort()}`)
    .sort()
    .join(' ')
}

async function refRows(versionId: number) {
  const rows = (await db.execute(sql`
    SELECT file_hash, prefixed, record_id, type, field, nested, private
    FROM version_file_refs WHERE version_id = ${versionId}
  `)) as unknown as Record<string, unknown>[]
  return rows
    .map((r) => JSON.stringify(Object.values(r)))
    .sort()
    .join('\n')
}

// --- the removed implementations ---

async function oldAccessible(
  collection: { id: string; organizationId: string; public: boolean },
  userId: string | undefined,
  apiKeyCollectionIds: string[] | undefined,
  fileHash: string,
): Promise<boolean> {
  const keyScopeOk = !apiKeyCollectionIds || apiKeyCollectionIds.includes(collection.id)

  const [belongs] = await db
    .select({ fileHash: schema.versionFiles.fileHash })
    .from(schema.versionFiles)
    .innerJoin(schema.versions, eq(schema.versionFiles.versionId, schema.versions.id))
    .where(
      and(
        eq(schema.versions.collectionId, collection.id),
        eq(schema.versionFiles.fileHash, fileHash),
      ),
    )
    .limit(1)
  if (!belongs) return false

  if (userId != null && keyScopeOk) {
    const [membership] = await db
      .select()
      .from(schema.member)
      .where(
        and(
          eq(schema.member.organizationId, collection.organizationId),
          eq(schema.member.userId, userId),
        ),
      )
      .limit(1)
    if (membership) return true
  }

  if (!collection.public) return false

  const candidates = await db
    .select({
      versionId: schema.versionRecords.versionId,
      type: schema.recordObjects.type,
      data: schema.recordObjects.data,
    })
    .from(schema.versionRecords)
    .innerJoin(schema.versions, eq(schema.versionRecords.versionId, schema.versions.id))
    .innerJoin(
      schema.recordObjects,
      eq(schema.versionRecords.recordHash, schema.recordObjects.hash),
    )
    .where(
      and(
        eq(schema.versions.collectionId, collection.id),
        eq(schema.versions.status, 'ready'),
        eq(schema.versionRecords.private, false),
        sql`${schema.recordObjects.data}::text LIKE ${'%' + fileHash + '%'}`,
      ),
    )
    .limit(50)

  for (const rec of candidates) {
    const entries = await loadVersionSchemas(rec.versionId)
    const body = entries.find((e) => e.slug === rec.type)?.schema as Record<string, any>
    if (body?.private === true) continue
    const privateFields = new Set<string>()
    for (const [fieldName, fieldDef] of Object.entries(body?.properties ?? {})) {
      if ((fieldDef as any)?.private === true) privateFields.add(fieldName)
    }
    const containsRef = (value: unknown): boolean => {
      if (!value || typeof value !== 'object') return false
      const r = (value as { $file?: unknown }).$file
      if (typeof r === 'string') return r === `sha256:${fileHash}`
      return Object.values(value as Record<string, unknown>).some(containsRef)
    }
    for (const [key, val] of Object.entries(rec.data as Record<string, any>)) {
      if (privateFields.has(key)) continue
      if (containsRef(val)) return true
    }
  }
  return false
}

async function oldListing(
  version: { id: number; recordsFromVersionId: number | null },
  ownerAccess: boolean,
) {
  let privateTypes = new Set<string>()
  const privateFieldsByType = new Map<string, Set<string>>()
  if (!ownerAccess) {
    const schemaEntries = await loadVersionSchemas(version.id)
    privateTypes = getPrivateTypes(schemaEntries)
    for (const e of schemaEntries) privateFieldsByType.set(e.slug, getPrivateFields(e.schema))
  }

  const refConditions = [
    eq(schema.versionRecords.versionId, recordsVersionId(version)),
    sql`${schema.recordObjects.data}::text LIKE '%"$file"%'`,
  ]
  if (!ownerAccess) refConditions.push(eq(schema.versionRecords.private, false))
  const fileRefRecords = await db
    .select({
      recordId: schema.recordObjects.recordId,
      type: schema.recordObjects.type,
      data: schema.recordObjects.data,
    })
    .from(schema.versionRecords)
    .innerJoin(
      schema.recordObjects,
      eq(schema.versionRecords.recordHash, schema.recordObjects.hash),
    )
    .where(and(...refConditions))

  const fileRefs = new Map<string, { recordId: string; type: string; field: string }[]>()
  for (const rec of fileRefRecords) {
    if (!ownerAccess && privateTypes.has(rec.type)) continue
    const privateFields = ownerAccess
      ? undefined
      : (privateFieldsByType.get(rec.type) ?? new Set<string>())
    const data = rec.data as Record<string, unknown>
    for (const [field, val] of Object.entries(data)) {
      if (privateFields?.has(field)) continue
      if (val && typeof val === 'object' && '$file' in (val as any)) {
        const hash = ((val as any).$file as string).replace('sha256:', '')
        if (!fileRefs.has(hash)) fileRefs.set(hash, [])
        fileRefs.get(hash)!.push({ recordId: rec.recordId, type: rec.type, field })
      }
    }
  }
  return fileRefs
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
