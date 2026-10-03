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
    /** Format 1 hashes of migrated versions (`private:…`, `public:…`). */
    legacyHash: text('legacy_hash'),
    legacyPublicHash: text('legacy_public_hash'),
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
    typeCounts: json<Record<string, number>>('type_counts').notNull(),
    publicTypeCounts: json<Record<string, number>>('public_type_counts').notNull(),
    hasPrivate: bool('has_private').notNull().default(false),
    /** Change counts against the previous version (drive semver and webhooks). */
    changes: json<{ added: number; removed: number; updated: number }>('changes'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('versions_collection_seq_uq').on(t.collectionId, t.seq),
    uniqueIndex('versions_collection_semver_uq').on(t.collectionId, t.semver),
    index('versions_hash_idx').on(t.hash),
    index('versions_legacy_hash_idx').on(t.legacyHash),
    index('versions_legacy_public_hash_idx').on(t.legacyPublicHash),
  ],
)

export const forks = sqliteTable('forks', {
  childCollectionId: text('child_collection_id')
    .primaryKey()
    .references(() => collections.id, { onDelete: 'cascade' }),
  parentCollectionId: text('parent_collection_id').notNull(),
  parentSeq: integer('parent_seq').notNull(),
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

/** Format 1 → format 2 aliases for records and schemas re-hashed by JCS. */
export const legacyHashes = sqliteTable('legacy_hashes', {
  legacyHash: text('legacy_hash').primaryKey(),
  kind: text('kind', { enum: ['record', 'schema'] }).notNull(),
  hash: text('hash').notNull(),
})

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
  permissions: text('permissions', { enum: ['write', 'read_write'] }).notNull(),
  status: text('status', { enum: ['active', 'unverified', 'broken', 'disabled'] })
    .notNull()
    .default('unverified'),
  lastError: text('last_error'),
  verifiedAt: ts('verified_at'),
  createdAt: createdAt(),
})

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
    lastError: text('last_error'),
    updatedAt: ts('updated_at')
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex('placements_one_primary_uq')
      .on(t.collectionId)
      .where(sql`${t.role} = 'primary' AND ${t.collectionId} IS NOT NULL`),
    uniqueIndex('placements_target_location_uq').on(t.collectionId, t.organizationId, t.locationId),
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
    /** negotiate: full-snapshot compatibility API; delta: upserts and deletes against a base. */
    kind: text('kind', { enum: ['negotiate', 'delta'] }).notNull(),
    baseVersionId: text('base_version_id'),
    baseSemver: text('base_semver'),
    message: text('message'),
    appId: text('app_id'),
    actorId: text('actor_id'),
    stripUnknownFields: bool('strip_unknown_fields').notNull().default(false),
    manifestExpected: integer('manifest_expected'),
    manifestReceived: integer('manifest_received').notNull().default(0),
    manifestNeeded: integer('manifest_needed').notNull().default(0),
    recordsReceived: integer('records_received').notNull().default(0),
    runs: integer('runs').notNull().default(0),
    status: text('status').$type<SessionStatus>().notNull().default('open'),
    result: json<Record<string, unknown>>('result'),
    error: json<{ statusCode: number; error: string; [k: string]: unknown }>('error'),
    finalizeStartedAt: ts('finalize_started_at'),
    createdAt: createdAt(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [
    index('push_sessions_collection_idx').on(t.collectionId),
    index('push_sessions_expires_idx').on(t.status, t.expiresAt),
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
    kind: text('kind', { enum: ['manifest', 'records', 'deletes'] }).notNull(),
    objectKey: text('object_key').notNull(),
    count: integer('count').notNull(),
    /** Run key range, `type\u0000id`, for planning commit units. */
    firstKey: text('first_key').notNull(),
    lastKey: text('last_key').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.seq] })],
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
    bumpFilter: text('bump_filter', { enum: ['all', 'major', 'minor', 'patch'] })
      .notNull()
      .default('all'),
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

// --- ARKs, comments, settings ----------------------------------------------------------------

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

export const pageComments = sqliteTable(
  'page_comments',
  {
    id: id(),
    page: text('page').notNull(),
    anchor: text('anchor').notNull(),
    quote: text('quote'),
    quoteContext: json<{ prefix: string; suffix: string }>('quote_context'),
    parentId: text('parent_id'),
    userId: text('user_id').notNull(),
    body: text('body').notNull(),
    approvedAt: ts('approved_at'),
    approvedBy: text('approved_by'),
    status: text('status', { enum: ['open', 'answered', 'decided', 'changed'] })
      .notNull()
      .default('open'),
    resolutionNote: text('resolution_note'),
    createdAt: createdAt(),
    editedAt: ts('edited_at'),
    deletedAt: ts('deleted_at'),
  },
  (t) => [index('page_comments_page_idx').on(t.page)],
)

export const instanceSettings = sqliteTable('instance_settings', {
  key: text('key').primaryKey(),
  value: json<unknown>('value').notNull(),
  updatedAt: ts('updated_at')
    .notNull()
    .$defaultFn(() => new Date()),
})
