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

export const FINDINGS = {
  date: '2026-11-10',
  lede: 'The v3 core (sorted-record-files, commits, layout files, rebuilds, forks, and the deletion sweep) built as a library, and measured at scale on a store that waits, limits, and counts as R2 is documented to.',
  status:
    'In so far, from round 3 on the LighterAPI box (commit <code>37ca762</code>): the 3,000-collection check, 100k, 1M, and a 7.2M-record sample of Crossref. Still to land in that round: 5M, 12M, 20,000 collections, racing writers, the policy over a year, and all of Crossref. The fork test is from the Mac at 1M (commit <code>8d24453</code>) and is repeated at 12M in a short round 4.',
  verdict: `<ul>
<li>Everything measured so far held. A day’s commit is a few dozen requests and about a second at 100k and at 1M; a first load reads the moment it commits; every commit’s files were made again to the ids in the log; a fork copied no records; the sweep deleted nothing a collection lists; and no process needed more than 65 MB of heap.</li>
<li>One finding changed the plan’s starting rebuild policy. Merging ten neighbours of exactly one size left too many sorted-record-files for a read to check (14 on average at Crossref’s size, by arithmetic). The rule now in force leaves about 9, so a point read is about 10 requests with footers cached. That sits on the plan’s line, not under it; a ratio of 4 brings it to about 7 for a fifth more rewriting.</li>
<li>The recommendation waits for the large sizes.</li>
</ul>`,
  reads:
    '<p class="note">With nothing cached a read also fetches each file’s footer: 9 to 14 requests once rebuilt, 67 with 30 commits not yet merged. In the Crossref sample a day’s file is too large for its key blocks to come with the footer, so each file checked is a request: 7 to 8 warm with 7 to 9 files to check, 20 to 26 cold.</p>',
  policy:
    '<p class="note">The rule in force: for each size tier, lowest first, merge ten or more neighbouring groups of files that are each at or below the tier, if together they are at least twice the largest. The plan’s first rule (ten neighbours of exactly one tier) left 14 files to check on average and 28 at most by this arithmetic, and more when uploads were uneven. Layout F’s leveled policy rewrote about 8.5 GB a day, simulated. The largest merges (hundreds of GB of lines, a few times in three years) are one sequential pass today and need splitting by key range first.</p>',
  forkEdit:
    'Files are cut by key toward the target, so a stretch of keys nobody changed keeps its file and its id. Under the tier rule the edit stays in a small file of its own: the fork costs kilobytes, and a read of a record checks two files. Merging the fork back together rewrites only the file the edit fell in and keeps the rest, and a read checks one. That file is larger than the target on average, since a larger file is likelier to be hit.',
  besideF:
    'Layout F’s numbers are from its final round on 2026-10-19 (commit <code>a8e4dec</code>, Travis’s Mac, latency profile <code>r2</code>). v3’s daily rows use the rate F’s bench used (240,000 changes a day at Crossref’s size), so the two are like for like. F was driven through the HTTP server, with its queue and database; v3 is driven as a library, so its times leave out HTTP and queue hops.',
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
<li>To change first: split a merge by key range so the largest rebuilds use every core (one pass today); scan a schema change in parallel (one process today, about 3,300 records a second); cap how large a file the key cut can make (about four times the target).</li>
<li>Left out on purpose: separately stored blocks, and encryption.</li>
</ul>`,
  method:
    'Every process had its heap capped at 120 MB (<code>--max-old-space-size=96 --max-semi-space-size=8</code>; the first flag alone lets a heap reach 320 MB). Times under simulated latency are lower bounds; bytes and request counts are exact. Requests are counted by R2’s billing class: class A is a write or a list, class B a read. Charts show the <code>r2</code> latency profile; the tables give <code>r2-slow</code> as well.',
}
