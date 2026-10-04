/**
 * Mutable state, in SQLite (D1 on Cloudflare, libsql on Node).
 *
 * Rule: rows are small and bounded. Anything whose size the user controls —
 * version roots, metadata, READMEs, schemas, file lists — lives in the blob store
 * and is referenced by hash. Anything that grows with data (records, version
 * membership, provenance) lives in the blob store too. See edge-redesign.md,
 * "SQLite (mutable state)".
 *
 * D1 has no interactive transactions, only atomic batches, so every
 * read-modify-write is written as a batch whose conditions are in SQL (see
 * publishVersion in ../versions/publish.ts).
 */
import { sql } from 'drizzle-orm'
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

const id = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID())
const createdAt = () =>
  integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch('subsec') * 1000)`)
const ts = (name: string) => integer(name, { mode: 'timestamp_ms' })
const bool = (name: string) => integer(name, { mode: 'boolean' })
const json = <T>(name: string) => text(name, { mode: 'json' }).$type<T>()

/** One counter a reconcile found wrong, and the value it wrote. */
export interface ReconcileDiff {
  field: string
  /** The version, for per-version counters. */
  seq?: number
  was: unknown
  now: unknown
}

// --- better-auth (same fields as v1, so sessions and keys port across) -------

export const user = sqliteTable('user', {
  id: id(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: bool('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: createdAt(),
  updatedAt: ts('updated_at')
    .notNull()
    .$defaultFn(() => new Date()),
})

export const session = sqliteTable(
  'session',
  {
    id: id(),
    expiresAt: ts('expires_at').notNull(),
    token: text('token').notNull().unique(),
    createdAt: createdAt(),
    updatedAt: ts('updated_at')
      .notNull()
      .$defaultFn(() => new Date()),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    activeOrganizationId: text('active_organization_id'),
  },
  (t) => [index('session_user_id_idx').on(t.userId)],
)

export const account = sqliteTable(
  'account',
  {
    id: id(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: ts('access_token_expires_at'),
    refreshTokenExpiresAt: ts('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at')
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index('account_user_id_idx').on(t.userId)],
)

export const verification = sqliteTable(
  'verification',
  {
    id: id(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: ts('expires_at').notNull(),
    createdAt: createdAt(),
    updatedAt: ts('updated_at')
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index('verification_identifier_idx').on(t.identifier)],
)

export const organization = sqliteTable('organization', {
  id: id(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  logo: text('logo'),
  createdAt: createdAt(),
  metadata: text('metadata'),
  bio: text('bio'),
  website: text('website'),
  avatarUrl: text('avatar_url'),
  arkNaan: text('ark_naan'),
  kfOrgId: text('kf_org_id'),
  isDefault: bool('is_default').default(false),
})

export const member = sqliteTable(
  'member',
  {
    id: id(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('member'),
    createdAt: createdAt(),
  },
  (t) => [
    index('member_organization_id_idx').on(t.organizationId),
    index('member_user_id_idx').on(t.userId),
  ],
)

export const invitation = sqliteTable(
  'invitation',
  {
    id: id(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role'),
    status: text('status').notNull().default('pending'),
    expiresAt: ts('expires_at').notNull(),
    createdAt: createdAt(),
    inviterId: text('inviter_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (t) => [index('invitation_organization_id_idx').on(t.organizationId)],
)

export const apikey = sqliteTable(
  'apikey',
  {
    id: id(),
    configId: text('config_id').notNull().default('default'),
    name: text('name'),
    start: text('start'),
    referenceId: text('reference_id').notNull(),
    prefix: text('prefix'),
    key: text('key').notNull(),
    refillInterval: integer('refill_interval'),
    refillAmount: integer('refill_amount'),
    lastRefillAt: ts('last_refill_at'),
    enabled: bool('enabled').default(true),
    rateLimitEnabled: bool('rate_limit_enabled').default(true),
    rateLimitTimeWindow: integer('rate_limit_time_window').default(86_400_000),
    rateLimitMax: integer('rate_limit_max').default(10),
    requestCount: integer('request_count').default(0),
    remaining: integer('remaining'),
    lastRequest: ts('last_request'),
    expiresAt: ts('expires_at'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at')
      .notNull()
      .$defaultFn(() => new Date()),
    permissions: text('permissions'),
    metadata: text('metadata'),
  },
  (t) => [index('apikey_key_idx').on(t.key), index('apikey_reference_id_idx').on(t.referenceId)],
)

// --- Collections and versions -------------------------------------------------

/** What lists and explore show without reading a root: bounded, refreshed at publish. */
export interface CollectionSummary {
  title?: string
  description?: string
  tags?: string[]
  license?: string
}

export const collections = sqliteTable(
  'collections',
  {
    id: id(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    public: bool('public').notNull().default(false),
    /** The head: latest published version. Advanced only by compare-and-swap. */
    headVersionId: text('head_version_id'),
    /** Per-collection salt for the private-set commitment (32 bytes hex). */
    privateSalt: text('private_salt').notNull(),
    /** Cumulative public file tree over every published version (file access checks). */
    publicFilesRoot: text('public_files_root'),
    summary: json<CollectionSummary>('summary'),
    /** Billing counters for the reference log (decision 18); rebuildable from version diffs. */
    refEvents: integer('ref_events').notNull().default(0),
    refBytes: integer('ref_bytes').notNull().default(0),
    /** Reconcile (billing/reconcile.ts): started, finished, and what it corrected. */
    reconcileStartedAt: ts('reconcile_started_at'),
    reconciledAt: ts('reconciled_at'),
    reconcileReport: json<ReconcileDiff[]>('reconcile_report'),
    deletedAt: ts('deleted_at'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at')
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex('collections_org_slug_uq').on(t.organizationId, t.slug),
    index('collections_public_updated_idx').on(t.public, t.updatedAt),
  ],
)

export const versions = sqliteTable(
  'versions',
  {
    id: id(),
    collectionId: text('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    /** 1, 2, 3… per collection: the order of publication. */
    seq: integer('seq').notNull(),
    semver: text('semver').notNull(),
    major: integer('major').notNull(),
    minor: integer('minor').notNull(),
    patch: integer('patch').notNull(),
    /** `ulv2:<hex>`; the root document is roots/<hex>.json in the blob store. */
    hash: text('hash').notNull(),
    baseSemver: text('base_semver'),
    message: text('message'),
    pushedBy: text('pushed_by'),
    appId: text('app_id'),
    actorId: text('actor_id'),
    signature: text('signature'),
    /** Cached from the root: totals over both sets, and per type. */
    recordCount: integer('record_count').notNull(),
    publicRecordCount: integer('public_record_count').notNull(),
    fileCount: integer('file_count').notNull(),
    totalBytes: integer('total_bytes').notNull(),
    /** What non-owners see: the public set's file count and record + file bytes. */
    publicFileCount: integer('public_file_count').notNull().default(0),
    publicTotalBytes: integer('public_total_bytes').notNull().default(0),
    typeCounts: json<Record<string, number>>('type_counts').notNull(),
    publicTypeCounts: json<Record<string, number>>('public_type_counts').notNull(),
    hasPrivate: bool('has_private').notNull().default(false),
    /**
     * Roots of the per-set file reference count trees (not protocol): how many of
     * the set's records reference each file, plus declared-file markers. They let
     * the next commit keep the file sets right in O(changes).
     */
    publicRefsRoot: text('public_refs_root'),
    privateRefsRoot: text('private_refs_root'),
    /** The reference log has this version's events (written by the refs.index job). */
    refsIndexed: bool('refs_indexed').notNull().default(false),
    /** Its events and their billable bytes, once indexed (null on rows indexed before 0011). */
    refEvents: integer('ref_events'),
    refBytes: integer('ref_bytes'),
    /** Last reconcile (billing/reconcile.ts), and what it corrected, if anything. */
    reconciledAt: ts('reconciled_at'),
    reconcileReport: json<ReconcileDiff[]>('reconcile_report'),
    /** Change counts against the previous version (drive semver and webhooks). */
    changes: json<{ added: number; removed: number; updated: number }>('changes'),
    createdAt: createdAt(),
    /**
     * When this instance published it. Unlike createdAt, never historical (migration
     * keeps the original time there). Storage cleanup re-marks from
     * versions published since its mark began; null on rows from before 0015.
     */
    publishedAt: ts('published_at'),
  },
  (t) => [
    uniqueIndex('versions_collection_seq_uq').on(t.collectionId, t.seq),
    uniqueIndex('versions_collection_semver_uq').on(t.collectionId, t.semver),
    index('versions_hash_idx').on(t.hash),
    index('versions_published_idx').on(t.publishedAt),
  ],
)

export const forks = sqliteTable('forks', {
  childCollectionId: text('child_collection_id')
    .primaryKey()
    .references(() => collections.id, { onDelete: 'cascade' }),
  parentCollectionId: text('parent_collection_id').notNull(),
  parentSeq: integer('parent_seq').notNull(),
  /** The sets the fork carried: a non-member's fork takes the public set only. */
  sets: text('sets', { enum: ['public', 'public+private'] })
    .notNull()
    .default('public'),
  createdAt: createdAt(),
})

// --- Schemas ---------------------------------------------------------------------

/** Known schemas. The body is schemas/<hash>.json in the blob store. */
export const schemas = sqliteTable('schemas', {
  hash: text('hash').primaryKey(),
  createdAt: createdAt(),
})

export const schemaLabels = sqliteTable(
  'schema_labels',
  {
    schemaHash: text('schema_hash').notNull(),
    label: text('label').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.schemaHash, t.label] }),
    index('schema_labels_label_idx').on(t.label),
  ],
)

/**
 * Where each schema is used: one row per run of versions in which a collection's
 * type uses the schema in a set. Opened when a type starts using a schema, closed
 * (`toSeq`) when it stops, so writes are O(changes). Rebuildable from the roots.
 */
export const schemaUsage = sqliteTable(
  'schema_usage',
  {
    schemaHash: text('schema_hash').notNull(),
    collectionId: text('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    typeSlug: text('type_slug').notNull(),
    set: text('set', { enum: ['public', 'private'] }).notNull(),
    fromSeq: integer('from_seq').notNull(),
    /** First seq that no longer uses it; null while current. */
    toSeq: integer('to_seq'),
  },
  (t) => [
    primaryKey({ columns: [t.collectionId, t.typeSlug, t.set, t.fromSeq] }),
    index('schema_usage_hash_idx').on(t.schemaHash),
  ],
)

// --- Storage locations and placements (edge-redesign.md, "Placements") -----------------

/**
 * Where repositories can live. The platform location's bucket and credentials
 * come from the deployment's bindings and secrets; customer locations carry
 * their own (encrypted with the platform key, never returned to clients).
 */
export const storageLocations = sqliteTable('storage_locations', {
  id: id(),
  /** Owning org; null for platform locations. */
  organizationId: text('organization_id').references(() => organization.id, {
    onDelete: 'cascade',
  }),
  kind: text('kind', { enum: ['platform', 's3'] }).notNull(),
  name: text('name').notNull(),
  endpoint: text('endpoint'),
  region: text('region'),
  bucket: text('bucket'),
  prefix: text('prefix').notNull().default(''),
  /** Encrypted JSON {accessKeyId, secretAccessKey}; null for platform locations. */
  credentials: text('credentials'),
  status: text('status', { enum: ['active', 'unverified', 'broken', 'disabled'] })
    .notNull()
    .default('unverified'),
  lastError: text('last_error'),
  verifiedAt: ts('verified_at'),
  /** Last check, passed or not; the cron sweep re-checks locations daily. */
  checkedAt: ts('checked_at'),
  createdAt: createdAt(),
})

/** A mirror copy in progress: version `seq`, stopped in tree `tree` after key `after`. */
export interface MirrorCursor {
  seq: number
  /** -1: schemas next; 0…n-1: that tree; n: files; n+1: finishing. */
  tree: number
  after: string | null
}

/** The id of the deployment's own location, seeded by the first migration. */
export const PLATFORM_LOCATION_ID = 'platform'

/**
 * Which locations hold a collection: exactly one primary (today always a
 * platform location) and any number of mirrors. A row with `organizationId` and
 * no `collectionId` is an org-wide default inherited by the org's collections.
 */
export const placements = sqliteTable(
  'placements',
  {
    id: id(),
    collectionId: text('collection_id').references(() => collections.id, { onDelete: 'cascade' }),
    organizationId: text('organization_id').references(() => organization.id, {
      onDelete: 'cascade',
    }),
    locationId: text('location_id')
      .notNull()
      .references(() => storageLocations.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['primary', 'mirror'] }).notNull(),
    sets: text('sets', { enum: ['public', 'public+private'] }).notNull(),
    state: text('state', { enum: ['active', 'backfilling', 'lagging', 'error', 'paused'] })
      .notNull()
      .default('active'),
    /** The last version (seq) fully copied to this location. */
    syncedSeq: integer('synced_seq').notNull().default(0),
    /** Where a copy of the next version stopped, to resume (locations/mirror.ts). */
    cursor: json<MirrorCursor>('cursor'),
    /** Held by the job copying to this placement: one copy at a time. */
    leaseUntil: ts('lease_until'),
    lastError: text('last_error'),
    updatedAt: ts('updated_at')
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex('placements_one_primary_uq')
      .on(t.collectionId)
      .where(sql`${t.role} = 'primary' AND ${t.collectionId} IS NOT NULL`),
    // One per target kind: exactly one of collection_id and organization_id is set, and
    // SQLite treats NULLs as distinct, so a single index over both would never fire.
    uniqueIndex('placements_collection_location_uq')
      .on(t.collectionId, t.locationId)
      .where(sql`${t.collectionId} IS NOT NULL`),
    uniqueIndex('placements_org_location_uq')
      .on(t.organizationId, t.locationId)
      .where(sql`${t.organizationId} IS NOT NULL`),
    index('placements_location_idx').on(t.locationId),
  ],
)

// --- Files -------------------------------------------------------------------------

export const files = sqliteTable('files', {
  hash: text('hash').primaryKey(),
  size: integer('size').notNull(),
  mimeType: text('mime_type').notNull(),
  storageKey: text('storage_key').notNull(),
  verifiedAt: ts('verified_at'),
  createdAt: createdAt(),
})

/** Pending direct uploads: verified by a job before the file row exists. */
export const fileUploads = sqliteTable(
  'file_uploads',
  {
    id: id(),
    collectionId: text('collection_id').notNull(),
    sessionId: text('session_id'),
    hash: text('hash').notNull(),
    size: integer('size').notNull(),
    mimeType: text('mime_type').notNull(),
    storageKey: text('storage_key').notNull(),
    multipartUploadId: text('multipart_upload_id'),
    status: text('status', { enum: ['pending', 'verifying', 'verified', 'failed'] })
      .notNull()
      .default('pending'),
    error: text('error'),
    createdAt: createdAt(),
  },
  (t) => [index('file_uploads_hash_idx').on(t.hash)],
)

/** Hashes that are never served (abuse). Checked on file redirects and record reads. */
export const denylist = sqliteTable('denylist', {
  hash: text('hash').primaryKey(),
  kind: text('kind', { enum: ['file', 'record'] }).notNull(),
  reason: text('reason').notNull(),
  createdAt: createdAt(),
})

/**
 * Reports of content that shouldn't be served (POST /api/abuse-reports). A
 * steward reviews them and blocks a hash through the denylist, or dismisses.
 */
export const abuseReports = sqliteTable(
  'abuse_reports',
  {
    id: id(),
    /** A file or record hash, when the reporter has one. */
    hash: text('hash'),
    /** The page or link the report is about. */
    url: text('url'),
    reason: text('reason').notNull(),
    /** How to reach the reporter (optional). */
    contact: text('contact'),
    /** Set when the reporter was signed in. */
    reporterId: text('reporter_id'),
    status: text('status', { enum: ['open', 'blocked', 'dismissed'] })
      .notNull()
      .default('open'),
    resolvedBy: text('resolved_by'),
    resolvedAt: ts('resolved_at'),
    createdAt: createdAt(),
  },
  (t) => [index('abuse_reports_status_idx').on(t.status, t.createdAt)],
)

// --- Push sessions -------------------------------------------------------------------

export type SessionStatus = 'open' | 'committing' | 'committed' | 'failed' | 'expired'

/**
 * A push in progress. Session inputs whose size the user controls (schemas,
 * metadata, the declared file list) are in the blob store under sessions/<id>/;
 * runs of uploaded manifest entries and records are sessions/<id>/runs/….
 */
export const pushSessions = sqliteTable(
  'push_sessions',
  {
    id: id(),
    collectionId: text('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    baseVersionId: text('base_version_id'),
    baseSemver: text('base_semver'),
    message: text('message'),
    appId: text('app_id'),
    actorId: text('actor_id'),
    stripUnknownFields: bool('strip_unknown_fields').notNull().default(false),
    recordsReceived: integer('records_received').notNull().default(0),
    runs: integer('runs').notNull().default(0),
    status: text('status').$type<SessionStatus>().notNull().default('open'),
    result: json<Record<string, unknown>>('result'),
    error: json<{ statusCode: number; error: string; [k: string]: unknown }>('error'),
    finalizeStartedAt: ts('finalize_started_at'),
    /** When storage cleanup deleted the session's objects (sessions/<id>/) and run rows. */
    cleanedAt: ts('cleaned_at'),
    /** A parallel commit's plan (push/parallel.ts): set once, when its units are queued. */
    commitPlan: text('commit_plan'),
    /** Held by the `commit.assemble` job while it runs (one assembler at a time). */
    assemblyLease: ts('assembly_lease'),
    createdAt: createdAt(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [
    index('push_sessions_collection_idx').on(t.collectionId),
    index('push_sessions_expires_idx').on(t.status, t.expiresAt),
    index('push_sessions_user_idx').on(t.userId, t.status),
  ],
)

/** One uploaded batch, stored as a sorted run object. */
export const pushRuns = sqliteTable(
  'push_runs',
  {
    sessionId: text('session_id')
      .notNull()
      .references(() => pushSessions.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    kind: text('kind', { enum: ['records', 'deletes'] }).notNull(),
    objectKey: text('object_key').notNull(),
    count: integer('count').notNull(),
    /** Run key range, `type\u0000id`, for planning commit units. */
    firstKey: text('first_key').notNull(),
    lastKey: text('last_key').notNull(),
    /** 0 for an upload; n for a run compacted from tier n − 1 (push/compact.ts). */
    tier: integer('tier').notNull().default(0),
    /** Claimed by the compaction writing run `mergingInto`; null while free. */
    mergingInto: integer('merging_into'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.seq] }),
    index('push_runs_tier_idx').on(t.sessionId, t.tier, t.mergingInto),
  ],
)

export type CommitUnitStatus = 'pending' | 'done' | 'failed' | 'superseded'

/**
 * One key range of one (set, type) tree in a parallel commit (push/parallel.ts).
 * A gap is a range with no changes, left to assembly. A unit whose `through`
 * was deleted ends `failed`; assembly merges it with the following ranges into
 * a new unit and marks the old ones `superseded`.
 */
export const commitUnits = sqliteTable(
  'commit_units',
  {
    id: id(),
    sessionId: text('session_id')
      .notNull()
      .references(() => pushSessions.id, { onDelete: 'cascade' }),
    planId: text('plan_id').notNull(),
    set: text('set', { enum: ['public', 'private'] }).notNull(),
    type: text('type').notNull(),
    /** Position in the tree's key order; a merged unit takes its first member's. */
    ord: integer('ord').notNull(),
    /** The range `(after, through]`; null is unbounded. */
    after: text('after'),
    through: text('through'),
    gap: bool('gap').notNull().default(false),
    status: text('status').$type<CommitUnitStatus>().notNull().default('pending'),
    /** The unit's run slices (the blocks it reads), in the internal area. */
    slicesKey: text('slices_key'),
    /** Leaves, change counts and file reference deltas, in the internal area. */
    outputKey: text('output_key'),
    /** When the unit was put on the queue; null while it waits for room (push/parallel.ts). */
    queuedAt: ts('queued_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('commit_units_plan_idx').on(t.planId, t.set, t.type, t.ord),
    index('commit_units_status_idx').on(t.sessionId, t.status, t.queuedAt),
  ],
)

/**
 * Usage per day, account, collection and metric (edge-redesign.md, Metering):
 * derived from the usage log (`usage/<day>/…` objects in the internal area), and
 * rebuildable from it (billing/usage.ts). `collection_id` is '' when none applies.
 */
export const usageRollups = sqliteTable(
  'usage_rollups',
  {
    day: text('day').notNull(),
    accountId: text('account_id').notNull(),
    collectionId: text('collection_id').notNull(),
    metric: text('metric').notNull(),
    amount: integer('amount').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.day, t.accountId, t.collectionId, t.metric] }),
    index('usage_rollups_account_idx').on(t.accountId, t.day),
  ],
)

/**
 * A deleted collection (edge-redesign.md, Provenance and Metering): its id, owner
 * and slug at deletion, and its counters as they stood, which the deletion zeroes
 * along with the rows. Reference-log compaction drops the events of a tombstoned
 * id that no collection holds any more; restoring the collection lifts it.
 */
export const collectionTombstones = sqliteTable('collection_tombstones', {
  collectionId: text('collection_id').primaryKey(),
  organizationId: text('organization_id').notNull(),
  slug: text('slug').notNull(),
  refEvents: integer('ref_events').notNull(),
  refBytes: integer('ref_bytes').notNull(),
  /** Versions and their logical bytes at deletion (the version rows go with the collection). */
  versions: integer('versions').notNull(),
  totalBytes: integer('total_bytes').notNull(),
  deletedBy: text('deleted_by'),
  deletedAt: ts('deleted_at')
    .notNull()
    .$defaultFn(() => new Date()),
})

// --- Reference log (provenance; edge-redesign.md "Provenance: the reference log") --------

/**
 * The manifest of the reference log: one row per immutable segment in the
 * platform's internal area. A segment holds events sorted by hash; segments of
 * one run cover disjoint hash ranges. Size-tiered compaction merges runs of a
 * tier into one run of the next, so a query reads O(log n) runs.
 */
export const refSegments = sqliteTable(
  'ref_segments',
  {
    id: id(),
    runId: text('run_id').notNull(),
    tier: integer('tier').notNull(),
    firstHash: text('first_hash').notNull(),
    lastHash: text('last_hash').notNull(),
    count: integer('count').notNull(),
    bytes: integer('bytes').notNull(),
    /** pending: written by an unfinished compaction; live: queried; retired: replaced. */
    state: text('state', { enum: ['pending', 'live', 'retired'] })
      .notNull()
      .default('live'),
    createdAt: createdAt(),
  },
  (t) => [
    index('ref_segments_range_idx').on(t.state, t.firstHash, t.lastHash),
    index('ref_segments_run_idx').on(t.runId),
    index('ref_segments_tier_idx').on(t.tier),
  ],
)

/** A compaction merging runs of one tier, split into hash-range parts run as jobs. */
export const refCompactions = sqliteTable('ref_compactions', {
  id: id(),
  tier: integer('tier').notNull(),
  inputRuns: json<string[]>('input_runs').notNull(),
  outputRun: text('output_run').notNull(),
  parts: integer('parts').notNull(),
  /** Hex prefix length of each part's hash range. */
  prefixLength: integer('prefix_length').notNull(),
  status: text('status', { enum: ['running', 'done'] })
    .notNull()
    .default('running'),
  createdAt: createdAt(),
})

export const refCompactionParts = sqliteTable(
  'ref_compaction_parts',
  {
    compactionId: text('compaction_id').notNull(),
    part: integer('part').notNull(),
  },
  (t) => [primaryKey({ columns: [t.compactionId, t.part] })],
)

// --- Jobs (Node only; Cloudflare uses Queues) ----------------------------------------

export const jobs = sqliteTable(
  'jobs',
  {
    id: id(),
    type: text('type').notNull(),
    payload: json<Record<string, unknown>>('payload').notNull(),
    status: text('status', { enum: ['queued', 'running', 'done', 'failed'] })
      .notNull()
      .default('queued'),
    attempts: integer('attempts').notNull().default(0),
    runAt: ts('run_at').notNull(),
    lockedUntil: ts('locked_until'),
    error: text('error'),
    createdAt: createdAt(),
  },
  (t) => [index('jobs_ready_idx').on(t.status, t.runAt)],
)

// --- Webhooks --------------------------------------------------------------------------

export const collectionWebhooks = sqliteTable(
  'collection_webhooks',
  {
    id: id(),
    collectionId: text('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    bumpFilter: json<('major' | 'minor' | 'patch')[]>('bump_filter')
      .notNull()
      .$defaultFn(() => ['major', 'minor', 'patch']),
    secret: text('secret').notNull(),
    enabled: bool('enabled').notNull().default(true),
    createdBy: text('created_by'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at')
      .notNull()
      .$defaultFn(() => new Date()),
    lastDeliveryAt: ts('last_delivery_at'),
  },
  (t) => [index('collection_webhooks_collection_idx').on(t.collectionId)],
)

export const webhookDeliveries = sqliteTable(
  'webhook_deliveries',
  {
    id: id(),
    webhookId: text('webhook_id')
      .notNull()
      .references(() => collectionWebhooks.id, { onDelete: 'cascade' }),
    collectionId: text('collection_id').notNull(),
    versionId: text('version_id'),
    semver: text('semver'),
    bumpType: text('bump_type', { enum: ['major', 'minor', 'patch'] }).notNull(),
    event: text('event').notNull().default('version.created'),
    payload: json<Record<string, unknown>>('payload').notNull(),
    status: text('status', { enum: ['pending', 'success', 'failed'] })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    responseCode: integer('response_code'),
    error: text('error'),
    durationMs: integer('duration_ms'),
    nextAttemptAt: ts('next_attempt_at'),
    createdAt: createdAt(),
    deliveredAt: ts('delivered_at'),
  },
  (t) => [
    index('webhook_deliveries_webhook_idx').on(t.webhookId, t.createdAt),
    index('webhook_deliveries_pending_idx').on(t.status, t.nextAttemptAt),
  ],
)

// --- ARKs, settings ------------------------------------------------------------------------

export const arkShoulders = sqliteTable('ark_shoulders', {
  id: id(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' }),
  shoulder: text('shoulder').notNull().unique(),
  createdAt: createdAt(),
})

export const arkCollections = sqliteTable('ark_collections', {
  collectionId: text('collection_id')
    .primaryKey()
    .references(() => collections.id, { onDelete: 'cascade' }),
  arkId: text('ark_id').notNull().unique(),
  enabled: bool('enabled').notNull().default(true),
  customUrl: text('custom_url'),
  createdAt: createdAt(),
})

export const arkRecordTypes = sqliteTable(
  'ark_record_types',
  {
    collectionId: text('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    recordType: text('record_type').notNull(),
    redirectUrlField: text('redirect_url_field').notNull(),
  },
  (t) => [primaryKey({ columns: [t.collectionId, t.recordType] })],
)

export const instanceSettings = sqliteTable('instance_settings', {
  key: text('key').primaryKey(),
  value: json<unknown>('value').notNull(),
  updatedAt: ts('updated_at')
    .notNull()
    .$defaultFn(() => new Date()),
})

// --- Storage cleanup (planning: v2-storage-cleanup.md) -------------------------------

/**
 * The write fence: one row. A write phase that may reuse objects already in the
 * bucket (writers skip keys that exist) reads `epoch` before it writes, and the
 * statement that makes its objects reachable succeeds only if the epoch is
 * unchanged and no deletion window is open (cleanup/fence.ts). The sweep bumps
 * the epoch when it opens a window and again when it closes it.
 */
export const storageFence = sqliteTable('storage_fence', {
  id: integer('id').primaryKey(),
  epoch: integer('epoch').notNull().default(0),
  /** A deletion window is open until then; writers wait for it. */
  windowUntil: ts('window_until'),
  windowRunId: text('window_run_id'),
})

export type CleanupStep = 'internal' | 'mark' | 'sweep'
export type CleanupStatus = 'queued' | 'running' | 'waiting' | 'done' | 'failed'

/** Objects and bytes, deleted (or, in a dry run, that would be). */
export interface CleanupCount {
  objects: number
  bytes: number
}

export interface CleanupStats {
  /** By kind: nodes, bodies, records, roots, private, files, collections, sessions, uploads, … */
  deleted: Record<string, CleanupCount>
  /** Keys listed (sweep) or rows looked at (internal). */
  scanned: number
  /** Listed keys of a shape the sweep doesn't delete. */
  unknown: number
  /** Hashes in the mark (mark, and a sweep's re-marks). */
  marked: number
  versions: number
  collections: number
  /** Database rows removed alongside (files, push runs). */
  rows: number
  /** Deletion windows a sweep opened. */
  windows: number
  /** Problems that didn't stop the run, first few. */
  problems: string[]
}

/** One run of a cleanup step: what the admin Cleanup page lists. */
export const cleanupRuns = sqliteTable(
  'cleanup_runs',
  {
    id: id(),
    step: text('step').$type<CleanupStep>().notNull(),
    status: text('status').$type<CleanupStatus>().notNull().default('queued'),
    trigger: text('trigger', { enum: ['manual', 'schedule'] }).notNull(),
    dryRun: bool('dry_run').notNull().default(false),
    requestedBy: text('requested_by'),
    /** A sweep's mark (a done mark run). */
    markRunId: text('mark_run_id'),
    /** Progress carried between the run's jobs. */
    state: json<Record<string, unknown>>('state'),
    /** The job that may run next; a duplicate or stale delivery carries another. */
    seq: integer('seq').notNull().default(0),
    /** Held while a job of the run works, so a duplicate delivery waits. */
    lease: ts('lease'),
    stats: json<CleanupStats>('stats'),
    /** Why it stopped (failed), or what it is waiting for (waiting). */
    error: text('error'),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    updatedAt: ts('updated_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('cleanup_runs_created_idx').on(t.createdAt),
    index('cleanup_runs_step_idx').on(t.step, t.status),
  ],
)
