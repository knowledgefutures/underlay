/**
 * Vanderbilt TV News → Underlay Push Script
 *
 * Reads scraped segment data and pushes it to an Underlay instance.
 * Tracks what has already been pushed to only send new records,
 * and batches large pushes into multiple versions.
 *
 * Usage:
 *   npx tsx tools/tvnews/push.ts                          # push to localhost
 *   npx tsx tools/tvnews/push.ts --url https://underlay.org  # push to production
 *
 * Prerequisites:
 *   1. Run `npx tsx tools/tvnews/scrape.ts` first to generate data
 *   2. Ensure the "vanderbilt" account exists on the target instance
 *   3. Set UNDERLAY_API_KEY=ul_... in your environment
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "data");
const PUSHED_IDS_PATH = join(DATA_DIR, "pushed-ids.json");

// Max records per version push (avoid payload too large)
const BATCH_SIZE = 5000;

// --- Config ---

const API_URL = process.argv.includes("--url")
  ? process.argv[process.argv.indexOf("--url") + 1]!
  : "http://localhost:3000";

const API_KEY = process.env.UNDERLAY_API_KEY;
if (!API_KEY) {
  console.error("❌ Set UNDERLAY_API_KEY environment variable");
  process.exit(1);
}

const ORG_SLUG = "vanderbilt";
const COLLECTION_SLUG = "tvnews";
const APP_ID = "tvnews-scraper/1.0";
const ACTOR_ID = process.env.USER ?? "scraper";

// --- Helpers ---

async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  const url = `${API_URL}/api${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const errMsg = (data as any)?.error ?? res.statusText;
    if ((res.status === 409 || res.status === 500) && method === "POST" && path.includes("/collections") && !path.endsWith("/versions")) {
      console.log(`    (collection already exists, continuing)`);
      return data;
    }
    if (res.status === 409 && method === "POST" && path.endsWith("/versions")) {
      console.log(`    ⏭ ${errMsg} — skipping`);
      return data;
    }
    throw new Error(`${method} ${path} → ${res.status}: ${errMsg}`);
  }

  return data;
}

function loadSchema(): unknown {
  const path = join(__dirname, "schemas", "segments.json");
  if (!existsSync(path)) {
    throw new Error(`No schema at ${path}`);
  }
  return JSON.parse(readFileSync(path, "utf-8"));
}

function loadPushedIds(): Set<string> {
  if (existsSync(PUSHED_IDS_PATH)) {
    return new Set(JSON.parse(readFileSync(PUSHED_IDS_PATH, "utf-8")));
  }
  return new Set();
}

function savePushedIds(ids: Set<string>) {
  writeFileSync(PUSHED_IDS_PATH, JSON.stringify([...ids]));
}

// --- Main ---

async function main() {
  console.log("📺 Vanderbilt TV News → Underlay Push");
  console.log(`   Target: ${API_URL}`);
  console.log(`   Account: ${ORG_SLUG}`);
  console.log(`   Collection: ${COLLECTION_SLUG}`);
  console.log();

  // Load scraped data
  const segmentsPath = join(DATA_DIR, "segments.json");
  if (!existsSync(segmentsPath)) {
    console.error(`❌ No data found at ${segmentsPath}`);
    console.error(`   Run: npx tsx tools/tvnews/scrape.ts`);
    process.exit(1);
  }

  const allSegments = JSON.parse(readFileSync(segmentsPath, "utf-8")) as {
    id: string;
    type: string;
    data: unknown;
  }[];
  console.log(`   Total segments in file: ${allSegments.length}`);

  // Filter to only new records
  const pushedIds = loadPushedIds();
  const newSegments = allSegments.filter((s) => !pushedIds.has(s.id));
  console.log(`   Already pushed: ${pushedIds.size}`);
  console.log(`   New to push: ${newSegments.length}`);

  if (newSegments.length === 0) {
    console.log("\n   Nothing new to push.");
    return;
  }

  // Ensure collection exists
  console.log(`\n📦 Creating collection ${ORG_SLUG}/${COLLECTION_SLUG}...`);
  await api("POST", `/accounts/${ORG_SLUG}/collections`, {
    slug: COLLECTION_SLUG,
    name: "Vanderbilt Television News Archive",
    description:
      "Metadata and abstracts from the Vanderbilt Television News Archive, which has recorded US national television news since August 5, 1968.",
    public: true,
  });

  const schema = loadSchema();

  const readme = `# Vanderbilt Television News Archive

A subset of news segment records from the [Vanderbilt Television News Archive](https://tvnews.vanderbilt.edu/), which has recorded US national television news since August 5, 1968.

## About

The archive preserves daily evening news programs from ABC, CBS, and NBC (since 1968), CNN (since 1995), and Fox News (since 2004). It contains over 965,000 individual segments across 97,000+ broadcasts.

This collection contains structured metadata for a subset of those segments.

## What's Included

Each record represents a single news segment (clip) with the following fields:

- Title (headline or topic)
- Network
- Air date
- Abstract (description of the segment content)
- Reporters
- Duration
- Program ID (link to parent broadcast)

## Source

Metadata scraped from publicly available abstracts at [tvnews.vanderbilt.edu](https://tvnews.vanderbilt.edu/). Video content is not included and requires sponsorship access.

## Schema

Records use the \`segment\` type. See the schema for full field definitions.
`;

  // Push in batches
  const batches = [];
  for (let i = 0; i < newSegments.length; i += BATCH_SIZE) {
    batches.push(newSegments.slice(i, i + BATCH_SIZE));
  }

  console.log(`\n   Pushing ${newSegments.length} new records in ${batches.length} batch(es)...`);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]!;

    // Get current base version for each batch
    let baseVersion: number | null = null;
    try {
      const existing = (await api("GET", `/collections/${ORG_SLUG}/${COLLECTION_SLUG}/versions/latest`)) as any;
      if (existing?.number) {
        baseVersion = existing.number;
      }
    } catch {
      // No versions yet
    }

    const isFirst = baseVersion === null;
    const message = isFirst
      ? `Initial import — ${batch.length} segments from tvnews.vanderbilt.edu`
      : `Add ${batch.length} segments (batch ${i + 1}/${batches.length})`;

    console.log(`\n   Batch ${i + 1}/${batches.length}: ${batch.length} records (base: ${baseVersion ?? "none"})...`);

    const versionPayload: Record<string, unknown> = {
      base_version: baseVersion,
      message,
      readme,
      app_id: APP_ID,
      actor_id: ACTOR_ID,
      changes: { added: batch },
    };

    if (isFirst) {
      versionPayload.schema = schema;
    }

    const result = await api("POST", `/collections/${ORG_SLUG}/${COLLECTION_SLUG}/versions`, versionPayload);

    const v = result as {
      version?: number;
      semver?: string;
      hash?: string;
      recordCount?: number;
      existingVersion?: number;
    };

    if (v.existingVersion) {
      console.log(`   ✅ No changes — version ${v.existingVersion} already up to date`);
    } else {
      console.log(`   ✅ Version ${v.version} (${v.semver}) — ${v.recordCount} records`);
    }

    // Track pushed IDs
    for (const seg of batch) {
      pushedIds.add(seg.id);
    }
    savePushedIds(pushedIds);
  }

  console.log(`\n   Done. ${pushedIds.size} total records pushed.`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
