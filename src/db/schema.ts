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
  uuid,
} from 'drizzle-orm/pg-core'

// --- Accounts ---

export const accounts = pgTable('accounts', {
  // For user accounts: id = KF Auth user.id (set on OIDC callback).
  // For org accounts: id = auto-generated UUID.
  id: uuid('id').defaultRandom().primaryKey(),
  slug: text('slug').unique().notNull(),
  type: text('type', { enum: ['user', 'org'] }).notNull(),
  // displayName/avatarUrl: stored for org accounts only.
  // For user accounts, name + avatar are fetched from KF Auth on demand.
  displayName: text('display_name'),
  bio: text('bio'),
  website: text('website'),
  location: text('location'),
  avatarUrl: text('avatar_url'),
  notificationPrefs: jsonb('notification_prefs'),
  arkNaan: text('ark_naan'),
  // Links this account to a KF Organization. NOT unique — multiple UL orgs can belong to the same KF org.
  kfOrgId: text('kf_org_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const orgMemberships = pgTable(
  'org_memberships',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['owner', 'admin', 'member'] }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] })],
)

export const sessions = pgTable('sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  userAgent: text('user_agent'),
  ipAddress: text('ip_address'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
})

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  collectionId: uuid('collection_id').references(() => collections.id, { onDelete: 'cascade' }),
  scope: text('scope', { enum: ['read', 'write', 'admin'] }).notNull(),
  keyHash: text('key_hash').notNull(),
  keyPrefix: text('key_prefix'),
  label: text('label').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
})

// --- Collections ---

export const collections = pgTable(
  'collections',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    public: boolean('public').default(false).notNull(),
    forkedFrom: uuid('forked_from').references((): any => collections.id),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique().on(t.accountId, t.slug), index('collections_account_id_idx').on(t.accountId)],
)

// --- Versions ---

export const versions = pgTable(
  'versions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    semver: text('semver').notNull(),
    hash: text('hash').notNull(),
    publicHash: text('public_hash'),
    baseNumber: integer('base_number'),
    message: text('message'),
    readme: text('readme'),
    pushedBy: uuid('pushed_by').references(() => accounts.id),
    appId: text('app_id'),
    actorId: text('actor_id'),
    signature: text('signature'),
    recordCount: integer('record_count').notNull(),
    fileCount: integer('file_count').notNull(),
    totalBytes: bigint('total_bytes', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique().on(t.collectionId, t.number), unique().on(t.collectionId, t.hash)],
)

// --- Records ---

export const records = pgTable(
  'records',
  {
    versionId: bigint('version_id', { mode: 'number' })
      .notNull()
      .references(() => versions.id, { onDelete: 'cascade' }),
    recordId: text('record_id').notNull(),
    type: text('type').notNull(),
    data: jsonb('data').notNull(),
    private: boolean('private').default(false).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.versionId, t.recordId] }),
    index('records_version_id_type_idx').on(t.versionId, t.type),
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

// --- Org Invitations ---

export const orgInvitations = pgTable('org_invitations', {
  id: uuid('id').defaultRandom().primaryKey(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: text('role', { enum: ['owner', 'admin', 'member'] }).notNull(),
  invitedBy: uuid('invited_by')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

// --- Upload Sessions (chunked push) ---

export const uploadSessions = pgTable('upload_sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  collectionId: uuid('collection_id')
    .notNull()
    .references(() => collections.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  baseVersion: integer('base_version'),
  message: text('message'),
  readme: text('readme'),
  appId: text('app_id'),
  actorId: text('actor_id'),
  schemas: jsonb('schemas'),
  status: text('status', { enum: ['open', 'finalizing', 'completed', 'failed', 'expired'] })
    .notNull()
    .default('open'),
  recordCount: integer('record_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
})

export const uploadRecords = pgTable(
  'upload_records',
  {
    sessionId: uuid('session_id')
      .notNull()
      .references(() => uploadSessions.id, { onDelete: 'cascade' }),
    recordId: text('record_id').notNull(),
    type: text('type'),
    data: jsonb('data'),
    private: boolean('private').default(false),
    operation: text('operation', { enum: ['add', 'update', 'remove'] }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.recordId] })],
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
  accountId: uuid('account_id')
    .notNull()
    .unique()
    .references(() => accounts.id, { onDelete: 'cascade' }),
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

// --- Better-auth tables (session management) ---

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const session = pgTable('session', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const oauthAccount = pgTable('oauth_account', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope'),
  idToken: text('id_token'),
  password: text('password'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
