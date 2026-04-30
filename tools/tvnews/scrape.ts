/**
 * Vanderbilt Television News Archive Scraper
 *
 * Scrapes broadcast metadata from tvnews.vanderbilt.edu using
 * the server-rendered HTML pages.
 *
 * Usage:
 *   npx tsx tools/tvnews/scrape.ts                    # scrape all years
 *   npx tsx tools/tvnews/scrape.ts --from 2020        # scrape 2020 onward
 *   npx tsx tools/tvnews/scrape.ts --from 2020 --to 2025  # scrape range
 *   npx tsx tools/tvnews/scrape.ts --resume           # resume from checkpoint
 *
 * Output:
 *   tools/tvnews/data/segments.json       (segment records)
 *   tools/tvnews/data/progress.json       (checkpoint for resumption)
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "data");
const BASE_URL = "https://tvnews.vanderbilt.edu";
const DELAY_MS = 150; // polite crawl delay between requests
const BATCH_SAVE_SIZE = 200; // save progress every N segments

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// --- CLI args ---

const args = process.argv.slice(2);
const fromYear = args.includes("--from")
  ? parseInt(args[args.indexOf("--from") + 1]!, 10)
  : 1968;
const toYear = args.includes("--to")
  ? parseInt(args[args.indexOf("--to") + 1]!, 10)
  : new Date().getFullYear();
const resumeMode = args.includes("--resume");

// --- Types ---

interface Segment {
  id: string;
  type: "segment";
  data: {
    segment_id: number;
    title: string;
    network: string;
    date: string;
    abstract: string;
    reporters: string[];
    duration: string;
    program_id: number | null;
    program_title: string;
    timestamp_start: string;
    timestamp_end: string;
  };
}

interface Progress {
  completedMonths: string[]; // "YYYY-M"
  segments: Segment[];
  lastUpdated: string;
}

// --- Helpers ---

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchPage(path: string): Promise<string> {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} for ${url}`);
  }
  return res.text();
}

function extractText(html: string, startMarker: string, endMarker: string): string {
  const start = html.indexOf(startMarker);
  if (start === -1) return "";
  const afterStart = start + startMarker.length;
  const end = html.indexOf(endMarker, afterStart);
  if (end === -1) return html.slice(afterStart).trim();
  return html.slice(afterStart, end).trim();
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#038;/g, "&")
    .replace(/&#8217;/g, "'")
    .replace(/&#8216;/g, "'")
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&rdquo;/g, '"')
    .replace(/&ldquo;/g, '"')
    .replace(/&rsquo;/g, "'")
    .replace(/&lsquo;/g, "'")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/\s+/g, " ")
    .trim();
}

// --- Parsing ---

function parseSegmentIds(html: string): number[] {
  const ids: number[] = [];
  const regex = /href="\/broadcasts\/(\d+)"/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    const id = parseInt(match[1]!, 10);
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function parseSegmentDetail(html: string, segmentId: number): Segment | null {
  // Title: <h4 class="video-title">TITLE <span class="video-number">#ID</span></h4>
  const titleMatch = html.match(
    /<h4 class="video-title">(.*?)\s*<span class="video-number">/s,
  );
  const title = titleMatch ? stripHtml(titleMatch[1]!) : "";

  // Broadcast info: "CBS Evening News for Tuesday, Apr 29, 1986"
  const infoMatch = html.match(
    /<p class="broadcast-info">\s*(.*?)(?:<br|<\/p>)/s,
  );
  const broadcastInfo = infoMatch ? stripHtml(infoMatch[1]!) : "";

  // Parse network and date from broadcast info
  // Format: "NETWORK Program for Day, Mon DD, YYYY"
  let network = "";
  let date = "";
  let programTitle = broadcastInfo;

  const networkDateMatch = broadcastInfo.match(
    /^(ABC|CBS|NBC|CNN|Fox News|PBS|MSNBC)\s+(.*?)\s+for\s+(?:\w+day,\s+)?(.+)$/i,
  );
  if (networkDateMatch) {
    network = networkDateMatch[1]!;
    programTitle = `${networkDateMatch[1]} ${networkDateMatch[2]}`;
    const dateStr = networkDateMatch[3]!;
    // Try to parse date
    const parsed = new Date(dateStr);
    if (!isNaN(parsed.getTime())) {
      date = parsed.toISOString().split("T")[0]!;
    } else {
      date = dateStr;
    }
  } else {
    // Try simpler format: "Network for YYYY-MM-DD"
    const simpleMatch = broadcastInfo.match(/^(.+?)\s+for\s+(\d{4}-\d{2}-\d{2})/);
    if (simpleMatch) {
      programTitle = simpleMatch[1]!;
      date = simpleMatch[2]!;
      const netMatch = programTitle.match(/^(ABC|CBS|NBC|CNN|Fox News|PBS|MSNBC)/i);
      if (netMatch) network = netMatch[1]!;
    }
  }

  // Program link
  const programMatch = html.match(/href="\/programs\/(\d+)"/);
  const programId = programMatch ? parseInt(programMatch[1]!, 10) : null;

  // Abstract: <div class="video-description">...</div>
  const descStart = html.indexOf('<div class="video-description">');
  let abstract = "";
  if (descStart !== -1) {
    const descEnd = html.indexOf("</div>", descStart + 31);
    if (descEnd !== -1) {
      abstract = stripHtml(html.slice(descStart + 31, descEnd));
    }
  }

  // Reporters: <dt>Reporter(s):</dt><dd>Name;</dd><dd>Name</dd>
  const reporters: string[] = [];
  const reporterSection = html.match(
    /<dt>Reporter\(s\):<\/dt>([\s\S]*?)(?:<dt>|<\/dl>)/,
  );
  if (reporterSection) {
    const ddRegex = /<dd>(.*?)<\/dd>/g;
    let ddMatch: RegExpExecArray | null;
    while ((ddMatch = ddRegex.exec(reporterSection[1]!)) !== null) {
      const name = stripHtml(ddMatch[1]!).replace(/;$/, "").trim();
      if (name) reporters.push(name);
    }
  }

  // Duration
  const durationMatch = html.match(
    /<dt>Duration:<\/dt>\s*<dd>([\d:]+)<\/dd>/,
  );
  const duration = durationMatch ? durationMatch[1]! : "";

  if (!title && !abstract) return null;

  return {
    id: `segment_${segmentId}`,
    type: "segment",
    data: {
      segment_id: segmentId,
      title,
      network,
      date,
      abstract,
      reporters,
      duration,
      program_id: programId,
      program_title: programTitle,
      timestamp_start: "",
      timestamp_end: "",
    },
  };
}

// --- Progress ---

function loadProgress(): Progress {
  const path = join(DATA_DIR, "progress.json");
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, "utf-8"));
  }
  return { completedMonths: [], segments: [], lastUpdated: "" };
}

function saveProgress(progress: Progress) {
  mkdirSync(DATA_DIR, { recursive: true });
  progress.lastUpdated = new Date().toISOString();
  writeFileSync(join(DATA_DIR, "progress.json"), JSON.stringify(progress));
  // Also write the clean records file
  writeFileSync(
    join(DATA_DIR, "segments.json"),
    JSON.stringify(progress.segments, null, 2),
  );
}

// --- Generate month list ---

function getMonths(from: number, to: number): string[] {
  const months: string[] = [];
  // Archive starts August 1968
  const startYear = Math.max(from, 1968);
  const startMonth = startYear === 1968 ? 8 : 1;
  const endYear = Math.min(to, new Date().getFullYear());
  const endMonth = to >= new Date().getFullYear() ? new Date().getMonth() + 1 : 12;

  for (let y = startYear; y <= endYear; y++) {
    const mStart = y === startYear ? startMonth : 1;
    const mEnd = y === endYear ? endMonth : 12;
    for (let m = mStart; m <= mEnd; m++) {
      months.push(`${y}-${m}`);
    }
  }
  return months;
}

// --- Main ---

async function main() {
  console.log("📺 Vanderbilt Television News Archive Scraper");
  console.log(`   Range: ${fromYear} – ${toYear}`);
  console.log(`   Delay: ${DELAY_MS}ms between requests`);
  console.log(`   Output: ${DATA_DIR}`);
  console.log();

  mkdirSync(DATA_DIR, { recursive: true });

  const progress = resumeMode ? loadProgress() : { completedMonths: [], segments: [], lastUpdated: "" };
  if (resumeMode && progress.segments.length > 0) {
    console.log(`   Resuming: ${progress.segments.length} segments already scraped`);
    console.log(`   Completed months: ${progress.completedMonths.length}`);
    console.log();
  }

  const months = getMonths(fromYear, toYear);
  const pendingMonths = months.filter((m) => !progress.completedMonths.includes(m));
  console.log(`   Total months in range: ${months.length}`);
  console.log(`   Pending months: ${pendingMonths.length}`);
  console.log();

  // Track segment IDs we've already fetched
  const existingIds = new Set(progress.segments.map((s) => s.data.segment_id));

  let fetchedThisRun = 0;
  let errorsThisRun = 0;

  for (const month of pendingMonths) {
    console.log(`\n📅 ${month}`);

    // Fetch the siteindex page for this month
    let indexHtml: string;
    try {
      indexHtml = await fetchPage(`/siteindex/${month}`);
      await sleep(DELAY_MS);
    } catch (err) {
      console.log(`  ❌ Failed to fetch index: ${err}`);
      errorsThisRun++;
      continue;
    }

    const segmentIds = parseSegmentIds(indexHtml);
    const newIds = segmentIds.filter((id) => !existingIds.has(id));
    console.log(`  Found ${segmentIds.length} segments (${newIds.length} new)`);

    // Fetch each new segment's detail page
    for (let i = 0; i < newIds.length; i++) {
      const segId = newIds[i]!;

      try {
        const html = await fetchPage(`/broadcasts/${segId}`);
        const segment = parseSegmentDetail(html, segId);

        if (segment) {
          progress.segments.push(segment);
          existingIds.add(segId);
          fetchedThisRun++;
        }
      } catch (err) {
        // On 403/429, wait longer
        if (String(err).includes("403") || String(err).includes("429")) {
          console.log(`  ⚠️  Rate limited on #${segId}, waiting 5s...`);
          await sleep(5000);
          errorsThisRun++;
        } else {
          console.log(`  ❌ Error on #${segId}: ${err}`);
          errorsThisRun++;
        }
      }

      await sleep(DELAY_MS);

      // Save progress periodically
      if (fetchedThisRun % BATCH_SAVE_SIZE === 0 && fetchedThisRun > 0) {
        saveProgress(progress);
        console.log(`  💾 Saved (${progress.segments.length} total segments)`);
      }

      // Progress indicator
      if ((i + 1) % 50 === 0) {
        console.log(`  ... ${i + 1}/${newIds.length} processed`);
      }
    }

    progress.completedMonths.push(month);
    saveProgress(progress);
    console.log(`  ✅ Done — ${progress.segments.length} total segments`);
  }

  // Final save
  saveProgress(progress);

  console.log("\n" + "=".repeat(60));
  console.log(`📺 Scraping complete!`);
  console.log(`   Total segments: ${progress.segments.length}`);
  console.log(`   Fetched this run: ${fetchedThisRun}`);
  console.log(`   Errors: ${errorsThisRun}`);
  console.log(`   Output: ${join(DATA_DIR, "segments.json")}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
