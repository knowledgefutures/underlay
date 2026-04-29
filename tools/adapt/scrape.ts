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

// --- Main ---

async function main() {
  console.log("🏛️  ADAPT Centre Scraper");
  console.log(`   Source: ${BASE}`);
  console.log(`   Output: ${OUT_DIR}`);

  const lookup = await loadTaxonomies();
  const team = await scrapeTeam(lookup);
  const pubs = await scrapePublications(lookup);

  console.log("\n✅ Done!");
  console.log(`   Team:         ${team.length} records`);
  console.log(`   Publications: ${pubs.length} records`);
  console.log(`\n   Run 'npx tsx tools/adapt/push.ts' to push to Underlay.`);
}

main().catch((err) => {
  console.error("❌ Scraper failed:", err);
  process.exit(1);
});
