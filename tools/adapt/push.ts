/**
 * ADAPT Centre → Underlay Push Script
 *
 * Reads scraped data from tools/adapt/data/ and pushes it to an Underlay instance.
 *
 * Usage:
 *   npx tsx tools/adapt/push.ts                          # push to localhost
 *   npx tsx tools/adapt/push.ts --url https://underlay.org  # push to production
 *
 * Prerequisites:
 *   1. Run `npx tsx tools/adapt/scrape.ts` first to generate data
 *   2. Create an "adapt" org account on the target Underlay instance
 *   3. Create an API key with "write" scope for the adapt org
 *   4. Set UNDERLAY_API_KEY=ul_... in your environment
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "data");
const PDF_DIR = join(DATA_DIR, "pdfs");

// --- Config ---

const API_URL = process.argv.includes("--url")
  ? process.argv[process.argv.indexOf("--url") + 1]!
  : "http://localhost:3000";

const API_KEY = process.env.UNDERLAY_API_KEY;
if (!API_KEY) {
  console.error("❌ Set UNDERLAY_API_KEY environment variable");
  process.exit(1);
}

const ORG_SLUG = "adapt";
const APP_ID = "adapt-scraper/1.0";
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
    // 409 = already exists, that's fine for collection creation
    if ((res.status === 409 || res.status === 500) && method === "POST" && path.includes("/collections")) {
      console.log(`    (already exists, continuing)`);
      return data;
    }
    throw new Error(`${method} ${path} → ${res.status}: ${errMsg}`);
  }

  return data;
}

function loadRecords(collection: string): { id: string; type: string; data: unknown }[] {
  // Prefer records-with-files.json if it exists (has $file references)
  const withFiles = join(DATA_DIR, collection, "records-with-files.json");
  if (existsSync(withFiles)) {
    console.log(`  Using records-with-files.json (includes PDF references)`);
    return JSON.parse(readFileSync(withFiles, "utf-8"));
  }
  const path = join(DATA_DIR, collection, "records.json");
  if (!existsSync(path)) {
    console.log(`  ⚠️  No data for ${collection} (${path} not found)`);
    return [];
  }
  return JSON.parse(readFileSync(path, "utf-8"));
}

function loadSchema(collection: string): unknown {
  const path = join(__dirname, "schemas", `${collection}.json`);
  if (!existsSync(path)) {
    throw new Error(`No schema for ${collection} at ${path}`);
  }
  return JSON.parse(readFileSync(path, "utf-8"));
}

// --- File upload ---

async function uploadFiles(collectionOwner: string, collectionSlug: string): Promise<Set<string>> {
  const manifestPath = join(DATA_DIR, "pdf-manifest.json");
  if (!existsSync(manifestPath)) return new Set();

  // Only upload files for collections that have records-with-files
  const recordsWithFiles = join(DATA_DIR, collectionSlug, "records-with-files.json");
  if (!existsSync(recordsWithFiles)) return new Set();

  const manifest: { hash: string; size: number; path: string }[] = JSON.parse(
    readFileSync(manifestPath, "utf-8"),
  );

  if (manifest.length === 0) return new Set();

  console.log(`  Uploading ${manifest.length} PDFs...`);
  let uploaded = 0;
  let skipped = 0;
  let failed = 0;
  let firstError = "";
  const uploadedHashes = new Set<string>();

  for (let i = 0; i < manifest.length; i++) {
    const file = manifest[i]!;
    // Resolve path relative to PDF_DIR (manifest may have host-absolute paths)
    const filePath = join(PDF_DIR, `${file.hash}.pdf`);

    if (!existsSync(filePath)) {
      if (!firstError) firstError = `File not found: ${filePath}`;
      failed++;
      continue;
    }

    const url = `${API_URL}/api/collections/${collectionOwner}/${collectionSlug}/files/sha256:${file.hash}`;

    try {
      // Check if already uploaded
      const head = await fetch(url, {
        method: "HEAD",
        headers: { Authorization: `Bearer ${API_KEY}` },
      });

      if (head.ok) {
        skipped++;
        uploadedHashes.add(file.hash);
      } else {
        const buffer = readFileSync(filePath);

        // Verify hash before upload
        const computed = createHash("sha256").update(buffer).digest("hex");
        if (computed !== file.hash) {
          console.log(`    ⚠️ Hash mismatch for ${file.hash}, skipping`);
          failed++;
          continue;
        }

        const res = await fetch(url, {
          method: "PUT",
          headers: {
            "Content-Type": "application/pdf",
            Authorization: `Bearer ${API_KEY}`,
          },
          body: buffer,
        });

        if (res.ok) {
          uploaded++;
          uploadedHashes.add(file.hash);
        } else {
          const errBody = await res.text().catch(() => "");
          if (!firstError) firstError = `PUT ${res.status}: ${errBody.slice(0, 200)}`;
          failed++;
        }
      }
    } catch (err) {
      if (!firstError) firstError = String(err);
      failed++;
    }

    // Progress every 50 files
    const total = uploaded + skipped + failed;
    if (total % 50 === 0) {
      console.log(`    Progress: ${total}/${manifest.length} — ${uploaded} new, ${skipped} cached, ${failed} failed`);
    }
  }

  console.log(`  Files: ${uploaded} uploaded, ${skipped} already existed, ${failed} failed`);
  if (firstError) console.log(`  First error: ${firstError}`);
  return uploadedHashes;
}

// --- Push a single collection ---

async function pushCollection(slug: string, name: string, description: string) {
  console.log(`\n📦 ${name} (${ORG_SLUG}/${slug})`);

  // Ensure collection exists
  console.log(`  Creating collection...`);
  await api("POST", `/accounts/${ORG_SLUG}/collections`, {
    slug,
    name,
    description,
    public: true,
  });

  // Check latest version
  let baseVersion: number | null = null;
  try {
    const existing = (await api("GET", `/collections/${ORG_SLUG}/${slug}/versions/latest`)) as any;
    if (existing?.version) {
      baseVersion = existing.version;
      console.log(`  Existing version: ${baseVersion}`);
    }
  } catch {
    // 404 = no versions yet, that's expected
  }

  // Upload files if this is a collection with PDFs
  const uploadedHashes = await uploadFiles(ORG_SLUG, slug);
  if (uploadedHashes.size > 0) {
    console.log(`  📎 ${uploadedHashes.size} files ready`);
  }

  // Load data
  let records = loadRecords(slug);
  if (records.length === 0) return;

  // Strip $file references for files that failed to upload
  if (uploadedHashes.size > 0) {
    let stripped = 0;
    records = records.map((rec) => {
      const data = rec.data as Record<string, unknown>;
      if (data.pdf && typeof data.pdf === "object" && "$file" in (data.pdf as any)) {
        const hash = ((data.pdf as any).$file as string).replace("sha256:", "");
        if (!uploadedHashes.has(hash)) {
          stripped++;
          const { pdf, pdf_size, ...rest } = data;
          return { ...rec, data: rest };
        }
      }
      return rec;
    });
    if (stripped > 0) console.log(`  Stripped ${stripped} missing file references`);
  }

  const schema = loadSchema(slug);

  console.log(`  Pushing ${records.length} records (base: ${baseVersion ?? 'none'})...`);
  const isUpdate = baseVersion !== null;
  const result = await api("POST", `/collections/${ORG_SLUG}/${slug}/versions`, {
    base_version: baseVersion,
    message: isUpdate
      ? `Update with archived PDFs — ${new Date().toISOString().split("T")[0]}`
      : `Initial import from adaptcentre.ie — ${new Date().toISOString().split("T")[0]}`,
    app_id: APP_ID,
    actor_id: ACTOR_ID,
    schema,
    changes: isUpdate
      ? { updated: records }
      : { added: records },
  });

  const v = result as { version: number; semver: string; hash: string; recordCount: number };
  console.log(`  ✅ Version ${v.version} (${v.semver}) — ${v.recordCount} records — hash: ${v.hash?.slice(0, 16)}...`);
}

// --- Main ---

async function main() {
  console.log("🏛️  ADAPT → Underlay Push");
  console.log(`   Target: ${API_URL}`);
  console.log(`   Org:    ${ORG_SLUG}`);
  console.log(`   App ID: ${APP_ID}`);

  // Push each collection
  await pushCollection(
    "team",
    "ADAPT Team",
    "Researchers, investigators, and staff of the ADAPT Centre at Trinity College Dublin.",
  );

  await pushCollection(
    "publications",
    "ADAPT Publications",
    "Peer-reviewed papers, conference proceedings, book chapters, and other research outputs from the ADAPT Centre.",
  );

  console.log("\n✅ All collections pushed!");
  console.log(`   Browse at: ${API_URL.replace(/:\d+$/, ":4321")}/${ORG_SLUG}`);
}

main().catch((err) => {
  console.error("❌ Push failed:", err);
  process.exit(1);
});
