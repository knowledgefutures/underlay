/**
 * The report's words, and layout F's measured numbers to set beside v3's.
 * Edit these as results land; `bench report` builds the page from them and the
 * results folder.
 *
 * Layout F's numbers are from its final round (round 19, 2026-10-19, commit
 * a8e4dec on branch `scale-testing`, Travis's Mac, latency profile `r2`), read
 * from ~/underlay-bench/results and planning/kf/underlay/scale-testing.md.
 */

interface FSize {
  loadSeconds: number
  loadBucketBytes: number
  loadInternalBytes: number
  dailyCommitSeconds: string
  dailyRequests: string
  dailyWritten: string
  pointCold: string
  pointWarm: string
  page50: string
  diffPage: string
  exportLatest: string
}

export const LAYOUT_F: { '5m': FSize; '12m': FSize; many: Record<string, string> } = {
  '5m': {
    loadSeconds: 1012,
    loadBucketBytes: 9_331_605_504,
    loadInternalBytes: 27_152_658_432,
    dailyCommitSeconds: '31 to 43 s',
    dailyRequests: '18,100 to 19,200, and 5,100 to 5,600 database statements',
    dailyWritten: '40 to 362 MB',
    pointCold: '409 ms, 16 requests and 6 database calls',
    pointWarm: '259 ms, 9 requests and 3 database calls',
    page50: '333 ms, 90 requests',
    diffPage: '41.6 s, 2,721 requests',
    exportLatest: '13.4 min (one process)',
  },
  '12m': {
    loadSeconds: 2903,
    loadBucketBytes: 22_418_960_384,
    loadInternalBytes: 82_894_618_624,
    dailyCommitSeconds: '70 and 93 s',
    dailyRequests: '40,900 and 45,800, and 9,200 and 10,200 database statements',
    dailyWritten: '169 and 411 MB',
    pointCold: '464 ms, 18 requests and 6 database calls',
    pointWarm: '294 ms, 9 requests and 3 database calls',
    page50: '358 ms, 88 requests',
    diffPage: '39.2 s, 2,456 requests',
    exportLatest: '31.9 min (one process)',
  },
  many: {
    load: '1.7 h (5.1 min a thousand)',
    perCommit: '76 requests and 244 database statements',
    burst: '5.7 min, p95 308 s',
    perCollection: '159 KB',
  },
}

/** Layout F's numbers as numbers, for the summary's bars (the same sources as above). */
export const F_NUMBERS = {
  '5m': {
    loadSeconds: 1012,
    dailySeconds: [31, 43],
    dailyRequests: [18_100, 19_200],
    warmMs: 259,
    diffSeconds: 41.6,
    exportSeconds: 13.4 * 60,
  },
  '12m': {
    loadSeconds: 2903,
    dailySeconds: [70, 93],
    dailyRequests: [40_900, 45_800],
    warmMs: 294,
    diffSeconds: 39.2,
    exportSeconds: 31.9 * 60,
  },
  many: { loadSeconds: 1.7 * 3600, burstSeconds: 5.7 * 60, commitRequests: 76 },
  /** The full-dump commit on staging's `crossref-demo/works-f`, 2026-10-22: real R2, not this bench. */
  crossrefLoad: '10 h 28 min',
  crossrefRecords: 179_518_552,
}

/**
 * Files a read checks, where the bench that made a result miscounted. Until `bbcc3b7` it
 * counted distinct commit ranges, and one rebuild's files can carry different ranges. These
 * are counted from the layout files the Crossref store kept (layouts 1 and 6, 2026-11-11).
 */
export const GROUPS_FIX: Record<string, number> = {
  'crossref/reads/rebuilt': 2,
  'crossref/reads/after-policy': 7,
  'crossref/maintain/catch-up': 2,
}

export const FINDINGS = {
  bottomLine:
    'The v3 core held from 100k records to Crossref’s size and across 20,000 collections, and it is ahead of layout F on every measure the two share. The recommendation is to go on to server integration, settling the four things listed under “What to do next” on the way.',
  cards: {
    policy: {
      head: 'A read costs a request for each group of files, so the rebuild policy sets what a read costs',
      body: 'Each commit adds a group of sorted-record-files, and a read checks one file in each group until a rebuild merges them. The plan’s starting policy left about 14 groups at Crossref’s size. The rule now in force leaves about 9, which puts one record at about 10 requests. A ratio of 4 makes it about 7, for a fifth more rewriting.',
      todo: 'Pick the ratio (10 is in force). Split the largest merges across processes: they are one pass on one process today.',
    },
    forks: {
      head: 'Keeping untouched files pays for narrow edits, not for daily changes',
      body: 'The review proposed keeping any file no change fell in. Daily changes are spread over the keys, so they fall in every file: a full merge each day then rewrites everything, and a fork stops sharing with its parent. The tier rule leaves shared files alone.',
      todo: 'Keep the tier rule for what arrives each day. Use the key cut and kept files to fold a lightly edited fork back together.',
    },
    racing: {
      head: 'Racing writers are correct and wasteful',
      body: 'Only one writer can win a commit number. With 64 writing to one collection every commit landed once and none was lost, but each cost many times the requests, and a writer that loses 50 times running is refused and has to send again. Commits to different collections do not contend.',
      todo: 'Queue commits to a collection in the server, and land them in turn.',
    },
  },
  next: `<ol>
<li><b>Queue commits to a collection</b> in the server, where today they race.</li>
<li><b>Decide the rebuild ratio.</b> 10 keeps one record at about 10 requests at Crossref’s size; 4 makes it about 7 for a fifth more rewriting.</li>
<li><b>Split large merges and schema scans across processes.</b> Both are one pass on one process: fine to 12M, slow at Crossref’s size (16 minutes to merge 30 days, 34 minutes to merge a 7.8M-record upload with them; 33 minutes to scan 6.8M records at 12M).</li>
<li><b>Try on real R2</b> the three things its documentation does not spell out: one winner when two creates of a new key collide, what the loser is told, and ten or more new keys a second under one prefix.</li>
</ol>`,
  date: '2026-11-11',
  lede: 'The v3 core (sorted-record-files, commits, layout files, rebuilds, forks, and the deletion sweep) built as a library, and measured at scale on a store that waits, limits, and counts as R2 is documented to.',
  status:
    'Measured on the LighterAPI box under simulated R2 latency. Round 3 (commit <code>37ca762</code>): a 7.2M-record sample of Crossref, 5M, 12M, and 20,000 collections; it stopped at racing writers. Round 4 (commit <code>88269d4</code>): the 3,000-collection check, 100k, 1M, the fork test at 12M, racing, and the policy over a year; then Crossref (commit <code>430f3c2</code>), whose first load, by a mistake in the bench, held the first 35,908 of the sorted dump’s 36,626 files (171.8M of its 179.5M records); the other 718 went on afterwards as one upload (commit <code>4df47ea</code>). The fork test at 1M, which also tries a full merge every day, is from the Mac.',
  verdict: `<ul>
<li>What the design claims held from 100k to 12M records and across 20,000 collections. The same 1,000-change upload committed in 1.1 s and about 20 requests at 100k, 1M, and 12M alike; a day’s commit, which grows with the collection, took 0.6 to 3 s and 17 to 35 requests; a first load read the moment it committed; 253 of 253 commits were made again to the ids in the log; a fork copied no records and was 94.5% shared after 30 days; the sweep deleted nothing a collection lists while 2,000 collections were deleted and 2,000 thinned under it; and no process needed more than 79 MB of heap.</li>
<li>Beside layout F at 12M: a load is readable in 31 minutes against 48, a day’s commit takes 6 s and 56 requests against 70 to 93 s and over 40,000, and 20,000 collections load in 3 minutes against 1.7 hours.</li>
<li>The plan’s starting rebuild policy changed. Merging ten neighbours of exactly one size left too many sorted-record-files for a read to check (14 on average at Crossref’s size, by arithmetic). The rule in force leaves about 9, so a point read is about 10 requests with footers cached: on the plan’s line, not under it. A ratio of 4 brings it to about 7 for a fifth more rewriting.</li>
<li>Keeping untouched files, measured: it pays for a narrow edit (1% of the records side by side rewrote 2 to 4 files), and it does not replace the tier rule. Merging everything each day with changes spread over the keys left a fork sharing nothing with its parent on day one, and rewrote the whole collection daily, at 8, 32, and 128 MB alike. Under the tier rule the fork was still 97% shared on day 30, at 1M and at 12M.</li>
<li>Racing is correct and wasteful. With 64 writers to one collection every commit landed once and none was lost, at about 12 a second, but each cost about 175 requests against about 20, and a writer that loses a number 50 times running is refused and has to send again (three in round 3, which stopped the chain there; one in round 4). The server should queue commits to a collection, not race them.</li>
<li>The recommendation waits for all of Crossref.</li>
</ul>`,
  reads:
    '<p class="note">With nothing cached a read also fetches each file’s footer: 9 to 16 requests once rebuilt, and 67 to 98 with 30 commits not yet merged. At Crossref’s size: 3 requests with footers cached once rebuilt and 10 cold; 7 and 12 five days later; 31 and 68 with 30 commits not yet merged. At 5M and in the Crossref sample a day’s file is too large for its key blocks to come with the footer, so each file checked is a request: at 5M, 6 warm with the policy on and 32 with 30 commits not yet merged; in the sample, 7 to 8 warm with 7 to 9 files to check.</p>',
  policy:
    '<p class="note">The rule in force: for each size tier, lowest first, merge ten or more neighbouring groups of files that are each at or below the tier, if together they are at least twice the largest. The plan’s first rule (ten neighbours of exactly one tier) left 14 files to check on average and 28 at most by this arithmetic, and more when uploads were uneven. Layout F’s leveled policy rewrote about 8.5 GB a day, simulated. The largest merges (hundreds of GB of lines, a few times in three years) are one sequential pass today and need splitting by key range first.</p>',
  forkEdit:
    'Files are cut by key toward the target, so a stretch of keys nobody changed keeps its file and its id. Under the tier rule an edit stays in a small file of its own: the fork costs what the edit does, and a read checks one more file. Merging the fork back together rewrites only the files an edit fell in, so it costs a file or two for one record or for a narrow stretch of them, and everything when the edits are spread over the keys, as a day’s changes are here. The rewritten file is larger than the target on average, since a larger file is likelier to be hit.',
  besideF:
    'Layout F’s numbers are from its final round on 2026-10-19 (commit <code>a8e4dec</code>, Travis’s Mac, latency profile <code>r2</code>). v3’s daily rows use the rate F’s bench used (240,000 changes a day at Crossref’s size), so the two are like for like. What v3 wrote on those two days includes a merge that comes about once in ten days; over 30 days at Crossref’s own rate it rewrote 1.6 times what arrived (at 12M, 11.8 MB arrived and 18.8 MB was rewritten a day). F was driven through the HTTP server, with its queue and database; v3 is driven as a library, so its times leave out HTTP and queue hops.',
  r2: `<p>No real R2 was used. The bench store refuses, limits, and counts as R2’s documentation says (checked 2026-11-10).</p>
<div class="scroll"><table>
<tr><th>What R2 documents</th><th>How the code meets it</th></tr>
<tr><td>A put can be made to fail if the key exists (<code>If-None-Match: *</code>, on a put and on completing a multipart upload)</td><td>Commits and layouts are created this way, and nothing else decides a race. A lost create is counted as a class A request.</td></tr>
<tr><td>One write a second to a key, then a 429</td><td>Only the two hints are ever overwritten, each by one kind of writer, and a failed hint write is ignored; readers probe upward from a stale hint. Round 1 found one hint written twice a second when a layout followed a commit, so it was split in two.</td></tr>
<tr><td>Reads and lists see every earlier write</td><td>The sweep relies on a list showing every commit and layout written before it began, and gives newer ones a grace period.</td></tr>
<tr><td>No conditional delete</td><td>The sweep never deletes on a check. It moves a file to trash, waits, and purges; a file listed again is put back, and readers look in trash before failing.</td></tr>
<tr><td>Lists return at most 1,000 keys</td><td>The sweep streams lists a page at a time and sorts on disk; about one request a collection.</td></tr>
<tr><td>A put is at most 5 GiB; multipart parts are one size but the last, 10,000 at most</td><td>Files above 5 MiB go up in 8 MiB parts, so a file can be 78 GB; the format’s cap of 1,048,576 entries keeps files far below that.</td></tr>
</table></div>
<p class="note">Where the code leans on something R2 does not spell out: that two creates of one new key at the same instant leave exactly one winner; what the loser is told (a 412, or the 429 of the one-a-second limit; the S3 store now reads either as a loss when the key is there); and that new keys under one prefix can be created at ten or more a second. These are the first things to try on real R2. Latency is simulated, so times are lower bounds.</p>`,
  open: `<ul>
<li>Not built: the server’s HTTP surface on top of this (uploads by presigned URL, auth, queues); a check for the same key twice in one upload; conditions on a commit (<code>expect</code>); pruning old layout files; clearing abandoned upload sessions.</li>
<li>To change first: queue commits to a collection in the server, where today they race (the commit format already lets one commit carry several changes); split a merge by key range so the largest rebuilds use every core (one pass today); scan a schema change in parallel (one process today, about 3,300 records a second); cap how large a file the key cut can make (about four times the target).</li>
<li>Left out on purpose: separately stored blocks, and encryption.</li>
</ul>`,
  method:
    'Every process had its heap capped at 120 MB (<code>--max-old-space-size=96 --max-semi-space-size=8</code>; the first flag alone lets a heap reach 320 MB). Times under simulated latency are lower bounds; bytes and request counts are exact. Requests are counted by R2’s billing class: class A is a write or a list, class B a read. Charts show the <code>r2</code> latency profile; the tables give <code>r2-slow</code> as well.',
}
