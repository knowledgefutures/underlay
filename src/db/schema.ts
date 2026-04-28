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
} from "drizzle-orm/pg-core";

// --- Accounts ---

export const accounts = pgTable("accounts", {
  id: uuid("id").defaultRandom().primaryKey(),
  slug: text("slug").unique().notNull(),
  type: text("type", { enum: ["user", "org"] }).notNull(),
  displayName: text("display_name").notNull(),
  email: text("email"),
  passwordHash: text("password_hash"),
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
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const apiKeys = pgTable("api_keys", {
  id: uuid("id").defaultRandom().primaryKey(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  corpusId: uuid("corpus_id").references(() => corpora.id, { onDelete: "cascade" }),
  scope: text("scope", { enum: ["read", "write", "admin"] }).notNull(),
  keyHash: text("key_hash").notNull(),
  label: text("label").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
});

// --- Corpora ---

export const corpora = pgTable(
  "corpora",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    public: boolean("public").default(false).notNull(),
    forkedFrom: uuid("forked_from").references((): any => corpora.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique().on(t.accountId, t.slug)],
);

// --- Versions ---

export const versions = pgTable(
  "versions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    corpusId: uuid("corpus_id")
      .notNull()
      .references(() => corpora.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    semver: text("semver").notNull(),
    hash: text("hash").notNull(),
    baseNumber: integer("base_number"),
    schema: jsonb("schema").notNull(),
    message: text("message"),
    appId: text("app_id"),
    actorId: text("actor_id"),
    signature: text("signature"),
    recordCount: integer("record_count").notNull(),
    fileCount: integer("file_count").notNull(),
    totalBytes: bigint("total_bytes", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique().on(t.corpusId, t.number),
    unique().on(t.corpusId, t.hash),
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
  },
  (t) => [primaryKey({ columns: [t.versionId, t.recordId] })],
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
  (t) => [primaryKey({ columns: [t.versionId, t.fileHash] })],
);
