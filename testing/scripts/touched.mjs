// How many sorted-record-files do a real day's changes fall in? Read-only, over the sorted
// Crossref dump: each record says when it was last indexed and last deposited, so the
// records of one date are (most of) what changed that day. The dump is in key order, so
// cutting it as an upload is cut (by key toward a target, with the cap and the type cut)
// gives the files of a first load; this counts, for each recent day and for windows of
// days, how many of those files hold a changed record, at several targets.
//
//   node scripts/touched.mjs /data/crossref-sort/sorted [parts] > touched.json
//
// A record carries only its latest dates, so a day long before the dump is undercounted
// (its records have changed again since). The last days before the dump are the fair ones.
import { spawn } from 'node:child_process'
import { createReadStream, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createGunzip } from 'node:zlib'

const MB = 1024 * 1024
/** Targets in bytes of lines; stored is about a quarter. */
const TARGETS = { '8 MB': 32 * MB, '32 MB': 128 * MB, '128 MB': 512 * MB }
const MAX_ENTRIES = 524_288
const TYPE_CUT = 16 * MB
/** Days kept apart: the last this many before the newest date seen. */
const KEEP_DAYS = 120

// The library's cut (packages/protocol/src/v3/build.ts, keyCut), copied so this runs alone.
function keyCut(type, id, size, cutBytes) {
  let h = 2_166_136_261
  for (let i = 0; i < type.length; i++) h = Math.imul(h ^ type.charCodeAt(i), 16_777_619)
  h = Math.imul(h ^ 0, 16_777_619)
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16_777_619)
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 4_294_967_296 < (size + 1) / cutBytes
}

async function* lines(path) {
  let rest = ''
  const stream = createReadStream(path, { highWaterMark: 1 << 20 }).pipe(
    createGunzip({ chunkSize: 1 << 20 }),
  )
  stream.setEncoding('utf8')
  for await (const chunk of stream) {
    const text = rest + chunk
    let start = 0
    for (;;) {
      const nl = text.indexOf('\n', start)
      if (nl === -1) break
      if (nl > start) yield text.slice(start, nl)
      start = nl + 1
    }
    rest = text.slice(start)
  }
  if (rest) yield rest
}

const dayOf = (d) => (d && typeof d['date-time'] === 'string' ? d['date-time'].slice(0, 10) : null)

async function part(dir, files, start, end) {
  const state = Object.fromEntries(
    Object.keys(TARGETS).map((t) => [t, { file: 0, bytes: 0, entries: 0 }]),
  )
  /** date kind -> day -> target -> Set of file numbers; and records a day. */
  const touched = { indexed: new Map(), deposited: new Map() }
  const counts = { indexed: new Map(), deposited: new Map() }
  let records = 0
  let lastType = null
  for (let i = start; i < end; i++) {
    for await (const line of lines(join(dir, files[i]))) {
      let d
      try {
        d = JSON.parse(line)
      } catch {
        continue
      }
      const type = String(d.type)
      const id = String(d.DOI).toLowerCase()
      const size = Buffer.byteLength(line)
      records++
      for (const kind of ['indexed', 'deposited']) {
        const day = dayOf(d[kind])
        if (!day) continue
        counts[kind].set(day, (counts[kind].get(day) ?? 0) + 1)
        let m = touched[kind].get(day)
        if (!m)
          touched[kind].set(
            day,
            (m = Object.fromEntries(Object.keys(TARGETS).map((t) => [t, new Set()]))),
          )
        for (const t of Object.keys(TARGETS)) m[t].add(state[t].file)
      }
      // After the row: does a file end here? (The cut by key, the cap, the entry cap; the
      // type cut is taken when the next row's type differs.)
      for (const [t, cutBytes] of Object.entries(TARGETS)) {
        const s = state[t]
        s.bytes += size + 1
        s.entries++
        if (
          keyCut(type, id, size, cutBytes) ||
          s.bytes >= 4 * cutBytes ||
          s.entries >= MAX_ENTRIES
        ) {
          s.file++
          s.bytes = 0
          s.entries = 0
        }
      }
      if (lastType !== null && lastType !== type) {
        for (const t of Object.keys(TARGETS)) {
          const s = state[t]
          if (s.bytes - size - 1 >= TYPE_CUT && s.entries > 1) {
            // The file should have ended before this row; close enough for a count.
            s.file++
            s.bytes = size + 1
            s.entries = 1
          }
        }
      }
      lastType = type
    }
  }
  const out = { start, end, records, files: {}, counts: {}, touched: {} }
  for (const t of Object.keys(TARGETS))
    out.files[t] = state[t].file + (state[t].entries > 0 ? 1 : 0)
  for (const kind of ['indexed', 'deposited']) {
    out.counts[kind] = Object.fromEntries(counts[kind])
    out.touched[kind] = {}
    for (const [day, m] of touched[kind]) {
      out.touched[kind][day] = Object.fromEntries(
        Object.entries(m).map(([t, set]) => [t, [...set]]),
      )
    }
  }
  process.stdout.write(JSON.stringify(out))
  await new Promise((r) => process.stdout.write('', r))
}

async function main() {
  const [dir, a, b, c] = process.argv.slice(2)
  const files = readdirSync(dir)
    .filter((f) => /^\d+\.jsonl\.gz$/.test(f))
    .sort((x, y) => parseInt(x, 10) - parseInt(y, 10))
  if (a === 'part') return part(dir, files, Number(b), Number(c))
  const parts = Number(a ?? 10)
  const limit = b ? Number(b) : files.length
  const per = Math.ceil(limit / parts)
  const reports = await Promise.all(
    Array.from({ length: parts }, (_, p) => {
      const start = p * per
      const end = Math.min(limit, (p + 1) * per)
      return new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [process.argv[1], dir, 'part', String(start), String(end)],
          {
            stdio: ['ignore', 'pipe', 'inherit'],
          },
        )
        const chunks = []
        child.stdout.on('data', (d) => chunks.push(d))
        child.on('close', (code) =>
          code === 0
            ? resolve(JSON.parse(Buffer.concat(chunks).toString()))
            : reject(new Error(`part ${p} exited ${code}`)),
        )
      })
    }),
  )
  const result = { dir, dumpFiles: limit, records: 0, files: {}, kinds: {} }
  for (const t of Object.keys(TARGETS))
    result.files[t] = reports.reduce((n, r) => n + r.files[t], 0)
  result.records = reports.reduce((n, r) => n + r.records, 0)
  for (const kind of ['indexed', 'deposited']) {
    const counts = new Map()
    for (const r of reports)
      for (const [day, n] of Object.entries(r.counts[kind]))
        counts.set(day, (counts.get(day) ?? 0) + n)
    const days = [...counts.keys()].sort()
    const recent = days.slice(-KEEP_DAYS)
    // A file's name across parts: the part and its number there.
    const sets = (day) => {
      const m = Object.fromEntries(Object.keys(TARGETS).map((t) => [t, new Set()]))
      reports.forEach((r, p) => {
        const got = r.touched[kind][day]
        if (!got) return
        for (const t of Object.keys(TARGETS)) for (const f of got[t]) m[t].add(`${p}/${f}`)
      })
      return m
    }
    const perDay = recent.map((day) => {
      const m = sets(day)
      return {
        day,
        records: counts.get(day),
        files: Object.fromEntries(Object.entries(m).map(([t, s]) => [t, s.size])),
      }
    })
    const windows = {}
    for (const w of [1, 7, 10, 30, 100]) {
      // The window ends a few days before the newest date, which is often a partial day.
      const span = recent.slice(-(w + 3), -3)
      const union = Object.fromEntries(Object.keys(TARGETS).map((t) => [t, new Set()]))
      let n = 0
      for (const day of span) {
        n += counts.get(day)
        const m = sets(day)
        for (const t of Object.keys(TARGETS)) for (const f of m[t]) union[t].add(f)
      }
      windows[w] = {
        from: span[0],
        to: span[span.length - 1],
        records: n,
        files: Object.fromEntries(Object.entries(union).map(([t, s]) => [t, s.size])),
      }
    }
    result.kinds[kind] = { days: days.length, newest: days[days.length - 1], perDay, windows }
  }
  process.stdout.write(JSON.stringify(result, null, 1) + '\n')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
