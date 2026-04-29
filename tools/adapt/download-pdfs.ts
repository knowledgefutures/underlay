/**
 * ADAPT Centre PDF Downloader
 *
 * Downloads open-access PDFs for publications that have accessible URLs.
 * Run after scrape.ts to enrich publication data with archived files.
 *
 * Usage: npx tsx tools/adapt/download-pdfs.ts [--limit N] [--concurrency N]
 *
 * Output:
 *   tools/adapt/data/pdfs/<sha256hash>.pdf
 *   tools/adapt/data/publications/records-with-files.json  (updated records)
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "data");
const PDF_DIR = join(DATA_DIR, "pdfs");

const CONCURRENCY = parseInt(
  process.argv.includes("--concurrency")
    ? process.argv[process.argv.indexOf("--concurrency") + 1]!
    : "5",
  10,
);
const LIMIT = process.argv.includes("--limit")
  ? parseInt(process.argv[process.argv.indexOf("--limit") + 1]!, 10)
  : Infinity;

const TIMEOUT_MS = 30_000;
const MAX_PDF_SIZE = 100 * 1024 * 1024; // 100 MB cap

// --- URL classification ---

interface DownloadTarget {
  pubId: string;
  url: string;
  strategy: "direct" | "doras";
}

function classifyUrl(url: string): "direct" | "doras" | "skip" {
  if (!url) return "skip";

  // Direct PDF URLs
  if (url.endsWith(".pdf")) return "direct";

  // Known open-access hosts that serve PDFs at the URL
  const directHosts = [
    "arxiv.org/pdf",
    "aclanthology.org",
    "ceur-ws.org",
  ];
  for (const h of directHosts) {
    if (url.includes(h)) return "direct";
  }

  // DORAS - need to extract PDF link from page
  if (url.includes("doras.dcu.ie")) return "doras";

  // Everything else (paywalled, Cloudflare-blocked, etc.)
  return "skip";
}

// --- Download strategies ---

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Underlay-Archiver/1.0 (research-repository; https://github.com/underlay)",
      },
      redirect: "follow",
    });
  } finally {
    clearTimeout(timer);
  }
}

async function downloadDirect(url: string): Promise<Buffer | null> {
  const res = await fetchWithTimeout(url, TIMEOUT_MS);
  if (!res.ok) return null;

  const ct = res.headers.get("content-type") ?? "";
  // Accept PDF or octet-stream (some servers misconfigure)
  if (!ct.includes("pdf") && !ct.includes("octet-stream")) return null;

  const length = parseInt(res.headers.get("content-length") ?? "0", 10);
  if (length > MAX_PDF_SIZE) return null;

  const buffer = Buffer.from(await res.arrayBuffer());
  // Quick PDF magic check
  if (buffer.length < 5 || buffer.subarray(0, 5).toString() !== "%PDF-") return null;

  return buffer;
}

async function downloadDoras(pageUrl: string): Promise<Buffer | null> {
  // Fetch the DORAS HTML page and extract the PDF link
  const res = await fetchWithTimeout(pageUrl, TIMEOUT_MS);
  if (!res.ok) return null;

  const html = await res.text();
  // DORAS pattern: href="https://doras.dcu.ie/31770/1/filename.pdf"
  const match = html.match(/href="(https:\/\/doras\.dcu\.ie\/[^"]+\.pdf)"/);
  if (!match) return null;

  return downloadDirect(match[1]!);
}

// --- Parallel downloader ---

interface DownloadResult {
  pubId: string;
  hash: string;
  size: number;
  filename: string;
}

async function downloadAll(targets: DownloadTarget[]): Promise<Map<string, DownloadResult>> {
  const results = new Map<string, DownloadResult>();
  let completed = 0;
  let failed = 0;
  let skippedExisting = 0;
  let lastLog = Date.now();

  // Process in batches
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY);
    const promises = batch.map(async (target) => {
      try {
        let buffer: Buffer | null = null;

        if (target.strategy === "direct") {
          buffer = await downloadDirect(target.url);
        } else if (target.strategy === "doras") {
          buffer = await downloadDoras(target.url);
        }

        if (!buffer) {
          failed++;
          return;
        }

        const hash = createHash("sha256").update(buffer).digest("hex");
        const filename = `${hash}.pdf`;
        const filepath = join(PDF_DIR, filename);

        if (existsSync(filepath)) {
          skippedExisting++;
        } else {
          writeFileSync(filepath, buffer);
        }

        results.set(target.pubId, {
          pubId: target.pubId,
          hash,
          size: buffer.length,
          filename,
        });

        completed++;
      } catch {
        failed++;
      }
    });

    await Promise.all(promises);

    // Progress every 10 seconds
    const now = Date.now();
    if (now - lastLog > 10_000 || i + CONCURRENCY >= targets.length) {
      lastLog = now;
      const total = completed + failed + skippedExisting;
      console.log(
        `  Progress: ${total}/${targets.length} — ${completed} downloaded, ${skippedExisting} cached, ${failed} failed`,
      );
    }
  }

  return results;
}

// --- Main ---

async function main() {
  console.log("📥 ADAPT PDF Downloader");
  mkdirSync(PDF_DIR, { recursive: true });

  // Load publication records
  const recordsPath = join(DATA_DIR, "publications", "records.json");
  const records: { id: string; type: string; data: Record<string, string> }[] = JSON.parse(
    readFileSync(recordsPath, "utf-8"),
  );

  console.log(`  Loaded ${records.length} publication records`);

  // Build download targets
  const targets: DownloadTarget[] = [];
  const stats = { direct: 0, doras: 0, skip: 0 };

  for (const rec of records) {
    const url = rec.data.url;
    const strategy = classifyUrl(url);
    stats[strategy]++;

    if (strategy !== "skip") {
      targets.push({ pubId: rec.id, url, strategy });
    }
  }

  console.log(
    `  Targets: ${targets.length} downloadable (${stats.direct} direct, ${stats.doras} DORAS, ${stats.skip} skipped)`,
  );

  const limited = targets.slice(0, LIMIT);
  if (LIMIT < targets.length) {
    console.log(`  Limited to first ${LIMIT} targets`);
  }

  console.log(`  Concurrency: ${CONCURRENCY}`);
  console.log(`  Downloading...\n`);

  const results = await downloadAll(limited);
  console.log(`\n  Downloaded ${results.size} PDFs`);

  // Compute total size
  let totalBytes = 0;
  for (const r of results.values()) totalBytes += r.size;
  console.log(`  Total size: ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);

  // Write updated records with $file references
  const updatedRecords = records.map((rec) => {
    const dl = results.get(rec.id);
    if (!dl) return rec;
    return {
      ...rec,
      data: {
        ...rec.data,
        pdf: { $file: `sha256:${dl.hash}` },
        pdf_size: dl.size,
      },
    };
  });

  const outPath = join(DATA_DIR, "publications", "records-with-files.json");
  writeFileSync(outPath, JSON.stringify(updatedRecords, null, 2));
  console.log(`  → wrote ${outPath}`);

  // Write a manifest of all downloaded files for the push script
  const manifest = Array.from(results.values()).map((r) => ({
    hash: r.hash,
    size: r.size,
    path: join(PDF_DIR, r.filename),
  }));
  const manifestPath = join(DATA_DIR, "pdf-manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`  → wrote ${manifestPath}`);

  console.log("\n✅ Done! Run push.ts to upload files and records to Underlay.");
}

main().catch((err) => {
  console.error("❌ Download failed:", err);
  process.exit(1);
});
