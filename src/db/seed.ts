import { db, schema } from "./index.js";
import { v4 as uuidv4 } from "uuid";
import bcrypt from "bcrypt";
import { createHash } from "node:crypto";

function computeVersionHash(
  schemaDoc: unknown,
  records: { recordId: string; type: string; data: unknown }[],
  fileHashes: string[],
): string {
  const canonical = JSON.stringify({
    schema: schemaDoc,
    records: records
      .sort((a, b) => a.recordId.localeCompare(b.recordId))
      .map((r) => ({ id: r.recordId, type: r.type, data: r.data })),
    files: fileHashes.sort(),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

async function seed() {
  const force = process.argv.includes("--force");
  console.log("[seed] Seeding database...");

  const existing = await db.select().from(schema.accounts).limit(1);
  if (existing.length > 0 && !force) {
    console.log("[seed] Database already seeded, skipping. Use --force to re-seed.");
    process.exit(0);
  }

  if (existing.length > 0 && force) {
    console.log("[seed] --force: clearing existing data...");
    await db.delete(schema.records);
    await db.delete(schema.versionFiles);
    await db.delete(schema.files);
    await db.delete(schema.versions);
    await db.delete(schema.corpora);
    await db.delete(schema.apiKeys);
    await db.delete(schema.sessions);
    await db.delete(schema.orgMemberships);
    await db.delete(schema.accounts);
  }

  const passwordHash = await bcrypt.hash("admin", 10);
  const adminId = uuidv4();

  await db.insert(schema.accounts).values({
    id: adminId,
    slug: "admin",
    type: "user",
    displayName: "Admin",
    email: "admin@underlay.org",
    passwordHash,
  });

  const kfId = uuidv4();
  await db.insert(schema.accounts).values({
    id: kfId,
    slug: "knowledge-futures",
    type: "org",
    displayName: "Knowledge Futures",
  });

  await db.insert(schema.orgMemberships).values({
    orgId: kfId,
    userId: adminId,
    role: "owner",
  });

  console.log("[seed] Created admin user (admin@underlay.org / admin)");
  console.log("[seed] Created Knowledge Futures org");

  // --- Corpus 1: PubPub Archive ---
  const pubpubId = uuidv4();
  await db.insert(schema.corpora).values({
    id: pubpubId,
    accountId: kfId,
    slug: "pubpub-archive",
    name: "PubPub Archive",
    description:
      "Archive of publications from PubPub communities. Includes pubs, authors, communities, and review data.",
    public: true,
  });

  const pubpubSchema = {
    type: "object",
    properties: {
      Community: {
        type: "object",
        properties: {
          title: { type: "string" },
          subdomain: { type: "string" },
          description: { type: "string" },
          createdAt: { type: "string", format: "date-time" },
        },
      },
      Pub: {
        type: "object",
        properties: {
          title: { type: "string" },
          slug: { type: "string" },
          communityId: { type: "string" },
          doi: { type: "string" },
          description: { type: "string" },
          publishedAt: { type: "string", format: "date-time" },
          license: { type: "string" },
        },
      },
      Author: {
        type: "object",
        properties: {
          name: { type: "string" },
          orcid: { type: "string" },
          affiliation: { type: "string" },
        },
      },
      PubAuthor: {
        type: "object",
        properties: {
          pubId: { type: "string" },
          authorId: { type: "string" },
          order: { type: "integer" },
        },
      },
    },
  };

  const pubpubRecords = [
    { recordId: "community-001", type: "Community", data: { title: "Journal of Trial and Error", subdomain: "jtrialerror", description: "A peer-reviewed journal dedicated to publishing null results, methodological problems, and scientific failures.", createdAt: "2020-06-15T00:00:00.000Z" } },
    { recordId: "community-002", type: "Community", data: { title: "Collective Intelligence", subdomain: "collectiveintelligence", description: "An open-access journal exploring how groups of individuals can collectively solve problems.", createdAt: "2021-01-10T00:00:00.000Z" } },
    { recordId: "community-003", type: "Community", data: { title: "Frankenbook", subdomain: "frankenbook", description: "A collaborative reading experiment with Mary Shelley's Frankenstein.", createdAt: "2018-03-01T00:00:00.000Z" } },
    { recordId: "author-001", type: "Author", data: { name: "Sean Devine", orcid: "0000-0002-1234-5678", affiliation: "McGill University" } },
    { recordId: "author-002", type: "Author", data: { name: "Maha Bali", orcid: "0000-0003-9876-5432", affiliation: "American University in Cairo" } },
    { recordId: "author-003", type: "Author", data: { name: "Stefan Müller", orcid: "0000-0001-5555-4444", affiliation: "University of Vienna" } },
    { recordId: "author-004", type: "Author", data: { name: "Catherine D'Ignazio", orcid: "0000-0002-8888-7777", affiliation: "MIT" } },
    { recordId: "author-005", type: "Author", data: { name: "Travis Rich", orcid: "0000-0001-0503-5905", affiliation: "Knowledge Futures" } },
    { recordId: "pub-001", type: "Pub", data: { title: "The Role of Failure in Scientific Discovery", slug: "role-of-failure", communityId: "community-001", doi: "10.36850/e1", description: "An analysis of how failures contribute to the scientific process.", publishedAt: "2021-03-15T00:00:00.000Z", license: "CC-BY-4.0" } },
    { recordId: "pub-002", type: "Pub", data: { title: "Collective Memory in Online Communities", slug: "collective-memory", communityId: "community-002", doi: "10.36850/ci-2", description: "How online groups form and retain shared knowledge structures.", publishedAt: "2022-07-20T00:00:00.000Z", license: "CC-BY-4.0" } },
    { recordId: "pub-003", type: "Pub", data: { title: "Annotating Frankenstein: A Digital Experiment", slug: "annotating-frankenstein", communityId: "community-003", doi: "10.21428/frank.001", description: "Collaborative annotation of Shelley's Frankenstein using digital tools.", publishedAt: "2018-06-01T00:00:00.000Z", license: "CC-BY-4.0" } },
    { recordId: "pub-004", type: "Pub", data: { title: "Open Infrastructure for Open Science", slug: "open-infrastructure", communityId: "community-002", doi: "10.36850/ci-4", description: "The case for community-owned scholarly infrastructure.", publishedAt: "2023-01-10T00:00:00.000Z", license: "CC-BY-4.0" } },
    { recordId: "pubauthor-001", type: "PubAuthor", data: { pubId: "pub-001", authorId: "author-001", order: 1 } },
    { recordId: "pubauthor-002", type: "PubAuthor", data: { pubId: "pub-001", authorId: "author-003", order: 2 } },
    { recordId: "pubauthor-003", type: "PubAuthor", data: { pubId: "pub-002", authorId: "author-002", order: 1 } },
    { recordId: "pubauthor-004", type: "PubAuthor", data: { pubId: "pub-003", authorId: "author-004", order: 1 } },
    { recordId: "pubauthor-005", type: "PubAuthor", data: { pubId: "pub-004", authorId: "author-005", order: 1 } },
  ];

  const pubpubHash = computeVersionHash(pubpubSchema, pubpubRecords, []);
  const [pubpubVersion] = await db
    .insert(schema.versions)
    .values({
      corpusId: pubpubId,
      number: 1,
      semver: "v1.0.0",
      hash: pubpubHash,
      baseNumber: null,
      schema: pubpubSchema,
      message: "Initial PubPub archive import",
      appId: "seed",
      actorId: "admin",
      recordCount: pubpubRecords.length,
      fileCount: 0,
      totalBytes: 0,
    })
    .returning();

  await db.insert(schema.records).values(
    pubpubRecords.map((r) => ({
      versionId: pubpubVersion!.id,
      recordId: r.recordId,
      type: r.type,
      data: r.data,
    })),
  );

  console.log("[seed] Created corpus: knowledge-futures/pubpub-archive (17 records)");

  // --- Corpus 2: Open Grants ---
  const grantsId = uuidv4();
  await db.insert(schema.corpora).values({
    id: grantsId,
    accountId: kfId,
    slug: "open-grants",
    name: "Open Grants Dataset",
    description:
      "A curated dataset of research grants with funding amounts, topics, and PI information. Sourced from public funders.",
    public: true,
  });

  const grantsSchema = {
    type: "object",
    properties: {
      Funder: {
        type: "object",
        properties: {
          name: { type: "string" },
          country: { type: "string" },
          url: { type: "string" },
        },
      },
      Grant: {
        type: "object",
        properties: {
          title: { type: "string" },
          funderId: { type: "string" },
          piName: { type: "string" },
          institution: { type: "string" },
          amount: { type: "number" },
          currency: { type: "string" },
          startDate: { type: "string", format: "date" },
          endDate: { type: "string", format: "date" },
          abstract: { type: "string" },
          topics: { type: "array", items: { type: "string" } },
        },
      },
    },
  };

  const grantsRecords = [
    { recordId: "funder-001", type: "Funder", data: { name: "National Science Foundation", country: "US", url: "https://nsf.gov" } },
    { recordId: "funder-002", type: "Funder", data: { name: "Wellcome Trust", country: "UK", url: "https://wellcome.org" } },
    { recordId: "funder-003", type: "Funder", data: { name: "Alfred P. Sloan Foundation", country: "US", url: "https://sloan.org" } },
    { recordId: "grant-001", type: "Grant", data: { title: "Infrastructure for Open Scholarly Communication", funderId: "funder-003", piName: "Kathleen Fitzpatrick", institution: "Michigan State University", amount: 750000, currency: "USD", startDate: "2022-01-01", endDate: "2024-12-31", abstract: "Building sustainable infrastructure for open access scholarly publishing.", topics: ["open access", "scholarly communication", "infrastructure"] } },
    { recordId: "grant-002", type: "Grant", data: { title: "Machine Learning for Knowledge Graph Construction", funderId: "funder-001", piName: "James Chen", institution: "Stanford University", amount: 1200000, currency: "USD", startDate: "2023-06-01", endDate: "2026-05-31", abstract: "Developing ML techniques for automated construction and maintenance of scientific knowledge graphs.", topics: ["machine learning", "knowledge graphs", "NLP"] } },
    { recordId: "grant-003", type: "Grant", data: { title: "Open Science Metrics and Incentives", funderId: "funder-002", piName: "Sarah Jones", institution: "University of Edinburgh", amount: 450000, currency: "GBP", startDate: "2023-09-01", endDate: "2025-08-31", abstract: "Studying how metrics and incentive structures affect the adoption of open science practices.", topics: ["open science", "metrics", "research policy"] } },
    { recordId: "grant-004", type: "Grant", data: { title: "Decentralized Identifiers for Research Outputs", funderId: "funder-001", piName: "Maria Rodriguez", institution: "MIT", amount: 580000, currency: "USD", startDate: "2024-01-01", endDate: "2026-12-31", abstract: "Implementing decentralized identifier systems for research outputs and datasets.", topics: ["persistent identifiers", "decentralization", "research data"] } },
    { recordId: "grant-005", type: "Grant", data: { title: "Community-Owned Publishing Platforms", funderId: "funder-003", piName: "Travis Rich", institution: "Knowledge Futures", amount: 500000, currency: "USD", startDate: "2024-03-01", endDate: "2026-02-28", abstract: "Developing open-source tools for community-owned scholarly publishing and archiving.", topics: ["publishing", "open source", "community ownership"] } },
  ];

  const grantsHash = computeVersionHash(grantsSchema, grantsRecords, []);
  const [grantsVersion] = await db
    .insert(schema.versions)
    .values({
      corpusId: grantsId,
      number: 1,
      semver: "v1.0.0",
      hash: grantsHash,
      baseNumber: null,
      schema: grantsSchema,
      message: "Initial grants dataset",
      appId: "seed",
      actorId: "admin",
      recordCount: grantsRecords.length,
      fileCount: 0,
      totalBytes: 0,
    })
    .returning();

  await db.insert(schema.records).values(
    grantsRecords.map((r) => ({
      versionId: grantsVersion!.id,
      recordId: r.recordId,
      type: r.type,
      data: r.data,
    })),
  );

  console.log("[seed] Created corpus: knowledge-futures/open-grants (8 records)");

  // --- Corpus 3: Climate Observations ---
  const climateId = uuidv4();
  await db.insert(schema.corpora).values({
    id: climateId,
    accountId: kfId,
    slug: "climate-observations",
    name: "Global Climate Observations",
    description:
      "Structured records of climate monitoring stations and their annual temperature and precipitation observations.",
    public: true,
  });

  const climateSchema = {
    type: "object",
    properties: {
      Station: {
        type: "object",
        properties: {
          name: { type: "string" },
          country: { type: "string" },
          latitude: { type: "number" },
          longitude: { type: "number" },
          elevation: { type: "number" },
        },
      },
      Observation: {
        type: "object",
        properties: {
          stationId: { type: "string" },
          year: { type: "integer" },
          meanTempC: { type: "number" },
          precipitationMm: { type: "number" },
          daysAbove30C: { type: "integer" },
          daysBelow0C: { type: "integer" },
        },
      },
    },
  };

  const climateRecords = [
    { recordId: "station-001", type: "Station", data: { name: "Mauna Loa Observatory", country: "US", latitude: 19.536, longitude: -155.576, elevation: 3397 } },
    { recordId: "station-002", type: "Station", data: { name: "Cape Grim", country: "AU", latitude: -40.683, longitude: 144.689, elevation: 94 } },
    { recordId: "station-003", type: "Station", data: { name: "Ny-Ålesund", country: "NO", latitude: 78.923, longitude: 11.923, elevation: 11 } },
    { recordId: "station-004", type: "Station", data: { name: "Izaña Observatory", country: "ES", latitude: 28.309, longitude: -16.499, elevation: 2373 } },
    { recordId: "obs-001", type: "Observation", data: { stationId: "station-001", year: 2023, meanTempC: 7.2, precipitationMm: 432, daysAbove30C: 0, daysBelow0C: 95 } },
    { recordId: "obs-002", type: "Observation", data: { stationId: "station-001", year: 2024, meanTempC: 7.5, precipitationMm: 410, daysAbove30C: 0, daysBelow0C: 89 } },
    { recordId: "obs-003", type: "Observation", data: { stationId: "station-002", year: 2023, meanTempC: 12.8, precipitationMm: 890, daysAbove30C: 2, daysBelow0C: 12 } },
    { recordId: "obs-004", type: "Observation", data: { stationId: "station-002", year: 2024, meanTempC: 13.1, precipitationMm: 875, daysAbove30C: 4, daysBelow0C: 10 } },
    { recordId: "obs-005", type: "Observation", data: { stationId: "station-003", year: 2023, meanTempC: -4.2, precipitationMm: 385, daysAbove30C: 0, daysBelow0C: 248 } },
    { recordId: "obs-006", type: "Observation", data: { stationId: "station-003", year: 2024, meanTempC: -3.8, precipitationMm: 402, daysAbove30C: 0, daysBelow0C: 240 } },
    { recordId: "obs-007", type: "Observation", data: { stationId: "station-004", year: 2023, meanTempC: 10.5, precipitationMm: 290, daysAbove30C: 5, daysBelow0C: 22 } },
    { recordId: "obs-008", type: "Observation", data: { stationId: "station-004", year: 2024, meanTempC: 10.9, precipitationMm: 278, daysAbove30C: 8, daysBelow0C: 18 } },
  ];

  const climateHash = computeVersionHash(climateSchema, climateRecords, []);
  const [climateVersion] = await db
    .insert(schema.versions)
    .values({
      corpusId: climateId,
      number: 1,
      semver: "v1.0.0",
      hash: climateHash,
      baseNumber: null,
      schema: climateSchema,
      message: "Initial climate observations — 4 stations, 2023-2024 data",
      appId: "seed",
      actorId: "admin",
      recordCount: climateRecords.length,
      fileCount: 0,
      totalBytes: 0,
    })
    .returning();

  await db.insert(schema.records).values(
    climateRecords.map((r) => ({
      versionId: climateVersion!.id,
      recordId: r.recordId,
      type: r.type,
      data: r.data,
    })),
  );

  console.log("[seed] Created corpus: knowledge-futures/climate-observations (12 records)");
  console.log("[seed] Done.");
  process.exit(0);
}

seed().catch((err) => {
  console.error("[seed] Failed:", err);
  process.exit(1);
});
