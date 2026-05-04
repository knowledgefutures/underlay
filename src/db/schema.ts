import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  bigint,
  integer,
  jsonb,
  bigserial,
  primaryKey,
  unique,
  index,
} from "drizzle-orm/pg-core";

// --- Accounts ---

export const accounts = pgTable("accounts", {
  id: uuid("id").defaultRandom().primaryKey(),
  slug: text("slug").unique().notNull(),
  type: text("type", { enum: ["user", "org"] }).notNull(),
  displayName: text("display_name").notNull(),
  email: text("email"),
  passwordHash: text("password_hash"),
  bio: text("bio"),
  website: text("website"),
  location: text("location"),
  avatarUrl: text("avatar_url"),
  emailVerified: boolean("email_verified").default(false).notNull(),
  notificationPrefs: jsonb("notification_prefs"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const orgMemberships = pgTable(
  "org_memberships",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "admin", "member"] }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] })],
);

export const sessions = pgTable("sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  userAgent: text("user_agent"),
  ipAddress: text("ip_address"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const apiKeys = pgTable("api_keys", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  collectionId: uuid("collection_id").references(() => collections.id, { onDelete: "cascade" }),
  scope: text("scope", { enum: ["read", "write", "admin"] }).notNull(),
  keyHash: text("key_hash").notNull(),
  keyPrefix: text("key_prefix"),
  label: text("label").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
});

// --- Collections ---

export const collections = pgTable(
  "collections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    public: boolean("public").default(false).notNull(),
    forkedFrom: uuid("forked_from").references((): any => collections.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique().on(t.accountId, t.slug),
    index("collections_account_id_idx").on(t.accountId),
  ],
);

// --- Versions ---

export const versions = pgTable(
  "versions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    collectionId: uuid("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    semver: text("semver").notNull(),
    hash: text("hash").notNull(),
    publicHash: text("public_hash"),
    baseNumber: integer("base_number"),
    message: text("message"),
    readme: text("readme"),
    pushedBy: uuid("pushed_by").references(() => accounts.id),
    appId: text("app_id"),
    actorId: text("actor_id"),
    signature: text("signature"),
    recordCount: integer("record_count").notNull(),
    fileCount: integer("file_count").notNull(),
    totalBytes: bigint("total_bytes", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique().on(t.collectionId, t.number),
    unique().on(t.collectionId, t.hash),
  ],
);

// --- Records ---

export const records = pgTable(
  "records",
  {
    versionId: bigint("version_id", { mode: "number" })
      .notNull()
      .references(() => versions.id, { onDelete: "cascade" }),
    recordId: text("record_id").notNull(),
    type: text("type").notNull(),
    data: jsonb("data").notNull(),
    private: boolean("private").default(false).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.versionId, t.recordId] }),
    index("records_version_id_type_idx").on(t.versionId, t.type),
  ],
);

// --- Files ---

export const files = pgTable("files", {
  hash: text("hash").primaryKey(),
  size: bigint("size", { mode: "number" }).notNull(),
  mimeType: text("mime_type").notNull(),
  storageKey: text("storage_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const versionFiles = pgTable(
  "version_files",
  {
    versionId: bigint("version_id", { mode: "number" })
      .notNull()
      .references(() => versions.id, { onDelete: "cascade" }),
    fileHash: text("file_hash")
      .notNull()
      .references(() => files.hash),
  },
  (t) => [
    primaryKey({ columns: [t.versionId, t.fileHash] }),
    index("version_files_file_hash_idx").on(t.fileHash),
  ],
);

// --- Schemas (globally deduplicated, content-addressed) ---

export const schemas = pgTable("schemas", {
  id: uuid("id").defaultRandom().primaryKey(),
  schema: jsonb("schema").notNull(),
  schemaHash: text("schema_hash").unique().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const versionSchemas = pgTable(
  "version_schemas",
  {
    versionId: bigint("version_id", { mode: "number" })
      .notNull()
      .references(() => versions.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    schemaId: uuid("schema_id")
      .notNull()
      .references(() => schemas.id),
  },
  (t) => [
    primaryKey({ columns: [t.versionId, t.slug] }),
    index("version_schemas_schema_id_idx").on(t.schemaId),
  ],
);

// --- Schema Labels (post-hoc naming of content-addressed schemas) ---

export const schemaLabels = pgTable(
  "schema_labels",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    schemaId: uuid("schema_id")
      .notNull()
      .references(() => schemas.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique().on(t.schemaId, t.label),
    index("schema_labels_label_idx").on(t.label),
  ],
);

// --- Org Invitations ---

export const orgInvitations = pgTable("org_invitations", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role", { enum: ["owner", "admin", "member"] }).notNull(),
  invitedBy: uuid("invited_by")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// --- Upload Sessions (chunked push) ---

export const uploadSessions = pgTable("upload_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  collectionId: uuid("collection_id")
    .notNull()
    .references(() => collections.id, { onDelete: "cascade" }),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  baseVersion: integer("base_version"),
  message: text("message"),
  readme: text("readme"),
  appId: text("app_id"),
  actorId: text("actor_id"),
  schemas: jsonb("schemas"),
  status: text("status", { enum: ["open", "finalizing", "completed", "failed", "expired"] })
    .notNull()
    .default("open"),
  recordCount: integer("record_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const uploadRecords = pgTable(
  "upload_records",
  {
    sessionId: uuid("session_id")
      .notNull()
      .references(() => uploadSessions.id, { onDelete: "cascade" }),
    recordId: text("record_id").notNull(),
    type: text("type"),
    data: jsonb("data"),
    private: boolean("private").default(false),
    operation: text("operation", { enum: ["add", "update", "remove"] }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.recordId] })],
);

// --- Sync Runs (mirror mode) ---

export const syncRuns = pgTable("sync_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  trigger: text("trigger", { enum: ["manual", "cron"] }).notNull(),
  status: text("status", { enum: ["running", "completed", "failed"] }).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  collectionsSync: integer("collections_synced").default(0).notNull(),
  collectionsCreated: integer("collections_created").default(0).notNull(),
  collectionsFailed: integer("collections_failed").default(0).notNull(),
  versionsPulled: integer("versions_pulled").default(0).notNull(),
  filesDownloaded: integer("files_downloaded").default(0).notNull(),
  filesSkipped: integer("files_skipped").default(0).notNull(),
  errors: jsonb("errors").$type<string[]>().default([]).notNull(),
  logs: jsonb("logs").$type<string[]>().default([]).notNull(),
});

// --- Password Reset Tokens ---

export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
