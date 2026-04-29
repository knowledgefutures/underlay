import { eq, and, sql } from "drizzle-orm";
import { db, schema } from "../../db/index.js";

// Resolves an Underlay $ref string of the form
//   <owner>/<collection>(@(<integer>|sha256:<hex>))?/<type>
// against the database, returning the source collection version that supplies
// the type's sub-schema. Pin formats:
//   "kf/pubpub/Author"            → latest pubpub version that defines Author
//   "kf/pubpub@5/Author"          → pubpub collection version 5
//   "kf/pubpub@sha256:abc/Author" → pubpub version with that content hash

export type ResolvedTypeRef = {
  sourceVersionId: number;
  ownerSlug: string;
  collectionSlug: string;
  typeSlug: string;
  versionNumber: number;
  versionHash: string;
  schema: unknown;
};

export class RefResolveError extends Error {
  constructor(
    public ref: string,
    public reason:
      | "parse-error"
      | "owner-not-found"
      | "collection-not-found"
      | "version-not-found"
      | "type-not-found-in-source"
      | "forbidden",
  ) {
    super(`Cannot resolve $ref "${ref}": ${reason}`);
  }
}

const REF_PATTERN = /^([^/@\s]+)\/([^/@\s]+)(?:@([^/\s]+))?\/([^/@\s]+)$/;

export function isRefValue(value: unknown): value is { $ref: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.$ref === "string";
}

export function parseRef(ref: string):
  | { ownerSlug: string; collectionSlug: string; pin: string | null; typeSlug: string }
  | null {
  const m = REF_PATTERN.exec(ref);
  if (!m) return null;
  return {
    ownerSlug: m[1]!,
    collectionSlug: m[2]!,
    pin: m[3] ?? null,
    typeSlug: m[4]!,
  };
}

export async function resolveRef(
  ref: string,
  ctx: { accountId: string | null },
): Promise<ResolvedTypeRef> {
  const parsed = parseRef(ref);
  if (!parsed) throw new RefResolveError(ref, "parse-error");
  const { ownerSlug, collectionSlug, pin, typeSlug } = parsed;

  // Resolve owner + collection (with visibility check)
  const [collection] = await db
    .select({
      id: schema.collections.id,
      isPublic: schema.collections.public,
      accountId: schema.collections.accountId,
      accountType: schema.accounts.type,
    })
    .from(schema.collections)
    .innerJoin(schema.accounts, eq(schema.collections.accountId, schema.accounts.id))
    .where(and(eq(schema.accounts.slug, ownerSlug), eq(schema.collections.slug, collectionSlug)))
    .limit(1);

  if (!collection) {
    // Don't distinguish owner-not-found from collection-not-found to avoid
    // leaking owner existence — both surface as collection-not-found.
    const [account] = await db
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(eq(schema.accounts.slug, ownerSlug))
      .limit(1);
    throw new RefResolveError(ref, account ? "collection-not-found" : "owner-not-found");
  }

  // Visibility check: public collections are always readable; private ones
  // require the requester to own the account or be a member of its org.
  if (!collection.isPublic) {
    let hasAccess = ctx.accountId !== null && collection.accountId === ctx.accountId;
    if (!hasAccess && collection.accountType === "org" && ctx.accountId) {
      const [membership] = await db
        .select({ orgId: schema.orgMemberships.orgId })
        .from(schema.orgMemberships)
        .where(
          and(
            eq(schema.orgMemberships.orgId, collection.accountId),
            eq(schema.orgMemberships.userId, ctx.accountId),
          ),
        )
        .limit(1);
      hasAccess = !!membership;
    }
    if (!hasAccess) {
      // Mask the existence of private collections.
      throw new RefResolveError(ref, "collection-not-found");
    }
  }

  // Resolve which collection version supplies the schema for `typeSlug`.
  // - explicit number pin: that exact version, must contain the type
  // - explicit sha256 pin: the version with that hash
  // - no pin: most recent version whose schema.properties has the type
  let candidate:
    | {
        id: number;
        number: number;
        hash: string;
        schemaDoc: unknown;
      }
    | undefined;

  if (pin === null) {
    const [row] = await db
      .select({
        id: schema.versions.id,
        number: schema.versions.number,
        hash: schema.versions.hash,
        schemaDoc: schema.versions.schema,
      })
      .from(schema.versions)
      .where(
        and(
          eq(schema.versions.collectionId, collection.id),
          sql`${schema.versions.schema} -> 'properties' ? ${typeSlug}`,
        ),
      )
      .orderBy(sql`${schema.versions.number} desc`)
      .limit(1);
    candidate = row;
    if (!candidate) throw new RefResolveError(ref, "type-not-found-in-source");
  } else if (/^\d+$/.test(pin)) {
    const [row] = await db
      .select({
        id: schema.versions.id,
        number: schema.versions.number,
        hash: schema.versions.hash,
        schemaDoc: schema.versions.schema,
      })
      .from(schema.versions)
      .where(
        and(
          eq(schema.versions.collectionId, collection.id),
          eq(schema.versions.number, parseInt(pin, 10)),
        ),
      )
      .limit(1);
    candidate = row;
    if (!candidate) throw new RefResolveError(ref, "version-not-found");
  } else if (pin.startsWith("sha256:")) {
    const hash = pin.slice("sha256:".length);
    const [row] = await db
      .select({
        id: schema.versions.id,
        number: schema.versions.number,
        hash: schema.versions.hash,
        schemaDoc: schema.versions.schema,
      })
      .from(schema.versions)
      .where(and(eq(schema.versions.collectionId, collection.id), eq(schema.versions.hash, hash)))
      .limit(1);
    candidate = row;
    if (!candidate) throw new RefResolveError(ref, "version-not-found");
  } else {
    throw new RefResolveError(ref, "parse-error");
  }

  // Check the pinned version actually defines the requested type.
  const subSchema = ((candidate.schemaDoc as Record<string, unknown>)?.properties as
    | Record<string, unknown>
    | undefined)?.[typeSlug];
  if (subSchema === undefined) {
    throw new RefResolveError(ref, "type-not-found-in-source");
  }

  return {
    sourceVersionId: candidate.id,
    ownerSlug,
    collectionSlug,
    typeSlug,
    versionNumber: candidate.number,
    versionHash: candidate.hash,
    schema: subSchema,
  };
}
