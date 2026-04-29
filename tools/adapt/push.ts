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
const HTML_DIR = join(DATA_DIR, "publications", "html");

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
    // 409 = already exists, that's fine for collection creation (not version pushes)
    if ((res.status === 409 || res.status === 500) && method === "POST" && path.includes("/collections") && !path.endsWith("/versions")) {
      console.log(`    (already exists, continuing)`);
      return data;
    }
    // 409 on version push = no changes detected, skip gracefully
    if (res.status === 409 && method === "POST" && path.endsWith("/versions")) {
      console.log(`    ⏭ ${errMsg} — skipping`);
      return data;
    }
    throw new Error(`${method} ${path} → ${res.status}: ${errMsg}`);
  }

  return data;
}

function loadRecords(collection: string): { id: string; type: string; data: unknown }[] {
  const records: { id: string; type: string; data: unknown }[] = [];

  // Prefer records-with-files.json if it exists (has $file references)
  const withFiles = join(DATA_DIR, collection, "records-with-files.json");
  if (existsSync(withFiles)) {
    console.log(`  Using records-with-files.json (includes PDF references)`);
    records.push(...JSON.parse(readFileSync(withFiles, "utf-8")));
  } else {
    const path = join(DATA_DIR, collection, "records.json");
    if (!existsSync(path)) {
      console.log(`  ⚠️  No data for ${collection} (${path} not found)`);
      return [];
    }
    records.push(...JSON.parse(readFileSync(path, "utf-8")));
  }

  // Also load any additional record files (e.g. case-studies.json)
  const extras = ["case-studies.json"];
  for (const extra of extras) {
    const extraPath = join(DATA_DIR, collection, extra);
    if (existsSync(extraPath)) {
      const extraRecords = JSON.parse(readFileSync(extraPath, "utf-8"));
      console.log(`  Also loaded ${extraRecords.length} records from ${extra}`);
      records.push(...extraRecords);
    }
  }

  return records;
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

// --- HTML file upload (case study pages) ---

async function uploadHtmlFiles(collectionOwner: string, collectionSlug: string): Promise<Set<string>> {
  const manifestPath = join(DATA_DIR, collectionSlug, "html-manifest.json");
  if (!existsSync(manifestPath)) return new Set();

  const manifest: { slug: string; hash: string; size: number }[] = JSON.parse(
    readFileSync(manifestPath, "utf-8"),
  );

  if (manifest.length === 0) return new Set();

  console.log(`  Uploading ${manifest.length} HTML files...`);
  let uploaded = 0;
  let skipped = 0;
  let failed = 0;
  const uploadedHashes = new Set<string>();

  for (const file of manifest) {
    const filePath = join(HTML_DIR, `${file.hash}.html`);
    if (!existsSync(filePath)) {
      failed++;
      continue;
    }

    const url = `${API_URL}/api/collections/${collectionOwner}/${collectionSlug}/files/sha256:${file.hash}`;

    try {
      const head = await fetch(url, {
        method: "HEAD",
        headers: { Authorization: `Bearer ${API_KEY}` },
      });

      if (head.ok) {
        skipped++;
        uploadedHashes.add(file.hash);
      } else {
        const buffer = readFileSync(filePath);
        const computed = createHash("sha256").update(buffer).digest("hex");
        if (computed !== file.hash) {
          console.log(`    ⚠️ Hash mismatch for ${file.hash}, skipping`);
          failed++;
          continue;
        }

        const res = await fetch(url, {
          method: "PUT",
          headers: {
            "Content-Type": "text/html",
            Authorization: `Bearer ${API_KEY}`,
          },
          body: buffer,
        });

        if (res.ok) {
          uploaded++;
          uploadedHashes.add(file.hash);
        } else {
          failed++;
        }
      }
    } catch {
      failed++;
    }
  }

  console.log(`  HTML files: ${uploaded} uploaded, ${skipped} cached, ${failed} failed`);
  return uploadedHashes;
}

// --- Push a single collection ---

async function pushCollection(slug: string, name: string, description: string, readme: string) {
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
    if (existing?.number) {
      baseVersion = existing.number;
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

  // Upload HTML files (case studies)
  const htmlHashes = await uploadHtmlFiles(ORG_SLUG, slug);
  if (htmlHashes.size > 0) {
    console.log(`  📄 ${htmlHashes.size} HTML files ready`);
  }

  // Merge all uploaded hashes
  for (const h of htmlHashes) uploadedHashes.add(h);

  // Load data
  let records = loadRecords(slug);
  if (records.length === 0) return;

  // Strip $file references for files that failed to upload
  if (uploadedHashes.size > 0) {
    let stripped = 0;
    records = records.map((rec) => {
      const data = { ...(rec.data as Record<string, unknown>) };
      // Strip missing PDF references
      if (data.pdf && typeof data.pdf === "object" && "$file" in (data.pdf as any)) {
        const hash = ((data.pdf as any).$file as string).replace("sha256:", "");
        if (!uploadedHashes.has(hash)) {
          stripped++;
          delete data.pdf;
          delete data.pdf_size;
          return { ...rec, data };
        }
      }
      // Strip missing HTML references
      if (data.html && typeof data.html === "object" && "$file" in (data.html as any)) {
        const hash = ((data.html as any).$file as string).replace("sha256:", "");
        if (!uploadedHashes.has(hash)) {
          stripped++;
          delete data.html;
          delete data.html_size;
          return { ...rec, data };
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
    readme,
    app_id: APP_ID,
    actor_id: ACTOR_ID,
    schema,
    changes: isUpdate
      ? { updated: records }
      : { added: records },
  });

  const v = result as { version?: number; semver?: string; hash?: string; recordCount?: number; existingVersion?: number };
  if (v.existingVersion) {
    console.log(`  ✅ No changes — version ${v.existingVersion} already up to date`);
  } else {
    console.log(`  ✅ Version ${v.version} (${v.semver}) — ${v.recordCount} records — hash: ${v.hash?.slice(0, 16)}...`);
  }
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
    `# ADAPT Centre Team Directory

A comprehensive directory of **392 researchers, investigators, and staff** affiliated with the [ADAPT Centre](https://www.adaptcentre.ie/) — Ireland's global centre of excellence for AI-driven digital content technology, headquartered at Trinity College Dublin.

## What's included

Each record contains:

- **Name and contact** — full name, email, job title, and affiliation
- **Biography** — researcher bio text from their ADAPT profile
- **Team roles** — principal investigator, funded investigator, research fellow, PhD student, etc.
- **Research domains** — natural language processing, computer vision, knowledge graphs, and more
- **Profile URL** — link to their page on adaptcentre.ie

## Source

Data scraped from the [ADAPT Centre website](https://www.adaptcentre.ie/) WordPress REST API (\`/wp-json/wp/v2/expert\`). Taxonomy IDs resolved to human-readable labels via the WordPress taxonomy endpoints.

## Schema

Records use the \`researcher\` type with fields for name, slug, job_title, affiliation, email, biography, teams (array), research_domains (array), and url.`,
  );

  await pushCollection(
    "publications",
    "ADAPT Publications",
    "Peer-reviewed papers, conference proceedings, case studies, and other research outputs from the ADAPT Centre.",
    `# ADAPT Centre Publications Archive

A versioned archive of **3,402 research publications** and **50 industry case studies** from the [ADAPT Centre](https://www.adaptcentre.ie/), with **618 open-access PDFs** and **50 archived case study HTML pages** preserved as content-addressed files.

## What's included

### Publications

Each publication record contains:

- **Bibliographic metadata** — title, authors, venue, publication date, and type (journal article, conference paper, book chapter, etc.)
- **Source URLs** — links to the original publication page and publisher
- **Archived PDF** — where available, the full-text PDF downloaded from open-access sources (DORAS repository, direct links). Files are stored by SHA-256 hash for deduplication and integrity verification.

### Case Studies

Each case study record contains:

- **Title and subtitle** — the case study name and descriptive tagline
- **Structured sections** — "Industry Challenge", "The ADAPT Solution", "Benefits / Impacts", and other headings with full text
- **Archived HTML** — the full original web page saved as a content-addressed file for long-term preservation
- **Images** — URLs to associated images from the ADAPT website
- **Source URL** — link to the original case study page

## Coverage

| Content | Count |
|---------|-------|
| Publications | 3,402 |
| Case studies | 50 |
| Archived PDFs | 618 |
| Archived HTML pages | 50 |
| Total archive size | ~1.4 GB |

## Source

Publication metadata scraped from the ADAPT Centre WordPress REST API (\`/wp-json/wp/v2/publication\`). Case studies scraped from HTML pages at \`adaptcentre.ie/case-studies/\`. PDFs downloaded from DORAS (Dublin City University's institutional repository) and direct publisher links where open-access versions were available.

## Schema

Two record types:
- \`publication\` — title, slug, authors, venue, date, type, url, source_url, pdf ($file reference), pdf_size
- \`case_study\` — title, slug, subtitle, url, sections (object with heading→text), images (array of URLs), html ($file reference), html_size`,
  );

  console.log("\n✅ All collections pushed!");
  console.log(`   Browse at: ${API_URL.replace(/:\d+$/, ":4321")}/${ORG_SLUG}`);
}

main().catch((err) => {
  console.error("❌ Push failed:", err);
  process.exit(1);
});
