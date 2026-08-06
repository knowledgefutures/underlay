import { createHash } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { v4 as uuidv4 } from 'uuid'

import { db, schema } from './client.server.js'

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(canonicalize)
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = canonicalize((value as Record<string, unknown>)[key])
  }
  return sorted
}

function hashSchema(schemaBody: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(schemaBody)))
    .digest('hex')
}

function hashRecord(record: { recordId: string; type: string; data: unknown }): {
  hash: string
  canonical: string
} {
  const canonical = JSON.stringify({ id: record.recordId, type: record.type, data: record.data })
  const hash = createHash('sha256').update(canonical).digest('hex')
  return { hash, canonical }
}

function computeVersionHash(
  schemaSet: { slug: string; schemaHash: string }[],
  records: { recordId: string; type: string; data: unknown }[],
  fileHashes: string[],
  metadata: Record<string, unknown> | null,
): string {
  const recordHashes = records.map((r) => hashRecord(r).hash)
  const canonical = JSON.stringify({
    schemas: Object.fromEntries(
      schemaSet.sort((a, b) => a.slug.localeCompare(b.slug)).map((s) => [s.slug, s.schemaHash]),
    ),
    records: [...recordHashes].sort(),
    files: fileHashes.sort(),
    metadata: metadata ? canonicalize(metadata) : null,
  })
  return 'private:' + createHash('sha256').update(canonical).digest('hex')
}

/** Insert records as content-addressed objects and link to a version */
async function insertRecords(
  versionId: number,
  records: { recordId: string; type: string; data: unknown }[],
): Promise<void> {
  const objectRows = records.map((r) => {
    const { hash, canonical } = hashRecord(r)
    return {
      hash,
      recordId: r.recordId,
      type: r.type,
      data: r.data as any,
      size: Buffer.byteLength(canonical, 'utf8'),
    }
  })
  await db.insert(schema.recordObjects).values(objectRows).onConflictDoNothing()
  await db.insert(schema.versionRecords).values(
    objectRows.map((r) => ({
      versionId,
      recordHash: r.hash,
      recordId: r.recordId,
      type: r.type,
    })),
  )
}

/** Insert schemas into global table, returning schema IDs. Deduplicates by hash. */
async function upsertSchemas(
  schemasMap: Record<string, object>,
): Promise<{ slug: string; schemaId: string; schemaHash: string }[]> {
  const results: { slug: string; schemaId: string; schemaHash: string }[] = []
  for (const [slug, body] of Object.entries(schemasMap)) {
    const hash = hashSchema(body)
    // Check if exists
    const existing = await db
      .select({ id: schema.schemas.id })
      .from(schema.schemas)
      .where(eq(schema.schemas.schemaHash, hash))
      .limit(1)

    let schemaId: string
    if (existing.length > 0) {
      schemaId = existing[0]!.id
    } else {
      const [inserted] = await db
        .insert(schema.schemas)
        .values({ schema: body as any, schemaHash: hash })
        .returning({ id: schema.schemas.id })
      schemaId = inserted!.id
    }
    results.push({ slug, schemaId, schemaHash: hash })
  }
  return results
}

async function seed() {
  const force = process.argv.includes('--force')
  console.log('[seed] Seeding database...')

  const existing = await db.select().from(schema.organization).limit(1)
  if (existing.length > 0 && !force) {
    console.log('[seed] Database already seeded, skipping. Use --force to re-seed.')
    process.exit(0)
  }

  if (existing.length > 0 && force) {
    console.log('[seed] --force: clearing existing data...')
    await db.delete(schema.versionRecords)
    await db.delete(schema.recordObjects)
    await db.delete(schema.versionSchemas)
    await db.delete(schema.versionFiles)
    await db.delete(schema.files)
    await db.delete(schema.schemaLabels)
    await db.delete(schema.schemas)
    await db.delete(schema.versions)
    await db.delete(schema.collections)
    await db.delete(schema.member)
    await db.delete(schema.organization)
    await db.delete(schema.session)
    await db.delete(schema.account)
    await db.delete(schema.user)
  }

  const adminId = 'seed-admin-user'

  await db.insert(schema.user).values({
    id: adminId,
    name: 'Admin',
    email: 'admin@underlay.org',
    emailVerified: true,
  })

  const adminOrgId = uuidv4()
  await db.insert(schema.organization).values({
    id: adminOrgId,
    slug: 'admin',
    name: 'Admin',
    isDefault: true,
  })

  await db.insert(schema.member).values({
    id: crypto.randomUUID(),
    organizationId: adminOrgId,
    userId: adminId,
    role: 'owner',
  })

  const kfId = uuidv4()
  await db.insert(schema.organization).values({
    id: kfId,
    slug: 'knowledge-futures',
    name: 'Knowledge Futures',
    isDefault: false,
  })

  await db.insert(schema.member).values({
    id: crypto.randomUUID(),
    organizationId: kfId,
    userId: adminId,
    role: 'owner',
  })

  console.log('[seed] Created admin user + default org')
  console.log('[seed] Created Knowledge Futures org')

  // --- Collection 1: PubPub Archive ---
  const pubpubId = uuidv4()
  await db.insert(schema.collections).values({
    id: pubpubId,
    organizationId: kfId,
    slug: 'pubpub-archive',
    name: 'PubPub Archive',
    public: true,
  })

  const pubpubSchema = {
    Community: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        subdomain: { type: 'string' },
        description: { type: 'string' },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
    Pub: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        slug: { type: 'string' },
        communityId: { type: 'string', 'x-ref-type': 'Community' },
        doi: { type: 'string' },
        description: { type: 'string' },
        publishedAt: { type: 'string', format: 'date-time' },
        license: { type: 'string' },
      },
    },
    Author: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        orcid: { type: 'string' },
        affiliation: { type: 'string' },
      },
    },
    PubAuthor: {
      type: 'object',
      properties: {
        pubId: { type: 'string', 'x-ref-type': 'Pub' },
        authorId: { type: 'string', 'x-ref-type': 'Author' },
        order: { type: 'integer' },
      },
    },
  }

  const pubpubRecords = [
    {
      recordId: 'community-001',
      type: 'Community',
      data: {
        title: 'Journal of Trial and Error',
        subdomain: 'jtrialerror',
        description:
          'A peer-reviewed journal dedicated to publishing null results, methodological problems, and scientific failures.',
        createdAt: '2020-06-15T00:00:00.000Z',
      },
    },
    {
      recordId: 'community-002',
      type: 'Community',
      data: {
        title: 'Collective Intelligence',
        subdomain: 'collectiveintelligence',
        description:
          'An open-access journal exploring how groups of individuals can collectively solve problems.',
        createdAt: '2021-01-10T00:00:00.000Z',
      },
    },
    {
      recordId: 'community-003',
      type: 'Community',
      data: {
        title: 'Frankenbook',
        subdomain: 'frankenbook',
        description: "A collaborative reading experiment with Mary Shelley's Frankenstein.",
        createdAt: '2018-03-01T00:00:00.000Z',
      },
    },
    {
      recordId: 'author-001',
      type: 'Author',
      data: { name: 'Sean Devine', orcid: '0000-0002-1234-5678', affiliation: 'McGill University' },
    },
    {
      recordId: 'author-002',
      type: 'Author',
      data: {
        name: 'Maha Bali',
        orcid: '0000-0003-9876-5432',
        affiliation: 'American University in Cairo',
      },
    },
    {
      recordId: 'author-003',
      type: 'Author',
      data: {
        name: 'Stefan Müller',
        orcid: '0000-0001-5555-4444',
        affiliation: 'University of Vienna',
      },
    },
    {
      recordId: 'author-004',
      type: 'Author',
      data: { name: "Catherine D'Ignazio", orcid: '0000-0002-8888-7777', affiliation: 'MIT' },
    },
    {
      recordId: 'author-005',
      type: 'Author',
      data: { name: 'Travis Rich', orcid: '0000-0001-0503-5905', affiliation: 'Knowledge Futures' },
    },
    {
      recordId: 'pub-001',
      type: 'Pub',
      data: {
        title: 'The Role of Failure in Scientific Discovery',
        slug: 'role-of-failure',
        communityId: 'community-001',
        doi: '10.36850/e1',
        description: 'An analysis of how failures contribute to the scientific process.',
        publishedAt: '2021-03-15T00:00:00.000Z',
        license: 'CC-BY-4.0',
      },
    },
    {
      recordId: 'pub-002',
      type: 'Pub',
      data: {
        title: 'Collective Memory in Online Communities',
        slug: 'collective-memory',
        communityId: 'community-002',
        doi: '10.36850/ci-2',
        description: 'How online groups form and retain shared knowledge structures.',
        publishedAt: '2022-07-20T00:00:00.000Z',
        license: 'CC-BY-4.0',
      },
    },
    {
      recordId: 'pub-003',
      type: 'Pub',
      data: {
        title: 'Annotating Frankenstein: A Digital Experiment',
        slug: 'annotating-frankenstein',
        communityId: 'community-003',
        doi: '10.21428/frank.001',
        description: "Collaborative annotation of Shelley's Frankenstein using digital tools.",
        publishedAt: '2018-06-01T00:00:00.000Z',
        license: 'CC-BY-4.0',
      },
    },
    {
      recordId: 'pub-004',
      type: 'Pub',
      data: {
        title: 'Open Infrastructure for Open Science',
        slug: 'open-infrastructure',
        communityId: 'community-002',
        doi: '10.36850/ci-4',
        description: 'The case for community-owned scholarly infrastructure.',
        publishedAt: '2023-01-10T00:00:00.000Z',
        license: 'CC-BY-4.0',
      },
    },
    {
      recordId: 'pubauthor-001',
      type: 'PubAuthor',
      data: { pubId: 'pub-001', authorId: 'author-001', order: 1 },
    },
    {
      recordId: 'pubauthor-002',
      type: 'PubAuthor',
      data: { pubId: 'pub-001', authorId: 'author-003', order: 2 },
    },
    {
      recordId: 'pubauthor-003',
      type: 'PubAuthor',
      data: { pubId: 'pub-002', authorId: 'author-002', order: 1 },
    },
    {
      recordId: 'pubauthor-004',
      type: 'PubAuthor',
      data: { pubId: 'pub-003', authorId: 'author-004', order: 1 },
    },
    {
      recordId: 'pubauthor-005',
      type: 'PubAuthor',
      data: { pubId: 'pub-004', authorId: 'author-005', order: 1 },
    },
  ]

  const pubpubSchemaEntries = await upsertSchemas(pubpubSchema)
  const pubpubReadme = `# PubPub Archive\n\nA structured archive of publications from [PubPub](https://www.pubpub.org/) communities, maintained by Knowledge Futures.\n\n## What's included\n\nThis collection contains four record types:\n\n- **Community** — PubPub communities (journals, books, conference proceedings)\n- **Pub** — Individual publications with DOIs, abstracts, and licensing info\n- **Author** — Researcher profiles with ORCID identifiers\n- **PubAuthor** — Join records linking authors to pubs with ordering\n\n## Coverage\n\n| Type | Count |\n|------|-------|\n| Communities | 3 |\n| Publications | 4 |\n| Authors | 5 |\n| Pub-Author links | 5 |\n\n## Source\n\nSample data drawn from real PubPub communities including the Journal of Trial and Error, Collective Intelligence, and Frankenbook.`
  const pubpubMetadata = {
    description:
      'Archive of publications from PubPub communities. Includes pubs, authors, communities, and review data.',
    readme: pubpubReadme,
  }
  const pubpubHash = computeVersionHash(pubpubSchemaEntries, pubpubRecords, [], pubpubMetadata)
  const pubpubTotalBytes = pubpubRecords.reduce(
    (sum, r) => sum + Buffer.byteLength(JSON.stringify(r.data), 'utf-8'),
    0,
  )
  const [pubpubVersion] = await db
    .insert(schema.versions)
    .values({
      collectionId: pubpubId,
      semver: 'v1.0.0',
      major: 1,
      minor: 0,
      patch: 0,
      hash: pubpubHash,
      baseSemver: null,
      message: 'Initial PubPub archive import',
      metadata: pubpubMetadata,
      pushedBy: adminId,
      appId: 'underlay-seed/1.0',
      actorId: 'admin',
      recordCount: pubpubRecords.length,
      fileCount: 0,
      totalBytes: pubpubTotalBytes,
    })
    .returning()

  await db.insert(schema.versionSchemas).values(
    pubpubSchemaEntries.map((e) => ({
      versionId: pubpubVersion!.id,
      slug: e.slug,
      schemaId: e.schemaId,
    })),
  )

  await insertRecords(pubpubVersion!.id, pubpubRecords)

  console.log('[seed] Created collection: knowledge-futures/pubpub-archive v1 (17 records)')

  // --- PubPub Archive v1.1.0 (minor: record changes, same schema) ---
  const pubpubV2Records = [
    // Carried forward (unchanged)
    ...pubpubRecords.filter((r) => r.recordId !== 'pub-001' && r.recordId !== 'pubauthor-002'),
    // Updated: pub-001 gets a revised description
    {
      recordId: 'pub-001',
      type: 'Pub',
      data: {
        title: 'The Role of Failure in Scientific Discovery',
        slug: 'role-of-failure',
        communityId: 'community-001',
        doi: '10.36850/e1',
        description:
          'A revised analysis of how systematic failures contribute to and accelerate the scientific process, with new case studies from 2024.',
        publishedAt: '2021-03-15T00:00:00.000Z',
        license: 'CC-BY-4.0',
      },
    },
    // Added: new author
    {
      recordId: 'author-006',
      type: 'Author',
      data: {
        name: 'Lisa Nakamura',
        orcid: '0000-0002-3333-6666',
        affiliation: 'University of Michigan',
      },
    },
    // Added: new pub
    {
      recordId: 'pub-005',
      type: 'Pub',
      data: {
        title: 'Digital Race and Platform Epistemology',
        slug: 'digital-race-platform',
        communityId: 'community-002',
        doi: '10.36850/ci-5',
        description:
          'How racial categorization is encoded in platform architectures and what that means for collective knowledge production.',
        publishedAt: '2024-09-01T00:00:00.000Z',
        license: 'CC-BY-4.0',
      },
    },
    // Added: link new author to new pub
    {
      recordId: 'pubauthor-006',
      type: 'PubAuthor',
      data: { pubId: 'pub-005', authorId: 'author-006', order: 1 },
    },
    // Removed: pubauthor-002 (dropped by filtering above)
  ]

  const pubpubV2Hash = computeVersionHash(pubpubSchemaEntries, pubpubV2Records, [], pubpubMetadata)
  const pubpubV2TotalBytes = pubpubV2Records.reduce(
    (sum, r) => sum + Buffer.byteLength(JSON.stringify(r.data), 'utf-8'),
    0,
  )
  const [pubpubV2] = await db
    .insert(schema.versions)
    .values({
      collectionId: pubpubId,
      semver: 'v1.1.0',
      major: 1,
      minor: 1,
      patch: 0,
      hash: pubpubV2Hash,
      baseSemver: 'v1.0.0',
      message: 'Add Nakamura pub, update failure paper description, remove duplicate author link',
      metadata: pubpubMetadata,
      pushedBy: adminId,
      appId: 'underlay-seed/1.0',
      actorId: 'admin',
      recordCount: pubpubV2Records.length,
      fileCount: 0,
      totalBytes: pubpubV2TotalBytes,
    })
    .returning()

  await db.insert(schema.versionSchemas).values(
    pubpubSchemaEntries.map((e) => ({
      versionId: pubpubV2!.id,
      slug: e.slug,
      schemaId: e.schemaId,
    })),
  )

  await insertRecords(pubpubV2!.id, pubpubV2Records)

  console.log('[seed] Created collection: knowledge-futures/pubpub-archive v1.1.0 (minor)')

  // --- PubPub Archive v2.0.0 (major: schema change — add Review type + abstract field) ---
  const pubpubV3Schema = {
    Community: pubpubSchema.Community,
    Pub: {
      type: 'object',
      properties: {
        ...pubpubSchema.Pub.properties,
        abstract: { type: 'string' },
      },
    },
    Author: pubpubSchema.Author,
    PubAuthor: pubpubSchema.PubAuthor,
    Review: {
      type: 'object',
      properties: {
        pubId: { type: 'string', 'x-ref-type': 'Pub' },
        reviewerId: { type: 'string', 'x-ref-type': 'Author' },
        recommendation: { type: 'string' },
        comment: { type: 'string' },
        submittedAt: { type: 'string', format: 'date-time' },
      },
    },
  }

  const pubpubV3Records = [
    // Carry forward all v2 records, but update pubs to include abstract
    ...pubpubV2Records.filter((r) => r.type !== 'Pub'),
    // Pubs with abstracts added
    {
      recordId: 'pub-001',
      type: 'Pub',
      data: {
        title: 'The Role of Failure in Scientific Discovery',
        slug: 'role-of-failure',
        communityId: 'community-001',
        doi: '10.36850/e1',
        description:
          'A revised analysis of how systematic failures contribute to and accelerate the scientific process, with new case studies from 2024.',
        publishedAt: '2021-03-15T00:00:00.000Z',
        license: 'CC-BY-4.0',
        abstract:
          'We examine the epistemological role of failure in scientific research through case studies spanning experimental physics, drug discovery, and climate modeling.',
      },
    },
    {
      recordId: 'pub-002',
      type: 'Pub',
      data: {
        title: 'Collective Memory in Online Communities',
        slug: 'collective-memory',
        communityId: 'community-002',
        doi: '10.36850/ci-2',
        description: 'How online groups form and retain shared knowledge structures.',
        publishedAt: '2022-07-20T00:00:00.000Z',
        license: 'CC-BY-4.0',
        abstract:
          'Drawing on Halbwachs and computational methods, we analyze how online communities construct and maintain collective memory through repeated interaction.',
      },
    },
    {
      recordId: 'pub-003',
      type: 'Pub',
      data: {
        title: 'Annotating Frankenstein: A Digital Experiment',
        slug: 'annotating-frankenstein',
        communityId: 'community-003',
        doi: '10.21428/frank.001',
        description: "Collaborative annotation of Shelley's Frankenstein using digital tools.",
        publishedAt: '2018-06-01T00:00:00.000Z',
        license: 'CC-BY-4.0',
        abstract:
          "A collaborative reading experiment inviting scholars and the public to annotate Mary Shelley's Frankenstein using digital annotation tools.",
      },
    },
    {
      recordId: 'pub-004',
      type: 'Pub',
      data: {
        title: 'Open Infrastructure for Open Science',
        slug: 'open-infrastructure',
        communityId: 'community-002',
        doi: '10.36850/ci-4',
        description: 'The case for community-owned scholarly infrastructure.',
        publishedAt: '2023-01-10T00:00:00.000Z',
        license: 'CC-BY-4.0',
        abstract:
          'We argue that scholarly communication infrastructure should be owned and governed by the academic community rather than commercial entities.',
      },
    },
    {
      recordId: 'pub-005',
      type: 'Pub',
      data: {
        title: 'Digital Race and Platform Epistemology',
        slug: 'digital-race-platform',
        communityId: 'community-002',
        doi: '10.36850/ci-5',
        description:
          'How racial categorization is encoded in platform architectures and what that means for collective knowledge production.',
        publishedAt: '2024-09-01T00:00:00.000Z',
        license: 'CC-BY-4.0',
        abstract:
          'An examination of how race is constructed through platform design choices, taxonomies, and algorithmic systems, and its implications for epistemic justice.',
      },
    },
    // New: reviews
    {
      recordId: 'review-001',
      type: 'Review',
      data: {
        pubId: 'pub-001',
        reviewerId: 'author-002',
        recommendation: 'accept',
        comment:
          'Excellent revision. The new case studies strengthen the argument considerably. Minor copyediting needed in section 3.',
        submittedAt: '2024-12-01T10:00:00.000Z',
      },
    },
    {
      recordId: 'review-002',
      type: 'Review',
      data: {
        pubId: 'pub-005',
        reviewerId: 'author-005',
        recommendation: 'minor-revisions',
        comment:
          'Important contribution. The connection between platform epistemology and knowledge infrastructure deserves more development in the discussion section.',
        submittedAt: '2024-10-15T14:30:00.000Z',
      },
    },
    {
      recordId: 'review-003',
      type: 'Review',
      data: {
        pubId: 'pub-002',
        reviewerId: 'author-003',
        recommendation: 'accept',
        comment:
          'Compelling use of computational methods to study collective memory. The Halbwachs framing is well-integrated.',
        submittedAt: '2022-05-20T09:00:00.000Z',
      },
    },
  ]

  const pubpubV3SchemaEntries = await upsertSchemas(pubpubV3Schema)
  const pubpubV3Hash = computeVersionHash(
    pubpubV3SchemaEntries,
    pubpubV3Records,
    [],
    pubpubMetadata,
  )
  const pubpubV3TotalBytes = pubpubV3Records.reduce(
    (sum, r) => sum + Buffer.byteLength(JSON.stringify(r.data), 'utf-8'),
    0,
  )
  const [pubpubV3] = await db
    .insert(schema.versions)
    .values({
      collectionId: pubpubId,
      semver: 'v2.0.0',
      major: 2,
      minor: 0,
      patch: 0,
      hash: pubpubV3Hash,
      baseSemver: 'v1.1.0',
      message: 'Add abstracts to pubs, add Review type with peer review data',
      metadata: pubpubMetadata,
      pushedBy: adminId,
      appId: 'underlay-seed/1.0',
      actorId: 'admin',
      recordCount: pubpubV3Records.length,
      fileCount: 0,
      totalBytes: pubpubV3TotalBytes,
    })
    .returning()

  await db.insert(schema.versionSchemas).values(
    pubpubV3SchemaEntries.map((e) => ({
      versionId: pubpubV3!.id,
      slug: e.slug,
      schemaId: e.schemaId,
    })),
  )

  await insertRecords(pubpubV3!.id, pubpubV3Records)

  console.log('[seed] Created collection: knowledge-futures/pubpub-archive v2.0.0 (major)')

  // --- Collection 2: Open Grants ---
  const grantsId = uuidv4()
  await db.insert(schema.collections).values({
    id: grantsId,
    organizationId: kfId,
    slug: 'open-grants',
    name: 'Open Grants Dataset',
    public: true,
  })

  const grantsSchema = {
    Funder: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        country: { type: 'string' },
        url: { type: 'string' },
      },
    },
    Grant: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        funderId: { type: 'string', 'x-ref-type': 'Funder' },
        piName: { type: 'string' },
        institution: { type: 'string' },
        amount: { type: 'number' },
        currency: { type: 'string' },
        startDate: { type: 'string', format: 'date' },
        endDate: { type: 'string', format: 'date' },
        abstract: { type: 'string' },
        topics: { type: 'array', items: { type: 'string' } },
      },
    },
  }

  const grantsRecords = [
    {
      recordId: 'funder-001',
      type: 'Funder',
      data: { name: 'National Science Foundation', country: 'US', url: 'https://nsf.gov' },
    },
    {
      recordId: 'funder-002',
      type: 'Funder',
      data: { name: 'Wellcome Trust', country: 'UK', url: 'https://wellcome.org' },
    },
    {
      recordId: 'funder-003',
      type: 'Funder',
      data: { name: 'Alfred P. Sloan Foundation', country: 'US', url: 'https://sloan.org' },
    },
    {
      recordId: 'grant-001',
      type: 'Grant',
      data: {
        title: 'Infrastructure for Open Scholarly Communication',
        funderId: 'funder-003',
        piName: 'Kathleen Fitzpatrick',
        institution: 'Michigan State University',
        amount: 750000,
        currency: 'USD',
        startDate: '2022-01-01',
        endDate: '2024-12-31',
        abstract: 'Building sustainable infrastructure for open access scholarly publishing.',
        topics: ['open access', 'scholarly communication', 'infrastructure'],
      },
    },
    {
      recordId: 'grant-002',
      type: 'Grant',
      data: {
        title: 'Machine Learning for Knowledge Graph Construction',
        funderId: 'funder-001',
        piName: 'James Chen',
        institution: 'Stanford University',
        amount: 1200000,
        currency: 'USD',
        startDate: '2023-06-01',
        endDate: '2026-05-31',
        abstract:
          'Developing ML techniques for automated construction and maintenance of scientific knowledge graphs.',
        topics: ['machine learning', 'knowledge graphs', 'NLP'],
      },
    },
    {
      recordId: 'grant-003',
      type: 'Grant',
      data: {
        title: 'Open Science Metrics and Incentives',
        funderId: 'funder-002',
        piName: 'Sarah Jones',
        institution: 'University of Edinburgh',
        amount: 450000,
        currency: 'GBP',
        startDate: '2023-09-01',
        endDate: '2025-08-31',
        abstract:
          'Studying how metrics and incentive structures affect the adoption of open science practices.',
        topics: ['open science', 'metrics', 'research policy'],
      },
    },
    {
      recordId: 'grant-004',
      type: 'Grant',
      data: {
        title: 'Decentralized Identifiers for Research Outputs',
        funderId: 'funder-001',
        piName: 'Maria Rodriguez',
        institution: 'MIT',
        amount: 580000,
        currency: 'USD',
        startDate: '2024-01-01',
        endDate: '2026-12-31',
        abstract:
          'Implementing decentralized identifier systems for research outputs and datasets.',
        topics: ['persistent identifiers', 'decentralization', 'research data'],
      },
    },
    {
      recordId: 'grant-005',
      type: 'Grant',
      data: {
        title: 'Community-Owned Publishing Platforms',
        funderId: 'funder-003',
        piName: 'Travis Rich',
        institution: 'Knowledge Futures',
        amount: 500000,
        currency: 'USD',
        startDate: '2024-03-01',
        endDate: '2026-02-28',
        abstract:
          'Developing open-source tools for community-owned scholarly publishing and archiving.',
        topics: ['publishing', 'open source', 'community ownership'],
      },
    },
  ]

  const grantsSchemaEntries = await upsertSchemas(grantsSchema)
  const grantsReadme = `# Open Grants Dataset\n\nA curated dataset of research grants with funding amounts, topics, and PI information sourced from public funders.\n\n## What's included\n\n- **Funder** — Funding organizations (NSF, Wellcome Trust, Sloan Foundation)\n- **Grant** — Individual grants with title, PI, institution, amount, dates, abstract, and topic tags\n\n## Coverage\n\n| Type | Count |\n|------|-------|\n| Funders | 3 |\n| Grants | 5 |\n\nGrants span 2022–2026 across the US and UK, covering topics like open access, machine learning, knowledge graphs, and decentralized identifiers.\n\n## Source\n\nSample data based on publicly available grant information from NSF, Wellcome Trust, and the Alfred P. Sloan Foundation.`
  const grantsMetadata = {
    description:
      'A curated dataset of research grants with funding amounts, topics, and PI information. Sourced from public funders.',
    readme: grantsReadme,
  }
  const grantsHash = computeVersionHash(grantsSchemaEntries, grantsRecords, [], grantsMetadata)
  const grantsTotalBytes = grantsRecords.reduce(
    (sum, r) => sum + Buffer.byteLength(JSON.stringify(r.data), 'utf-8'),
    0,
  )
  const [grantsVersion] = await db
    .insert(schema.versions)
    .values({
      collectionId: grantsId,
      semver: 'v1.0.0',
      major: 1,
      minor: 0,
      patch: 0,
      hash: grantsHash,
      baseSemver: null,
      message: 'Initial grants dataset',
      metadata: grantsMetadata,
      pushedBy: adminId,
      appId: 'underlay-seed/1.0',
      actorId: 'admin',
      recordCount: grantsRecords.length,
      fileCount: 0,
      totalBytes: grantsTotalBytes,
    })
    .returning()

  await db.insert(schema.versionSchemas).values(
    grantsSchemaEntries.map((e) => ({
      versionId: grantsVersion!.id,
      slug: e.slug,
      schemaId: e.schemaId,
    })),
  )

  await insertRecords(grantsVersion!.id, grantsRecords)

  console.log('[seed] Created collection: knowledge-futures/open-grants (8 records)')

  // --- Collection 3: Climate Observations ---
  const climateId = uuidv4()
  await db.insert(schema.collections).values({
    id: climateId,
    organizationId: kfId,
    slug: 'climate-observations',
    name: 'Global Climate Observations',
    public: true,
  })

  const climateSchema = {
    Station: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        country: { type: 'string' },
        latitude: { type: 'number' },
        longitude: { type: 'number' },
        elevation: { type: 'number' },
      },
    },
    Observation: {
      type: 'object',
      properties: {
        stationId: { type: 'string', 'x-ref-type': 'Station' },
        year: { type: 'integer' },
        meanTempC: { type: 'number' },
        precipitationMm: { type: 'number' },
        daysAbove30C: { type: 'integer' },
        daysBelow0C: { type: 'integer' },
      },
    },
  }

  const climateRecords = [
    {
      recordId: 'station-001',
      type: 'Station',
      data: {
        name: 'Mauna Loa Observatory',
        country: 'US',
        latitude: 19.536,
        longitude: -155.576,
        elevation: 3397,
      },
    },
    {
      recordId: 'station-002',
      type: 'Station',
      data: {
        name: 'Cape Grim',
        country: 'AU',
        latitude: -40.683,
        longitude: 144.689,
        elevation: 94,
      },
    },
    {
      recordId: 'station-003',
      type: 'Station',
      data: {
        name: 'Ny-Ålesund',
        country: 'NO',
        latitude: 78.923,
        longitude: 11.923,
        elevation: 11,
      },
    },
    {
      recordId: 'station-004',
      type: 'Station',
      data: {
        name: 'Izaña Observatory',
        country: 'ES',
        latitude: 28.309,
        longitude: -16.499,
        elevation: 2373,
      },
    },
    {
      recordId: 'obs-001',
      type: 'Observation',
      data: {
        stationId: 'station-001',
        year: 2023,
        meanTempC: 7.2,
        precipitationMm: 432,
        daysAbove30C: 0,
        daysBelow0C: 95,
      },
    },
    {
      recordId: 'obs-002',
      type: 'Observation',
      data: {
        stationId: 'station-001',
        year: 2024,
        meanTempC: 7.5,
        precipitationMm: 410,
        daysAbove30C: 0,
        daysBelow0C: 89,
      },
    },
    {
      recordId: 'obs-003',
      type: 'Observation',
      data: {
        stationId: 'station-002',
        year: 2023,
        meanTempC: 12.8,
        precipitationMm: 890,
        daysAbove30C: 2,
        daysBelow0C: 12,
      },
    },
    {
      recordId: 'obs-004',
      type: 'Observation',
      data: {
        stationId: 'station-002',
        year: 2024,
        meanTempC: 13.1,
        precipitationMm: 875,
        daysAbove30C: 4,
        daysBelow0C: 10,
      },
    },
    {
      recordId: 'obs-005',
      type: 'Observation',
      data: {
        stationId: 'station-003',
        year: 2023,
        meanTempC: -4.2,
        precipitationMm: 385,
        daysAbove30C: 0,
        daysBelow0C: 248,
      },
    },
    {
      recordId: 'obs-006',
      type: 'Observation',
      data: {
        stationId: 'station-003',
        year: 2024,
        meanTempC: -3.8,
        precipitationMm: 402,
        daysAbove30C: 0,
        daysBelow0C: 240,
      },
    },
    {
      recordId: 'obs-007',
      type: 'Observation',
      data: {
        stationId: 'station-004',
        year: 2023,
        meanTempC: 10.5,
        precipitationMm: 290,
        daysAbove30C: 5,
        daysBelow0C: 22,
      },
    },
    {
      recordId: 'obs-008',
      type: 'Observation',
      data: {
        stationId: 'station-004',
        year: 2024,
        meanTempC: 10.9,
        precipitationMm: 278,
        daysAbove30C: 8,
        daysBelow0C: 18,
      },
    },
  ]

  const climateSchemaEntries = await upsertSchemas(climateSchema)
  const climateReadme = `# Global Climate Observations\n\nStructured records of climate monitoring stations and their annual temperature and precipitation observations.\n\n## What's included\n\n- **Station** — Monitoring stations with name, country, coordinates, and elevation\n- **Observation** — Annual readings per station: mean temperature, precipitation, and extreme day counts\n\n## Coverage\n\n| Station | Country | Elevation | Years |\n|---------|---------|-----------|-------|\n| Mauna Loa Observatory | US | 3,397m | 2023–2024 |\n| Cape Grim | AU | 94m | 2023–2024 |\n| Ny-Ålesund | NO | 11m | 2023–2024 |\n| Izaña Observatory | ES | 2,373m | 2023–2024 |\n\nStations span from Arctic (78°N) to Southern Ocean (40°S), providing a cross-section of global climate conditions.\n\n## Source\n\nSample data based on publicly available observations from the World Meteorological Organization (WMO) Global Atmosphere Watch network.`
  const climateMetadata = {
    description:
      'Structured records of climate monitoring stations and their annual temperature and precipitation observations.',
    readme: climateReadme,
  }
  const climateHash = computeVersionHash(climateSchemaEntries, climateRecords, [], climateMetadata)
  const climateTotalBytes = climateRecords.reduce(
    (sum, r) => sum + Buffer.byteLength(JSON.stringify(r.data), 'utf-8'),
    0,
  )
  const [climateVersion] = await db
    .insert(schema.versions)
    .values({
      collectionId: climateId,
      semver: 'v1.0.0',
      major: 1,
      minor: 0,
      patch: 0,
      hash: climateHash,
      baseSemver: null,
      message: 'Initial climate observations — 4 stations, 2023-2024 data',
      metadata: climateMetadata,
      pushedBy: adminId,
      appId: 'underlay-seed/1.0',
      actorId: 'admin',
      recordCount: climateRecords.length,
      fileCount: 0,
      totalBytes: climateTotalBytes,
    })
    .returning()

  await db.insert(schema.versionSchemas).values(
    climateSchemaEntries.map((e) => ({
      versionId: climateVersion!.id,
      slug: e.slug,
      schemaId: e.schemaId,
    })),
  )

  await insertRecords(climateVersion!.id, climateRecords)

  console.log('[seed] Created collection: knowledge-futures/climate-observations (12 records)')

  // --- Collection 4: Pub Notes (demonstrates cross-collection schema reuse) ---
  const pubnotesId = uuidv4()
  await db.insert(schema.collections).values({
    id: pubnotesId,
    organizationId: kfId,
    slug: 'pub-notes',
    name: 'Pub Notes',
    public: true,
  })

  const pubnotesSchema = {
    Author: {
      // Identical body to pubpub-archive Author → upsertSchemas returns the same schemaId
      type: 'object',
      properties: {
        name: { type: 'string' },
        orcid: { type: 'string' },
        affiliation: { type: 'string' },
      },
    },
    Note: {
      type: 'object',
      properties: {
        authorId: { type: 'string', 'x-ref-type': 'Author' },
        title: { type: 'string' },
        body: { type: 'string' },
        url: { type: 'string', format: 'uri' },
        tags: { type: 'array', items: { type: 'string' } },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
  }

  const pubnotesRecords = [
    {
      recordId: 'author-001',
      type: 'Author',
      data: { name: 'Sean Devine', orcid: '0000-0002-1234-5678', affiliation: 'McGill University' },
    },
    {
      recordId: 'author-002',
      type: 'Author',
      data: {
        name: 'Maha Bali',
        orcid: '0000-0003-9876-5432',
        affiliation: 'American University in Cairo',
      },
    },
    {
      recordId: 'author-003',
      type: 'Author',
      data: { name: "Catherine D'Ignazio", orcid: '0000-0002-8888-7777', affiliation: 'MIT' },
    },
    {
      recordId: 'note-001',
      type: 'Note',
      data: {
        authorId: 'author-001',
        title: 'Notes on failure as a scientific method',
        body: 'The Journal of Trial and Error piece makes a compelling case that failure is not noise to be filtered out but signal to be amplified. Key insight: null results constrain the hypothesis space just as strongly as positive results.',
        url: 'https://journal.trialanderror.org/pub/role-of-failure',
        tags: ['philosophy of science', 'open science', 'failure'],
        createdAt: '2024-03-10T14:22:00.000Z',
      },
    },
    {
      recordId: 'note-002',
      type: 'Note',
      data: {
        authorId: 'author-002',
        title: 'Reflections on open pedagogy',
        body: "Maha Bali's work on equity in open education keeps returning to a core tension: openness can democratize access while simultaneously exposing vulnerable learners to extractive platforms. Worth revisiting with the new data governance lens.",
        url: 'https://hybridpedagogy.org/author/maha-bali/',
        tags: ['open education', 'equity', 'pedagogy'],
        createdAt: '2024-04-02T09:15:00.000Z',
      },
    },
    {
      recordId: 'note-003',
      type: 'Note',
      data: {
        authorId: 'author-003',
        title: 'Data feminism and knowledge infrastructure',
        body: "D'Ignazio's framing of data as always already political maps well onto our underlay design questions. Who decides what counts as a record type? What gets schematized vs. left as freetext? These are power questions.",
        url: 'https://data-feminism.mitpress.mit.edu/',
        tags: ['data feminism', 'knowledge graphs', 'infrastructure'],
        createdAt: '2024-04-18T16:45:00.000Z',
      },
    },
    {
      recordId: 'note-004',
      type: 'Note',
      data: {
        authorId: 'author-001',
        title: 'Follow-up: collective memory paper',
        body: "The collective memory piece draws on Halbwachs in ways I hadn't expected. The argument that online communities form memory through repetition rather than storage resonates with how underlay versions work — it's the diff, not the snapshot, that carries meaning.",
        url: 'https://collectiveintelligence.pubpub.org/pub/collective-memory',
        tags: ['collective intelligence', 'memory', 'versioning'],
        createdAt: '2024-05-05T11:30:00.000Z',
      },
    },
  ]

  const pubnotesReadme = `# Pub Notes\n\nPersonal research notes linked to authors from the [PubPub Archive](../pubpub-archive) collection.\n\n## What's included\n\n- **Author** — Researcher profiles (schema shared with pubpub-archive via content-addressing)\n- **Note** — Annotated reading notes with tags and timestamps\n\n## Coverage\n\n| Type | Count |\n|------|-------|\n| Authors | 3 |\n| Notes | 4 |\n\n## Schema reuse\n\nThe Author schema in this collection is identical to the one in pubpub-archive. Because schemas are content-addressed by hash, both collections reference the same underlying schema row — no duplication.`
  const pubnotesMetadata = {
    description:
      'Personal research notes linked to authors from the PubPub archive. Author schema shared with pubpub-archive via content-addressing.',
    readme: pubnotesReadme,
  }

  const pubnotesSchemaEntries = await upsertSchemas(pubnotesSchema)
  const pubnotesHash = computeVersionHash(
    pubnotesSchemaEntries,
    pubnotesRecords,
    [],
    pubnotesMetadata,
  )
  const pubnotesTotalBytes = pubnotesRecords.reduce(
    (sum, r) => sum + Buffer.byteLength(JSON.stringify(r.data), 'utf-8'),
    0,
  )
  const [pubnotesVersion] = await db
    .insert(schema.versions)
    .values({
      collectionId: pubnotesId,
      semver: 'v1.0.0',
      major: 1,
      minor: 0,
      patch: 0,
      hash: pubnotesHash,
      baseSemver: null,
      message: 'Initial pub notes',
      metadata: pubnotesMetadata,
      pushedBy: adminId,
      appId: 'underlay-seed/1.0',
      actorId: 'admin',
      recordCount: pubnotesRecords.length,
      fileCount: 0,
      totalBytes: pubnotesTotalBytes,
    })
    .returning()

  await db.insert(schema.versionSchemas).values(
    pubnotesSchemaEntries.map((e) => ({
      versionId: pubnotesVersion!.id,
      slug: e.slug,
      schemaId: e.schemaId,
    })),
  )

  await insertRecords(pubnotesVersion!.id, pubnotesRecords)

  console.log('[seed] Created collection: knowledge-futures/pub-notes (7 records)')
  console.log('[seed] Done.')
  process.exit(0)
}

seed().catch((err) => {
  console.error('[seed] Failed:', err)
  process.exit(1)
})
