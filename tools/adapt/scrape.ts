/**
 * ADAPT Centre WordPress Scraper
 *
 * Pulls structured data from the ADAPT Centre WordPress REST API
 * and writes it as Underlay-ready JSON files.
 *
 * Usage: npx tsx tools/adapt/scrape.ts
 *
 * Output:
 *   tools/adapt/data/team/records.json
 *   tools/adapt/data/publications/records.json
 *   tools/adapt/data/taxonomies.json     (team roles, research domains, journal types)
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = "https://www.adaptcentre.ie/wp-json/wp/v2";
const OUT_DIR = join(__dirname, "data");
const DELAY_MS = 200; // polite crawl delay

// --- Helpers ---

async function fetchAll<T>(endpoint: string, params: Record<string, string> = {}): Promise<T[]> {
  const all: T[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const url = new URL(`${BASE}/${endpoint}`);
    url.searchParams.set("per_page", String(perPage));
    url.searchParams.set("page", String(page));
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    console.log(`  GET ${url.pathname}${url.search} (page ${page})...`);
    const res = await fetch(url.toString());

    if (!res.ok) {
      if (res.status === 400) break; // WP returns 400 on page past total
      throw new Error(`${res.status} ${res.statusText} for ${url}`);
    }

    const data = (await res.json()) as T[];
    if (data.length === 0) break;
    all.push(...data);

    const totalPages = parseInt(res.headers.get("x-wp-totalpages") ?? "1", 10);
    if (page >= totalPages) break;
    page++;
    await sleep(DELAY_MS);
  }

  return all;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function writeJson(subdir: string, filename: string, data: unknown): void {
  const dir = join(OUT_DIR, subdir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, filename);
  writeFileSync(path, JSON.stringify(data, null, 2));
  console.log(`  → wrote ${path}`);
}

// --- Taxonomy resolution ---

interface WpTaxTerm {
  id: number;
  name: string;
  slug: string;
  count: number;
}

async function loadTaxonomies() {
  console.log("\n📋 Loading taxonomies...");

  const teamRoles = await fetchAll<WpTaxTerm>("team");
  const researchDomains = await fetchAll<WpTaxTerm>("research-domains");
  const journalTypes = await fetchAll<WpTaxTerm>("journal_type");

  const lookup = {
    team: Object.fromEntries(teamRoles.map((t) => [t.id, t.name])),
    researchDomains: Object.fromEntries(researchDomains.map((t) => [t.id, t.name])),
    journalType: Object.fromEntries(journalTypes.map((t) => [t.id, t.name])),
  };

  console.log(
    `  Loaded: ${teamRoles.length} team roles, ${researchDomains.length} research domains, ${journalTypes.length} journal types`,
  );

  writeJson(".", "taxonomies.json", {
    teamRoles: teamRoles.map((t) => ({ id: t.id, name: t.name, slug: t.slug, count: t.count })),
    researchDomains: researchDomains.map((t) => ({ id: t.id, name: t.name, slug: t.slug, count: t.count })),
    journalTypes: journalTypes.map((t) => ({ id: t.id, name: t.name, slug: t.slug, count: t.count })),
  });

  return lookup;
}

// --- Experts / Team ---

interface WpExpert {
  id: number;
  slug: string;
  link: string;
  title: { rendered: string };
  team: number[];
  "research-domains": number[];
  acf: {
    job_title?: string;
    prof_title?: string;
    main_affiliation?: string;
    email?: string;
    biography?: string;
    [key: string]: unknown;
  };
}

async function scrapeTeam(lookup: Awaited<ReturnType<typeof loadTaxonomies>>) {
  console.log("\n👥 Scraping team members...");
  const experts = await fetchAll<WpExpert>("experts");
  console.log(`  Found ${experts.length} experts`);

  const records = experts.map((e) => ({
    id: `expert_${e.id}`,
    type: "researcher",
    data: {
      name: stripHtml(e.title.rendered),
      slug: e.slug,
      job_title: e.acf.job_title ?? "",
      affiliation: e.acf.main_affiliation ?? "",
      email: e.acf.email ?? "",
      biography: e.acf.biography ? stripHtml(e.acf.biography) : "",
      teams: (e.team ?? []).map((id) => lookup.team[id] ?? `unknown_${id}`),
      research_domains: (e["research-domains"] ?? []).map(
        (id) => lookup.researchDomains[id] ?? `unknown_${id}`,
      ),
      url: e.link,
    },
  }));

  writeJson("team", "records.json", records);
  return records;
}

// --- Publications ---

interface WpPublication {
  id: number;
  slug: string;
  link: string;
  title: { rendered: string };
  journal_type: number[];
  acf: {
    title_of_paper?: string;
    name_of_publication?: string;
    authors_list?: string;
    date?: string;
    type?: string;
    url?: string;
    [key: string]: unknown;
  };
}

async function scrapePublications(lookup: Awaited<ReturnType<typeof loadTaxonomies>>) {
  console.log("\n📄 Scraping publications...");
  const pubs = await fetchAll<WpPublication>("publications");
  console.log(`  Found ${pubs.length} publications`);

  const records = pubs.map((p) => ({
    id: `pub_${p.id}`,
    type: "publication",
    data: {
      title: p.acf.title_of_paper || stripHtml(p.title.rendered),
      slug: p.slug,
      authors: p.acf.authors_list ?? "",
      venue: p.acf.name_of_publication ?? "",
      date: p.acf.date ?? "",
      type:
        p.acf.type ||
        (p.journal_type ?? []).map((id) => lookup.journalType[id] ?? "").filter(Boolean).join(", ") ||
        "",
      url: p.acf.url ?? "",
      source_url: p.link,
    },
  }));

  writeJson("publications", "records.json", records);
  return records;
}

// --- Case Studies ---

const SITE_BASE = "https://www.adaptcentre.ie";

async function scrapeCaseStudies() {
  console.log("\n📝 Scraping case studies...");

  // Step 1: Crawl all paginated listing pages to collect links
  const caseStudyLinks: { url: string; title: string }[] = [];
  const seenUrls = new Set<string>();

  for (let page = 1; page <= 20; page++) {
    const listUrl = page === 1
      ? `${SITE_BASE}/case-studies/`
      : `${SITE_BASE}/case-studies/page/${page}/`;
    console.log(`  Fetching listing page ${page}...`);

    const res = await fetch(listUrl);
    if (!res.ok) {
      console.log(`    Page ${page}: ${res.status}, stopping`);
      break;
    }
    const html = await res.text();

    const linkRegex = /href="(https:\/\/www\.adaptcentre\.ie\/case-studies\/[^"\/]+\/)"[^>]*title="([^"]+)"/g;
    let match;
    let pageCount = 0;
    while ((match = linkRegex.exec(html)) !== null) {
      const url = match[1];
      const title = match[2];
      if (!seenUrls.has(url)) {
        seenUrls.add(url);
        caseStudyLinks.push({ url, title });
        pageCount++;
      }
    }

    if (pageCount === 0) break;
    console.log(`    Found ${pageCount} case studies`);
    await sleep(DELAY_MS);
  }

  console.log(`  Total: ${caseStudyLinks.length} case studies found`);

  // Step 2: Scrape each case study page and save raw HTML
  const records: { id: string; type: string; data: Record<string, unknown> }[] = [];
  const htmlDir = join(OUT_DIR, "publications", "html");
  mkdirSync(htmlDir, { recursive: true });
  const htmlManifest: { slug: string; hash: string; size: number }[] = [];

  for (const { url, title } of caseStudyLinks) {
    console.log(`  Scraping: ${title}...`);
    await sleep(DELAY_MS);

    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.log(`    ⚠ ${res.status}, skipping`);
        continue;
      }
      const html = await res.text();

      // Save raw HTML as content-addressed file
      const htmlBuffer = Buffer.from(html, "utf-8");
      const htmlHash = createHash("sha256").update(htmlBuffer).digest("hex");
      writeFileSync(join(htmlDir, `${htmlHash}.html`), htmlBuffer);

      // Extract slug from URL
      const slug = url.replace(/\/$/, "").split("/").pop() ?? "";

      // Extract section content by h2 headings
      const sections: Record<string, string> = {};
      const sectionRegex = /<h2[^>]*>(.*?)<\/h2>\s*([\s\S]*?)(?=<h2|<footer|<div class="module module-case-studies"|$)/gi;
      let sMatch;
      while ((sMatch = sectionRegex.exec(html)) !== null) {
        const heading = sMatch[1].replace(/<[^>]+>/g, "").trim();
        const body = sMatch[2]
          .replace(/<[^>]+>/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/&#038;/g, "&")
          .replace(/&#8217;/g, "'")
          .replace(/&#8216;/g, "'")
          .replace(/&#8220;/g, '"')
          .replace(/&#8221;/g, '"')
          .replace(/&nbsp;/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        if (heading && body && !["Newsletter"].includes(heading)) {
          sections[heading] = body;
        }
      }

      // Extract subtitle (first h2 that's descriptive)
      const subtitleMatch = html.match(/<h2[^>]*class="[^"]*subtitle[^"]*"[^>]*>(.*?)<\/h2>/i);
      const firstH2 = Object.keys(sections)[0] ?? "";

      // Extract images
      const imgRegex = /<img[^>]+src="([^"]+adaptcentre\.ie\/wp-content\/uploads[^"]+)"[^>]*>/g;
      const images: string[] = [];
      let iMatch;
      while ((iMatch = imgRegex.exec(html)) !== null) {
        if (!images.includes(iMatch[1])) images.push(iMatch[1]);
      }

      htmlManifest.push({ slug, hash: htmlHash, size: htmlBuffer.length });

      records.push({
        id: `case_study_${slug}`,
        type: "case_study",
        data: {
          title,
          slug,
          subtitle: subtitleMatch ? subtitleMatch[1].replace(/<[^>]+>/g, "").trim() : (firstH2 || ""),
          url,
          sections,
          images,
          html: { $file: `sha256:${htmlHash}` },
          html_size: htmlBuffer.length,
        },
      });
    } catch (err) {
      console.log(`    ⚠ Error: ${err}`);
    }
  }

  writeJson("publications", "case-studies.json", records);
  writeJson("publications", "html-manifest.json", htmlManifest);
  console.log(`  📄 ${htmlManifest.length} HTML files saved (${(htmlManifest.reduce((s, f) => s + f.size, 0) / 1024 / 1024).toFixed(1)} MB)`);
  return records;
}

// --- Main ---

async function main() {
  console.log("🏛️  ADAPT Centre Scraper");
  console.log(`   Source: ${BASE}`);
  console.log(`   Output: ${OUT_DIR}`);

  const lookup = await loadTaxonomies();
  const team = await scrapeTeam(lookup);
  const pubs = await scrapePublications(lookup);
  const caseStudies = await scrapeCaseStudies();

  console.log("\n✅ Done!");
  console.log(`   Team:         ${team.length} records`);
  console.log(`   Publications: ${pubs.length} records`);
  console.log(`   Case studies: ${caseStudies.length} records`);
  console.log(`\n   Run 'npx tsx tools/adapt/push.ts' to push to Underlay.`);
}

main().catch((err) => {
  console.error("❌ Scraper failed:", err);
  process.exit(1);
});
