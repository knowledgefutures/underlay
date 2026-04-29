import { db, schema } from "./index.js";
import { v4 as uuidv4 } from "uuid";
import bcrypt from "bcrypt";
import { pushVersion } from "../api/lib/pushVersion.js";

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
    await db.delete(schema.versionRecordTypes);
    await db.delete(schema.versionFiles);
    await db.delete(schema.files);
    await db.delete(schema.versions);
    await db.delete(schema.recordTypes);
    await db.delete(schema.collections);
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

  // --- Collection 1: PubPub Archive ---
  const pubpubId = uuidv4();
  await db.insert(schema.collections).values({
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
    { id: "community-001", type: "Community", data: { title: "Journal of Trial and Error", subdomain: "jtrialerror", description: "A peer-reviewed journal dedicated to publishing null results, methodological problems, and scientific failures.", createdAt: "2020-06-15T00:00:00.000Z" } },
    { id: "community-002", type: "Community", data: { title: "Collective Intelligence", subdomain: "collectiveintelligence", description: "An open-access journal exploring how groups of individuals can collectively solve problems.", createdAt: "2021-01-10T00:00:00.000Z" } },
    { id: "community-003", type: "Community", data: { title: "Frankenbook", subdomain: "frankenbook", description: "A collaborative reading experiment with Mary Shelley's Frankenstein.", createdAt: "2018-03-01T00:00:00.000Z" } },
    { id: "author-001", type: "Author", data: { name: "Sean Devine", orcid: "0000-0002-1234-5678", affiliation: "McGill University" } },
    { id: "author-002", type: "Author", data: { name: "Maha Bali", orcid: "0000-0003-9876-5432", affiliation: "American University in Cairo" } },
    { id: "author-003", type: "Author", data: { name: "Stefan Müller", orcid: "0000-0001-5555-4444", affiliation: "University of Vienna" } },
    { id: "author-004", type: "Author", data: { name: "Catherine D'Ignazio", orcid: "0000-0002-8888-7777", affiliation: "MIT" } },
    { id: "author-005", type: "Author", data: { name: "Travis Rich", orcid: "0000-0001-0503-5905", affiliation: "Knowledge Futures" } },
    { id: "pub-001", type: "Pub", data: { title: "The Role of Failure in Scientific Discovery", slug: "role-of-failure", communityId: "community-001", doi: "10.36850/e1", description: "An analysis of how failures contribute to the scientific process.", publishedAt: "2021-03-15T00:00:00.000Z", license: "CC-BY-4.0" } },
    { id: "pub-002", type: "Pub", data: { title: "Collective Memory in Online Communities", slug: "collective-memory", communityId: "community-002", doi: "10.36850/ci-2", description: "How online groups form and retain shared knowledge structures.", publishedAt: "2022-07-20T00:00:00.000Z", license: "CC-BY-4.0" } },
    { id: "pub-003", type: "Pub", data: { title: "Annotating Frankenstein: A Digital Experiment", slug: "annotating-frankenstein", communityId: "community-003", doi: "10.21428/frank.001", description: "Collaborative annotation of Shelley's Frankenstein using digital tools.", publishedAt: "2018-06-01T00:00:00.000Z", license: "CC-BY-4.0" } },
    { id: "pub-004", type: "Pub", data: { title: "Open Infrastructure for Open Science", slug: "open-infrastructure", communityId: "community-002", doi: "10.36850/ci-4", description: "The case for community-owned scholarly infrastructure.", publishedAt: "2023-01-10T00:00:00.000Z", license: "CC-BY-4.0" } },
    { id: "pubauthor-001", type: "PubAuthor", data: { pubId: "pub-001", authorId: "author-001", order: 1 } },
    { id: "pubauthor-002", type: "PubAuthor", data: { pubId: "pub-001", authorId: "author-003", order: 2 } },
    { id: "pubauthor-003", type: "PubAuthor", data: { pubId: "pub-002", authorId: "author-002", order: 1 } },
    { id: "pubauthor-004", type: "PubAuthor", data: { pubId: "pub-003", authorId: "author-004", order: 1 } },
    { id: "pubauthor-005", type: "PubAuthor", data: { pubId: "pub-004", authorId: "author-005", order: 1 } },
  ];

  await pushOrFail({
    collectionId: pubpubId,
    schemaDoc: pubpubSchema,
    records: pubpubRecords,
    message: "Initial PubPub archive import",
    readme: `# PubPub Archive\n\nA structured archive of publications from [PubPub](https://www.pubpub.org/) communities, maintained by Knowledge Futures.\n\n## What's included\n\nThis collection contains four record types:\n\n- **Community** — PubPub communities (journals, books, conference proceedings)\n- **Pub** — Individual publications with DOIs, abstracts, and licensing info\n- **Author** — Researcher profiles with ORCID identifiers\n- **PubAuthor** — Join records linking authors to pubs with ordering\n\n## Coverage\n\n| Type | Count |\n|------|-------|\n| Communities | 3 |\n| Publications | 4 |\n| Authors | 5 |\n| Pub-Author links | 5 |\n\n## Source\n\nSample data drawn from real PubPub communities including the Journal of Trial and Error, Collective Intelligence, and Frankenbook.`,
    appId: "underlay-seed/1.0",
    actorId: "admin",
    pushedBy: adminId,
  });

  console.log("[seed] Created collection: knowledge-futures/pubpub-archive (17 records)");

  // --- Collection 2: Open Grants ---
  const grantsId = uuidv4();
  await db.insert(schema.collections).values({
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
    { id: "funder-001", type: "Funder", data: { name: "National Science Foundation", country: "US", url: "https://nsf.gov" } },
    { id: "funder-002", type: "Funder", data: { name: "Wellcome Trust", country: "UK", url: "https://wellcome.org" } },
    { id: "funder-003", type: "Funder", data: { name: "Alfred P. Sloan Foundation", country: "US", url: "https://sloan.org" } },
    { id: "grant-001", type: "Grant", data: { title: "Infrastructure for Open Scholarly Communication", funderId: "funder-003", piName: "Kathleen Fitzpatrick", institution: "Michigan State University", amount: 750000, currency: "USD", startDate: "2022-01-01", endDate: "2024-12-31", abstract: "Building sustainable infrastructure for open access scholarly publishing.", topics: ["open access", "scholarly communication", "infrastructure"] } },
    { id: "grant-002", type: "Grant", data: { title: "Machine Learning for Knowledge Graph Construction", funderId: "funder-001", piName: "James Chen", institution: "Stanford University", amount: 1200000, currency: "USD", startDate: "2023-06-01", endDate: "2026-05-31", abstract: "Developing ML techniques for automated construction and maintenance of scientific knowledge graphs.", topics: ["machine learning", "knowledge graphs", "NLP"] } },
    { id: "grant-003", type: "Grant", data: { title: "Open Science Metrics and Incentives", funderId: "funder-002", piName: "Sarah Jones", institution: "University of Edinburgh", amount: 450000, currency: "GBP", startDate: "2023-09-01", endDate: "2025-08-31", abstract: "Studying how metrics and incentive structures affect the adoption of open science practices.", topics: ["open science", "metrics", "research policy"] } },
    { id: "grant-004", type: "Grant", data: { title: "Decentralized Identifiers for Research Outputs", funderId: "funder-001", piName: "Maria Rodriguez", institution: "MIT", amount: 580000, currency: "USD", startDate: "2024-01-01", endDate: "2026-12-31", abstract: "Implementing decentralized identifier systems for research outputs and datasets.", topics: ["persistent identifiers", "decentralization", "research data"] } },
    { id: "grant-005", type: "Grant", data: { title: "Community-Owned Publishing Platforms", funderId: "funder-003", piName: "Travis Rich", institution: "Knowledge Futures", amount: 500000, currency: "USD", startDate: "2024-03-01", endDate: "2026-02-28", abstract: "Developing open-source tools for community-owned scholarly publishing and archiving.", topics: ["publishing", "open source", "community ownership"] } },
  ];

  await pushOrFail({
    collectionId: grantsId,
    schemaDoc: grantsSchema,
    records: grantsRecords,
    message: "Initial grants dataset",
    readme: `# Open Grants Dataset\n\nA curated dataset of research grants with funding amounts, topics, and PI information sourced from public funders.\n\n## What's included\n\n- **Funder** — Funding organizations (NSF, Wellcome Trust, Sloan Foundation)\n- **Grant** — Individual grants with title, PI, institution, amount, dates, abstract, and topic tags\n\n## Coverage\n\n| Type | Count |\n|------|-------|\n| Funders | 3 |\n| Grants | 5 |\n\nGrants span 2022–2026 across the US and UK, covering topics like open access, machine learning, knowledge graphs, and decentralized identifiers.\n\n## Source\n\nSample data based on publicly available grant information from NSF, Wellcome Trust, and the Alfred P. Sloan Foundation.`,
    appId: "underlay-seed/1.0",
    actorId: "admin",
    pushedBy: adminId,
  });

  console.log("[seed] Created collection: knowledge-futures/open-grants (8 records)");

  // --- Collection 3: Climate Observations ---
  const climateId = uuidv4();
  await db.insert(schema.collections).values({
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
    { id: "station-001", type: "Station", data: { name: "Mauna Loa Observatory", country: "US", latitude: 19.536, longitude: -155.576, elevation: 3397 } },
    { id: "station-002", type: "Station", data: { name: "Cape Grim", country: "AU", latitude: -40.683, longitude: 144.689, elevation: 94 } },
    { id: "station-003", type: "Station", data: { name: "Ny-Ålesund", country: "NO", latitude: 78.923, longitude: 11.923, elevation: 11 } },
    { id: "station-004", type: "Station", data: { name: "Izaña Observatory", country: "ES", latitude: 28.309, longitude: -16.499, elevation: 2373 } },
    { id: "obs-001", type: "Observation", data: { stationId: "station-001", year: 2023, meanTempC: 7.2, precipitationMm: 432, daysAbove30C: 0, daysBelow0C: 95 } },
    { id: "obs-002", type: "Observation", data: { stationId: "station-001", year: 2024, meanTempC: 7.5, precipitationMm: 410, daysAbove30C: 0, daysBelow0C: 89 } },
    { id: "obs-003", type: "Observation", data: { stationId: "station-002", year: 2023, meanTempC: 12.8, precipitationMm: 890, daysAbove30C: 2, daysBelow0C: 12 } },
    { id: "obs-004", type: "Observation", data: { stationId: "station-002", year: 2024, meanTempC: 13.1, precipitationMm: 875, daysAbove30C: 4, daysBelow0C: 10 } },
    { id: "obs-005", type: "Observation", data: { stationId: "station-003", year: 2023, meanTempC: -4.2, precipitationMm: 385, daysAbove30C: 0, daysBelow0C: 248 } },
    { id: "obs-006", type: "Observation", data: { stationId: "station-003", year: 2024, meanTempC: -3.8, precipitationMm: 402, daysAbove30C: 0, daysBelow0C: 240 } },
    { id: "obs-007", type: "Observation", data: { stationId: "station-004", year: 2023, meanTempC: 10.5, precipitationMm: 290, daysAbove30C: 5, daysBelow0C: 22 } },
    { id: "obs-008", type: "Observation", data: { stationId: "station-004", year: 2024, meanTempC: 10.9, precipitationMm: 278, daysAbove30C: 8, daysBelow0C: 18 } },
  ];

  await pushOrFail({
    collectionId: climateId,
    schemaDoc: climateSchema,
    records: climateRecords,
    message: "Initial climate observations — 4 stations, 2023-2024 data",
    readme: `# Global Climate Observations\n\nStructured records of climate monitoring stations and their annual temperature and precipitation observations.\n\n## What's included\n\n- **Station** — Monitoring stations with name, country, coordinates, and elevation\n- **Observation** — Annual readings per station: mean temperature, precipitation, and extreme day counts\n\n## Coverage\n\n| Station | Country | Elevation | Years |\n|---------|---------|-----------|-------|\n| Mauna Loa Observatory | US | 3,397m | 2023–2024 |\n| Cape Grim | AU | 94m | 2023–2024 |\n| Ny-Ålesund | NO | 11m | 2023–2024 |\n| Izaña Observatory | ES | 2,373m | 2023–2024 |\n\nStations span from Arctic (78°N) to Southern Ocean (40°S), providing a cross-section of global climate conditions.\n\n## Source\n\nSample data based on publicly available observations from the World Meteorological Organization (WMO) Global Atmosphere Watch network.`,
    appId: "underlay-seed/1.0",
    actorId: "admin",
    pushedBy: adminId,
  });

  console.log("[seed] Created collection: knowledge-futures/climate-observations (12 records)");

  // --- Collection 4: PubPub Notes — demonstrates $ref import of an Author ---
  const notesId = uuidv4();
  await db.insert(schema.collections).values({
    id: notesId,
    accountId: kfId,
    slug: "pubpub-notes",
    name: "PubPub Notes",
    description:
      "Editor's notes attached to PubPub authors. Reuses the Author schema from pubpub-archive via $ref.",
    public: true,
  });

  const notesSchema = {
    type: "object",
    properties: {
      Author: { $ref: "knowledge-futures/pubpub-archive/Author" },
      Note: {
        type: "object",
        properties: {
          authorId: { type: "string" },
          body: { type: "string" },
          createdAt: { type: "string", format: "date-time" },
        },
      },
    },
  };

  const notesRecords = [
    { id: "author-001", type: "Author", data: { name: "Sean Devine", orcid: "0000-0002-1234-5678", affiliation: "McGill University" } },
    { id: "author-005", type: "Author", data: { name: "Travis Rich", orcid: "0000-0001-0503-5905", affiliation: "Knowledge Futures" } },
    { id: "note-001", type: "Note", data: { authorId: "author-001", body: "Devine's work on null results inspired our editorial direction.", createdAt: "2024-04-12T00:00:00.000Z" } },
    { id: "note-002", type: "Note", data: { authorId: "author-005", body: "Rich's leadership at Knowledge Futures shaped this archive's structure.", createdAt: "2024-09-03T00:00:00.000Z" } },
  ];

  await pushOrFail({
    collectionId: notesId,
    schemaDoc: notesSchema,
    records: notesRecords,
    message: "Initial notes — imports Author from pubpub-archive",
    readme: `# PubPub Notes\n\nEditor's notes attached to authors from the [PubPub Archive](/knowledge-futures/pubpub-archive).\n\nThe \`Author\` record type is imported from \`knowledge-futures/pubpub-archive/Author\` via \`$ref\` — both collections agree on the Author schema without sharing a single collection-level schema.`,
    appId: "underlay-seed/1.0",
    actorId: "admin",
    pushedBy: adminId,
  });

  console.log("[seed] Created collection: knowledge-futures/pubpub-notes (4 records, imports Author)");
  console.log("[seed] Done.");
  process.exit(0);
}

async function pushOrFail(args: {
  collectionId: string;
  schemaDoc: unknown;
  records: { id: string; type: string; data: unknown }[];
  message: string;
  readme: string;
  appId: string;
  actorId: string;
  pushedBy: string;
}) {
  const result = await pushVersion(
    {
      collectionId: args.collectionId,
      baseVersion: null,
      message: args.message,
      readme: args.readme,
      appId: args.appId,
      actorId: args.actorId,
      schema: args.schemaDoc,
      changes: { added: args.records },
      pushedBy: args.pushedBy,
    },
    { accountId: args.pushedBy },
  );

  if (!result.ok) {
    console.error("[seed] pushVersion failed:", result.body);
    process.exit(1);
  }
}

seed().catch((err) => {
  console.error("[seed] Failed:", err);
  process.exit(1);
});
