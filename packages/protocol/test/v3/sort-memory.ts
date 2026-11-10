/**
 * Run by build.test.ts in a child process with a capped heap: sorts generated,
 * unsorted NDJSON far larger than the heap into sorted-record-files on disk,
 * and prints what it used. `node --max-old-space-size=128 --import tsx sort-memory.ts <bytes> <dir>`.
 */
import { fileStore, v3 } from '../../src/index.js'

const bytes = Number(process.argv[2])
const dir = process.argv[3]!
const store = fileStore(dir)
const enc = new TextEncoder()

let peakRss = 0
let peakHeap = 0
const sample = () => {
  const m = process.memoryUsage()
  peakRss = Math.max(peakRss, m.rss)
  peakHeap = Math.max(peakHeap, m.heapUsed)
}
const timer = setInterval(sample, 50)

let records = 0
/** Records of about 1 KB with ids in no order, 4 MB of NDJSON at a time. */
async function* input(): AsyncGenerator<Uint8Array> {
  let made = 0
  let seed = 12345
  const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0)
  while (made < bytes) {
    const lines: string[] = []
    let n = 0
    while (n < 4 * 1024 * 1024 && made + n < bytes) {
      const id = `10.${next() % 90000}/${next().toString(36)}${next().toString(36)}`
      const words: string[] = []
      for (let i = 0; i < 110; i++) words.push(next().toString(36))
      const line = JSON.stringify({
        type: 'work',
        data: { title: words.join(' '), n: records },
        id,
      })
      lines.push(line)
      n += line.length + 1
      records++
    }
    made += n
    yield enc.encode(lines.join('\n') + '\n')
  }
}

const started = Date.now()
const files = await v3.buildFiles(
  v3.sortRows(v3.parseUpload(input()), store),
  v3.storeTarget(store),
  { level: 1, maxBytes: 256 * 1024 * 1024 },
)
sample()
clearInterval(timer)
let entries = 0
let last: v3.KeyPair | null = null
let ordered = true
for (const f of files) {
  entries += f.entries
  if (last && f.first && v3.compareKeys(last[0], last[1], f.first[0], f.first[1]) >= 0)
    ordered = false
  last = f.last
}
let left = 0
for await (const _ of (async function* () {
  let cursor: string | undefined
  do {
    const page = await store.list('tmp/', cursor)
    yield* page.keys
    cursor = page.cursor
  } while (cursor)
})())
  left++
console.log(
  JSON.stringify({
    bytes,
    records,
    entries,
    files: files.length,
    ordered,
    scratchLeft: left,
    peakRssMb: Math.round(peakRss / 1048576),
    peakHeapMb: Math.round(peakHeap / 1048576),
    seconds: Math.round((Date.now() - started) / 100) / 10,
  }),
)
