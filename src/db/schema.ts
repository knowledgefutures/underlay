import { sql } from 'drizzle-orm'
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

// --- Better-auth managed tables ---

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').default(false).notNull(),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
})

export const session = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    activeOrganizationId: text('active_organization_id'),
  },
  (t) => [index('session_user_id_idx').on(t.userId)],
)

export const account = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [index('account_user_id_idx').on(t.userId)],
)

export const verification = pgTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [index('verification_identifier_idx').on(t.identifier)],
)

// --- Organization (better-auth managed + custom fields) ---

export const organization = pgTable(
  'organization',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    logo: text('logo'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    metadata: text('metadata'),
    bio: text('bio'),
    website: text('website'),
    avatarUrl: text('avatar_url'),
    arkNaan: text('ark_naan'),
    kfOrgId: text('kf_org_id'),
    isDefault: boolean('is_default').default(false),
  },
  (t) => [uniqueIndex('organization_slug_uidx').on(t.slug)],
)

export const member = pgTable(
  'member',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: text('role').default('member').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('member_organization_id_idx').on(t.organizationId),
    index('member_user_id_idx').on(t.userId),
  ],
)

export const invitation = pgTable(
  'invitation',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role'),
    status: text('status').default('pending').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    inviterId: text('inviter_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (t) => [
    index('invitation_organization_id_idx').on(t.organizationId),
    index('invitation_email_idx').on(t.email),
  ],
)

// --- API Keys (better-auth managed) ---

export const apikey = pgTable(
  'apikey',
  {
    id: text('id').primaryKey(),
    configId: text('config_id').default('default').notNull(),
    name: text('name'),
    start: text('start'),
    referenceId: text('reference_id').notNull(),
    prefix: text('prefix'),
    key: text('key').notNull(),
    refillInterval: integer('refill_interval'),
    refillAmount: integer('refill_amount'),
    lastRefillAt: timestamp('last_refill_at', { withTimezone: true }),
    enabled: boolean('enabled').default(true),
    rateLimitEnabled: boolean('rate_limit_enabled').default(true),
    rateLimitTimeWindow: integer('rate_limit_time_window').default(86400000),
    rateLimitMax: integer('rate_limit_max').default(10),
    requestCount: integer('request_count').default(0),
    remaining: integer('remaining'),
    lastRequest: timestamp('last_request', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    permissions: text('permissions'),
    metadata: text('metadata'),
  },
  (t) => [
    index('apikey_config_id_idx').on(t.configId),
    index('apikey_reference_id_idx').on(t.referenceId),
    index('apikey_key_idx').on(t.key),
  ],
)

// --- Collections ---

export const collections = pgTable(
  'collections',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    public: boolean('public').default(false).notNull(),
    forkedFrom: uuid('forked_from').references((): any => collections.id),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique().on(t.organizationId, t.slug),
    index('collections_organization_id_idx').on(t.organizationId),
  ],
)

// --- Versions ---

export const versions = pgTable(
  'versions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    semver: text('semver').notNull(),
    major: integer('major').notNull(),
    minor: integer('minor').notNull(),
    patch: integer('patch').notNull(),
    hash: text('hash').notNull(),
    publicHash: text('public_hash'),
    baseSemver: text('base_semver'),
    message: text('message'),
    metadata: jsonb('metadata'),
    pushedBy: text('pushed_by').references(() => user.id),
    appId: text('app_id'),
    actorId: text('actor_id'),
    signature: text('signature'),
    recordCount: integer('record_count').notNull(),
    fileCount: integer('file_count').notNull(),
    // { [type]: count } for this version's record set, computed once at commit.
    // Avoids a COUNT(*) GROUP BY over version_records on every collection page
    // view and gives `?type=` listings an accurate pagination.total. NULL on
    // versions written before this column existed — callers fall back to a
    // count query.
    typeCounts: jsonb('type_counts').$type<Record<string, number>>(),
    totalBytes: bigint('total_bytes', { mode: 'number' }).notNull(),
    status: text('status').notNull().default('ready'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique().on(t.collectionId, t.semver),
    unique().on(t.collectionId, t.hash),
    index('versions_ordering_idx').on(t.collectionId, t.major, t.minor, t.patch),
  ],
)

// --- Records (globally deduplicated, content-addressed) ---
//
// PURE CONTENT. A record object is byte-identical content shared across every
// collection that pushes it, so it carries no privacy: privacy is contextual
// (a per-version property — see version_records.private), never intrinsic to the
// bytes. A `private` flag once lived here and was the source of cross-collection
// privacy coupling; it has been removed.
export const recordObjects = pgTable(
  'record_objects',
  {
    hash: text('hash').primaryKey(),
    recordId: text('record_id').notNull(),
    type: text('type').notNull(),
    data: jsonb('data').notNull(),
    size: integer('size').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('record_objects_record_id_idx').on(t.recordId)],
)

export const versionRecords = pgTable(
  'version_records',
  {
    versionId: bigint('version_id', { mode: 'number' })
      .notNull()
      .references(() => versions.id, { onDelete: 'cascade' }),
    recordHash: text('record_hash')
      .notNull()
      .references(() => recordObjects.hash),
    // Public content-address of the record under this version's schema binding:
    // sha256 of {id, type, data-with-private-fields-stripped}. NULL when it
    // equals record_hash (i.e. the type has no private fields), which is the
    // common case — only private-field bindings pay the storage cost.
    publicRecordHash: text('public_record_hash'),
    // Record-level privacy is a per-VERSION property (this collection's version
    // declares this record private), NOT a property of the globally-shared,
    // content-addressed record object. Set once at commit from the push's own
    // intent (negotiate_session_manifest.private). This is the SOLE record-level
    // privacy signal — the content object carries none — which is what lets two
    // collections hold byte-identical content at different privacy levels and
    // makes public_hash a pure function of the authored version.
    private: boolean('private').default(false).notNull(),
    // Denormalized from record_objects. Records are immutable and
    // content-addressed, so these can never drift from the row they were copied
    // from. Carrying them here is what lets record listing, `?type=` filtering
    // and the diff/delta set operations run as index-only scans over
    // version_records instead of joining every candidate row through
    // record_objects just to order or filter it.
    recordId: text('record_id').notNull(),
    type: text('type').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.versionId, t.recordHash] }),
    index('version_records_record_hash_idx').on(t.recordHash),
    index('version_records_public_record_hash_idx')
      .on(t.publicRecordHash)
      .where(sql`public_record_hash IS NOT NULL`),
    // Drives keyset record listing and the added/removed/updated anti- and
    // semi-joins between two versions.
    index('version_records_version_record_idx').on(t.versionId, t.recordId),
    // Same, for `?type=`-filtered listings.
    index('version_records_version_type_record_idx').on(t.versionId, t.type, t.recordId),
  ],
)

// --- Files ---

export const files = pgTable('files', {
  hash: text('hash').primaryKey(),
  size: bigint('size', { mode: 'number' }).notNull(),
  mimeType: text('mime_type').notNull(),
  storageKey: text('storage_key').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const versionFiles = pgTable(
  'version_files',
  {
    versionId: bigint('version_id', { mode: 'number' })
      .notNull()
      .references(() => versions.id, { onDelete: 'cascade' }),
    fileHash: text('file_hash')
      .notNull()
      .references(() => files.hash),
  },
  (t) => [
    primaryKey({ columns: [t.versionId, t.fileHash] }),
    index('version_files_file_hash_idx').on(t.fileHash),
  ],
)

// --- Schemas (globally deduplicated, content-addressed) ---

export const schemas = pgTable('schemas', {
  id: uuid('id').defaultRandom().primaryKey(),
  schema: jsonb('schema').notNull(),
  schemaHash: text('schema_hash').unique().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const versionSchemas = pgTable(
  'version_schemas',
  {
    versionId: bigint('version_id', { mode: 'number' })
      .notNull()
      .references(() => versions.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    schemaId: uuid('schema_id')
      .notNull()
      .references(() => schemas.id),
  },
  (t) => [
    primaryKey({ columns: [t.versionId, t.slug] }),
    index('version_schemas_schema_id_idx').on(t.schemaId),
  ],
)

// --- Schema Labels (post-hoc naming of content-addressed schemas) ---

export const schemaLabels = pgTable(
  'schema_labels',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    schemaId: uuid('schema_id')
      .notNull()
      .references(() => schemas.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique().on(t.schemaId, t.label), index('schema_labels_label_idx').on(t.label)],
)

// --- Negotiate Sessions (push protocol) ---

export const negotiateSessions = pgTable('negotiate_sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  collectionId: uuid('collection_id')
    .notNull()
    .references(() => collections.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  baseSemver: text('base_semver'),
  schemas: jsonb('schemas').notNull(),
  fileHashes: jsonb('file_hashes').$type<string[]>().notNull().default([]),
  neededFiles: jsonb('needed_files').$type<string[]>().notNull().default([]),
  message: text('message'),
  metadata: jsonb('metadata'),
  appId: text('app_id'),
  actorId: text('actor_id'),
  stripUnknownFields: boolean('strip_unknown_fields').notNull().default(false),
  // Set when the manifest is uploaded in chunks instead of inline: how many
  // distinct record hashes the client says it will send. Commit refuses to build
  // a version until exactly that many have arrived, so a client that dies
  // partway through the upload cannot silently produce a truncated version.
  // NULL for the inline path, where the manifest arrives atomically.
  manifestExpected: integer('manifest_expected'),
  // 'committing' is the async-finalize state: the request has returned 202 and
  // a background task is building the version. It ends at 'committed' or
  // 'failed', both of which are reported through the session-status endpoint.
  status: text('status', {
    enum: ['open', 'committing', 'committed', 'failed', 'expired'],
  })
    .notNull()
    .default('open'),
  // Outcome of an async finalize, so a client that polls after the fact gets the
  // same answer the synchronous path would have returned inline.
  result: jsonb('result').$type<{
    semver: string
    hash: string
    recordCount: number
    fileCount: number
  }>(),
  error: jsonb('error').$type<{ statusCode: number; error: string; [k: string]: unknown }>(),
  // When the background finalize started, so a task killed by a restart can be
  // told apart from one still running.
  finalizeStartedAt: timestamp('finalize_started_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
})

export const negotiateSessionManifest = pgTable(
  'negotiate_session_manifest',
  {
    sessionId: uuid('session_id')
      .notNull()
      .references(() => negotiateSessions.id, { onDelete: 'cascade' }),
    recordId: text('record_id').notNull(),
    type: text('type').notNull(),
    hash: text('hash').notNull(),
    private: boolean('private').notNull().default(false),
    needed: boolean('needed').notNull().default(true),
    // Set when the record arrives through the records endpoint, which validates
    // it against this session's schemas. Commit uses this to skip re-running AJV
    // over records that were validated minutes ago — for a first push that is
    // every record, and revalidation was the single largest cost in the commit.
    submitted: boolean('submitted').notNull().default(false),
    // Commit scratch space, written back per record instead of accumulated in
    // arrays that grow with collection size.
    //
    // Both hash columns mean "unchanged" when NULL, which is the overwhelmingly
    // common case: finalHash is only set when strip_unknown_fields rewrote the
    // record, and publicHash only when privacy filtering changed its content. A
    // push with no private fields and no stripping — the normal case, and the
    // arXiv case — writes neither, so the walk performs no UPDATEs at all.
    //
    // Whether a record appears in the public view is deliberately *not* stored:
    // it is derivable from the private flags and the type, so materializing it
    // would cost a full UPDATE pass over every row of every push.
    finalHash: text('final_hash'),
    publicHash: text('public_hash'),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.hash] }),
    index('nsm_session_needed_idx').on(t.sessionId, t.needed),
  ],
)

// --- Sync Runs (mirror mode) ---

export const syncRuns = pgTable('sync_runs', {
  id: uuid('id').defaultRandom().primaryKey(),
  trigger: text('trigger', { enum: ['manual', 'cron'] }).notNull(),
  status: text('status', { enum: ['running', 'completed', 'failed'] }).notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  collectionsSync: integer('collections_synced').default(0).notNull(),
  collectionsCreated: integer('collections_created').default(0).notNull(),
  collectionsFailed: integer('collections_failed').default(0).notNull(),
  versionsPulled: integer('versions_pulled').default(0).notNull(),
  filesDownloaded: integer('files_downloaded').default(0).notNull(),
  filesSkipped: integer('files_skipped').default(0).notNull(),
  errors: jsonb('errors').$type<string[]>().default([]).notNull(),
  logs: jsonb('logs').$type<string[]>().default([]).notNull(),
})

// --- ARK Identifiers ---

export const arkShoulders = pgTable('ark_shoulders', {
  id: uuid('id').defaultRandom().primaryKey(),
  organizationId: text('organization_id')
    .notNull()
    .unique()
    .references(() => organization.id, { onDelete: 'cascade' }),
  shoulder: text('shoulder').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const arkCollections = pgTable('ark_collections', {
  collectionId: uuid('collection_id')
    .notNull()
    .primaryKey()
    .references(() => collections.id, { onDelete: 'cascade' }),
  arkId: text('ark_id').notNull().unique(),
  enabled: boolean('enabled').notNull().default(true),
  customUrl: text('custom_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

// --- Page Comments (living RFC discussion) ---

export const pageComments = pgTable(
  'page_comments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    page: text('page').notNull(),
    anchor: text('anchor').notNull(),
    quote: text('quote'),
    quoteContext: jsonb('quote_context').$type<{ prefix: string; suffix: string }>(),
    parentId: uuid('parent_id'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvedBy: text('approved_by'),
    status: text('status', { enum: ['open', 'answered', 'decided', 'changed'] })
      .notNull()
      .default('open'),
    resolutionNote: text('resolution_note'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('page_comments_page_anchor_idx').on(t.page, t.anchor),
    index('page_comments_user_id_idx').on(t.userId),
  ],
)

export const arkRecordTypes = pgTable(
  'ark_record_types',
  {
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    recordType: text('record_type').notNull(),
    redirectUrlField: text('redirect_url_field').notNull(),
  },
  (t) => [primaryKey({ columns: [t.collectionId, t.recordType] })],
)

// --- Instance-wide settings (key-value) ---

export const instanceSettings = pgTable('instance_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

// --- Webhooks (fire on new version) ---

export const collectionWebhooks = pgTable(
  'collection_webhooks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    // Which version bump types trigger this webhook — a subset of major/minor/patch.
    // All three = fire on every version.
    bumpFilter: text('bump_filter')
      .array()
      .notNull()
      .default(sql`'{major,minor,patch}'::text[]`),
    secret: text('secret').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdBy: text('created_by').references(() => user.id),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    lastDeliveryAt: timestamp('last_delivery_at', { withTimezone: true }),
  },
  (t) => [index('collection_webhooks_collection_id_idx').on(t.collectionId)],
)

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    webhookId: uuid('webhook_id')
      .notNull()
      .references(() => collectionWebhooks.id, { onDelete: 'cascade' }),
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    // The version this delivery is about. NULL-able so the log survives a version
    // being pruned; semver is denormalized for display.
    versionId: bigint('version_id', { mode: 'number' }).references(() => versions.id, {
      onDelete: 'set null',
    }),
    semver: text('semver'),
    bumpType: text('bump_type', { enum: ['major', 'minor', 'patch'] }).notNull(),
    event: text('event').notNull().default('version.created'),
    // The core payload (without the per-attempt delivery envelope), sent as the request body.
    payload: jsonb('payload').notNull(),
    status: text('status', { enum: ['pending', 'success', 'failed'] })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    responseCode: integer('response_code'),
    error: text('error'),
    durationMs: integer('duration_ms'),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  },
  (t) => [
    index('webhook_deliveries_webhook_id_idx').on(t.webhookId),
    index('webhook_deliveries_collection_id_idx').on(t.collectionId),
    index('webhook_deliveries_created_at_idx').on(t.createdAt),
    // Retry sweep scans for due, non-terminal deliveries
    index('webhook_deliveries_sweep_idx').on(t.status, t.nextAttemptAt),
  ],
)
