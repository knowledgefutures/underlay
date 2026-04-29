import type { FastifyInstance } from "fastify";
import { eq, and, sql, ne } from "drizzle-orm";
import { alias as aliasedTable } from "drizzle-orm/pg-core";
import { db, schema } from "../../db/index.js";

export async function recordTypeRoutes(app: FastifyInstance) {
  // List record types in a collection
  app.get("/collections/:owner/:slug/types", async (request, reply) => {
    const { owner, slug } = request.params as { owner: string; slug: string };

    const collection = await resolveCollectionWithVisibility(owner, slug, request.accountId);
    if (!collection) {
      return reply.status(404).send({ error: "Collection not found", statusCode: 404 });
    }

    // Per-type stats: how many collection versions use it, when it first appeared,
    // when it was most recently used.
    const rows = await db
      .select({
        slug: schema.recordTypes.slug,
        displayName: schema.recordTypes.displayName,
        description: schema.recordTypes.description,
        createdAt: schema.recordTypes.createdAt,
        firstAppearedInVersion: sql<number>`min(${schema.versions.number})`,
        latestVersion: sql<number>`max(${schema.versions.number})`,
        versionsUsing: sql<number>`count(${schema.versionRecordTypes.versionId})::int`,
      })
      .from(schema.recordTypes)
      .leftJoin(
        schema.versionRecordTypes,
        eq(schema.versionRecordTypes.recordTypeId, schema.recordTypes.id),
      )
      .leftJoin(schema.versions, eq(schema.versionRecordTypes.versionId, schema.versions.id))
      .where(eq(schema.recordTypes.collectionId, collection.id))
      .groupBy(
        schema.recordTypes.id,
        schema.recordTypes.slug,
        schema.recordTypes.displayName,
        schema.recordTypes.description,
        schema.recordTypes.createdAt,
      )
      .orderBy(schema.recordTypes.slug);

    return rows;
  });

  // Type detail with appearances + importedBy
  app.get("/collections/:owner/:slug/types/:typeSlug", async (request, reply) => {
    const { owner, slug, typeSlug } = request.params as {
      owner: string;
      slug: string;
      typeSlug: string;
    };

    const collection = await resolveCollectionWithVisibility(owner, slug, request.accountId);
    if (!collection) {
      return reply.status(404).send({ error: "Collection not found", statusCode: 404 });
    }

    const [recordType] = await db
      .select()
      .from(schema.recordTypes)
      .where(
        and(
          eq(schema.recordTypes.collectionId, collection.id),
          eq(schema.recordTypes.slug, typeSlug),
        ),
      )
      .limit(1);

    if (!recordType) {
      return reply.status(404).send({ error: "Record type not found", statusCode: 404 });
    }

    // appearances: collection versions in THIS collection that use the type
    const sourceVersions = aliasedTable(schema.versions, "src_versions");
    const appearances = await db
      .select({
        versionNumber: schema.versions.number,
        versionHash: schema.versions.hash,
        sourceVersionId: schema.versionRecordTypes.sourceVersionId,
        sourceVersionNumber: sourceVersions.number,
      })
      .from(schema.versionRecordTypes)
      .innerJoin(schema.versions, eq(schema.versionRecordTypes.versionId, schema.versions.id))
      .leftJoin(sourceVersions, eq(schema.versionRecordTypes.sourceVersionId, sourceVersions.id))
      .where(
        and(
          eq(schema.versionRecordTypes.recordTypeId, recordType.id),
          eq(schema.versions.collectionId, collection.id),
        ),
      )
      .orderBy(schema.versions.number);

    // importedBy: external collection versions that import this type from us.
    // Each importing collection creates its OWN record_types row with the same
    // slug, so we match via sourceVersionId pointing at one of our versions
    // AND the importer's local record_type sharing this slug.
    const externalVersions = aliasedTable(schema.versions, "ext_versions");
    const externalCollections = aliasedTable(schema.collections, "ext_collections");
    const externalAccounts = aliasedTable(schema.accounts, "ext_accounts");
    const externalRecordTypes = aliasedTable(schema.recordTypes, "ext_record_types");
    const sourceVersionsForImports = aliasedTable(schema.versions, "src_versions_imp");

    const importedBy = await db
      .select({
        owner: externalAccounts.slug,
        collection: externalCollections.slug,
        version: externalVersions.number,
      })
      .from(schema.versionRecordTypes)
      .innerJoin(
        sourceVersionsForImports,
        eq(schema.versionRecordTypes.sourceVersionId, sourceVersionsForImports.id),
      )
      .innerJoin(externalRecordTypes, eq(schema.versionRecordTypes.recordTypeId, externalRecordTypes.id))
      .innerJoin(externalVersions, eq(schema.versionRecordTypes.versionId, externalVersions.id))
      .innerJoin(externalCollections, eq(externalVersions.collectionId, externalCollections.id))
      .innerJoin(externalAccounts, eq(externalCollections.accountId, externalAccounts.id))
      .where(
        and(
          eq(sourceVersionsForImports.collectionId, collection.id),
          eq(externalRecordTypes.slug, typeSlug),
          ne(externalVersions.collectionId, collection.id),
        ),
      )
      .orderBy(externalAccounts.slug, externalCollections.slug, externalVersions.number);

    return {
      slug: recordType.slug,
      displayName: recordType.displayName,
      description: recordType.description,
      createdAt: recordType.createdAt,
      collection: { owner, slug },
      appearances: appearances.map((a) => ({
        versionNumber: a.versionNumber,
        versionHash: a.versionHash,
        isImport: a.sourceVersionId !== null,
        sourceVersionNumber: a.sourceVersionNumber ?? null,
      })),
      importedBy,
    };
  });

  // Type as seen at a specific collection version. Mirrors /versions/:n/records.
  app.get(
    "/collections/:owner/:slug/versions/:n/types/:typeSlug",
    async (request, reply) => {
      const { owner, slug, n, typeSlug } = request.params as {
        owner: string;
        slug: string;
        n: string;
        typeSlug: string;
      };

      const collection = await resolveCollectionWithVisibility(owner, slug, request.accountId);
      if (!collection) {
        return reply.status(404).send({ error: "Collection not found", statusCode: 404 });
      }

      const [version] = await db
        .select()
        .from(schema.versions)
        .where(
          and(
            eq(schema.versions.collectionId, collection.id),
            eq(schema.versions.number, parseInt(n, 10)),
          ),
        )
        .limit(1);

      if (!version) {
        return reply.status(404).send({ error: "Version not found", statusCode: 404 });
      }

      const sub = ((version.schema as Record<string, unknown>)?.properties as
        | Record<string, unknown>
        | undefined)?.[typeSlug];
      if (sub === undefined) {
        return reply
          .status(404)
          .send({ error: "Type not present in this version", statusCode: 404 });
      }

      // Provenance for this slug at this version
      const sourceVersions = aliasedTable(schema.versions, "src_versions");
      const sourceCollections = aliasedTable(schema.collections, "src_collections");
      const sourceAccounts = aliasedTable(schema.accounts, "src_accounts");

      const [pin] = await db
        .select({
          sourceVersionId: schema.versionRecordTypes.sourceVersionId,
          sourceVersionNumber: sourceVersions.number,
          sourceVersionHash: sourceVersions.hash,
          sourceCollSlug: sourceCollections.slug,
          sourceOwnerSlug: sourceAccounts.slug,
        })
        .from(schema.versionRecordTypes)
        .innerJoin(schema.recordTypes, eq(schema.versionRecordTypes.recordTypeId, schema.recordTypes.id))
        .leftJoin(sourceVersions, eq(schema.versionRecordTypes.sourceVersionId, sourceVersions.id))
        .leftJoin(sourceCollections, eq(sourceVersions.collectionId, sourceCollections.id))
        .leftJoin(sourceAccounts, eq(sourceCollections.accountId, sourceAccounts.id))
        .where(
          and(
            eq(schema.versionRecordTypes.versionId, version.id),
            eq(schema.recordTypes.slug, typeSlug),
          ),
        )
        .limit(1);

      const isImport = (pin?.sourceVersionId ?? null) !== null;

      return {
        slug: typeSlug,
        versionNumber: version.number,
        schema: sub,
        isImport,
        ref: isImport
          ? `${pin!.sourceOwnerSlug}/${pin!.sourceCollSlug}@${pin!.sourceVersionNumber}/${typeSlug}`
          : null,
        hash: isImport ? `sha256:${pin!.sourceVersionHash}` : null,
      };
    },
  );
}

async function resolveCollectionWithVisibility(
  ownerSlug: string,
  collectionSlug: string,
  accountId: string | null | undefined,
) {
  const [row] = await db
    .select({
      id: schema.collections.id,
      isPublic: schema.collections.public,
      accountId: schema.collections.accountId,
      accountType: schema.accounts.type,
    })
    .from(schema.collections)
    .innerJoin(schema.accounts, eq(schema.collections.accountId, schema.accounts.id))
    .where(
      and(eq(schema.accounts.slug, ownerSlug), eq(schema.collections.slug, collectionSlug)),
    )
    .limit(1);

  if (!row) return null;

  if (row.isPublic) return row;

  let hasAccess = !!accountId && row.accountId === accountId;
  if (!hasAccess && row.accountType === "org" && accountId) {
    const [m] = await db
      .select({ orgId: schema.orgMemberships.orgId })
      .from(schema.orgMemberships)
      .where(
        and(
          eq(schema.orgMemberships.orgId, row.accountId),
          eq(schema.orgMemberships.userId, accountId),
        ),
      )
      .limit(1);
    hasAccess = !!m;
  }
  return hasAccess ? row : null;
}
