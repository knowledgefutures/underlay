/**
 * The report's words, and layout F's measured numbers to set beside v3's.
 * Edit these as results land; `bench report` builds the page from them and the
 * results folder.
 *
 * Layout F's numbers are from its final runs (round 19, 2026-10-19, commit
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
  lede: 'The v3 core (sorted-record-files, commits, layout files, rebuilds, forks, and the deletion sweep) built as a library, and run at scale on a store that waits, limits, and counts as R2 is documented to.',
  status:
    'Results so far: the local runs. The box runs (5M, 12M, 20,000 collections, all of Crossref) are to come.',
  verdict: '<p class="muted">To be written when the runs are in.</p>',
  reads: '',
  policy: '',
  forkEdit:
    'Files are cut by key toward the target, so a stretch of keys nobody changed keeps its file and its id. Under the tier rule the edit stays in a small file of its own: the fork costs kilobytes, and a read looks in two runs. Merging the fork back into one run rewrites only the file the edit fell in and keeps the rest. That file is larger than the target on average, since a larger file is likelier to be hit.',
  besideF:
    'Layout F’s numbers are from its final runs on 2026-10-19 (commit <code>a8e4dec</code>, Travis’s Mac, latency profile <code>r2</code>). v3’s daily rows use the rate F’s bench used (240,000 changes a day at Crossref’s size), so the two are like for like. F ran through the HTTP server, with its queue and database; v3 is driven as a library, so its times leave out HTTP and queue hops.',
  r2: '<p class="muted">To be written.</p>',
  open: '<p class="muted">To be written.</p>',
  method:
    'Every process ran with its heap capped at 128 MB. Times under simulated latency are lower bounds; bytes and request counts are exact. Requests are counted by R2’s billing class: class A is a write or a list, class B a read.',
}
