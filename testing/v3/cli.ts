/**
 * A small command line over the v3 library and a folder on disk, for hands-on
 * checks and for the bench.
 *
 *   node --import tsx v3/cli.ts <command> --dir <folder> [options]
 *
 * Run with no command for the list.
 */
import { createReadStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { fileStore, listAll, type Store, v3 } from '../../packages/protocol/src/index.js'
import { parseArgs, refOf } from './lib.js'
import { BenchStore, costOf, diskUsage } from './store.js'

const HELP = `Underlay v3, on a folder.

  push <file.ndjson|->   build an upload from NDJSON and commit it
        -c <collection> [--sorted] [--message m] [--no-verify] [--no-validate]
  build <file.ndjson|->  build sorted-record-files only; prints what a commit would name
        [--sorted] [--max-bytes n]
  commit <refs.json>     commit files a build printed   -c <collection>
  create                 create a collection            -c <collection>
  log                    the commits                    -c <collection>
  read <type> <id>       one record                     -c <collection> [--version n]
  page                   records in key order           -c <collection> [--type t] [--after id] [--limit 50]
  export                 every record, as NDJSON        -c <collection> [--version n] [--type t]
  diff                   what changed                   -c <collection> --since n [--version n] [--before]
  history <type> <id>    one key's rows                 -c <collection>
  counts                 records and bytes per type     -c <collection> [--version n]
  rebuild                merge files, write a layout    -c <collection> [--all] [--ratio 10] [--retain a-b,c-d]
  recreate               make commits' files again and compare ids   -c <collection> [--commit n] [--write]
  fork                   fork a collection              -c <collection> --to <id> [--at n]
  delete                 delete a collection            -c <collection>
  sweep                  one pass of the deletion sweep [--grace-hours 24] [--trash-hours 168]
  verify                 check the log and every file   -c <collection> [--deep]
  stats                  what a collection lists, or what the folder holds   [-c <collection>]

Every command takes --dir <folder> (default ./underlay-v3) and --latency none|r2|r2-slow,
and with --requests prints the requests it made, by R2 billing class.`

const args = parseArgs(process.argv.slice(2))
const command = args._[0]
const flag = (name: string): string | undefined =>
  typeof args[name] === 'string' ? (args[name] as string) : undefined
const dir = flag('dir') ?? './underlay-v3'
const collection = flag('c') ?? flag('collection') ?? ''
const need = (what: string, value: string | undefined): string => {
  if (!value) {
    console.error(`${command}: ${what} is required`)
    process.exit(2)
  }
  return value
}
const version = () => (flag('version') === undefined ? {} : { version: Number(flag('version')) })
const out = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n')
const dec = new TextDecoder()

async function* input(path: string): AsyncGenerator<Uint8Array> {
  for await (const chunk of path === '-' ? process.stdin : createReadStream(path)) {
    yield chunk as Uint8Array
  }
}

async function build(store: Store, path: string) {
  const rows = v3.parseUpload(input(path))
  const scratch = fileStore(join(dir, 'tmp-sort'))
  const sorted = args.sorted ? rows : v3.sortRows(rows, scratch)
  const files = await v3.buildFiles(sorted, v3.storeTarget(store), {
    ...(flag('max-bytes') ? { maxBytes: Number(flag('max-bytes')) } : {}),
  })
  return files.map(refOf)
}

async function main(): Promise<void> {
  if (!command || command === 'help') {
    console.log(HELP)
    return
  }
  await mkdir(dir, { recursive: true })
  const store = new BenchStore(dir, flag('latency') ?? 'none')
  const cache = new v3.FileCache()
  const c = () => need('-c <collection>', collection)

  switch (command) {
    case 'build': {
      out(await build(store, need('a file', args._[1])))
      break
    }
    case 'push': {
      const files = await build(store, need('a file', args._[1]))
      const made = await v3.commitUpload(
        store,
        c(),
        { files, message: flag('message') ?? null },
        { verify: !args['no-verify'], validate: !args['no-validate'] },
      )
      out({
        number: made.commit.number,
        semver: made.commit.semver,
        id: made.id,
        files: files.length,
        check: made.check,
      })
      break
    }
    case 'commit': {
      const text = await new Response(
        createReadStream(need('a refs file', args._[1])) as never,
      ).text()
      const files = JSON.parse(text) as v3.FileRef[]
      const made = await v3.commitUpload(store, c(), { files, message: flag('message') ?? null })
      out({ number: made.commit.number, semver: made.commit.semver, id: made.id })
      break
    }
    case 'create': {
      out(await v3.createCollection(store, c()))
      break
    }
    case 'log': {
      const head = await v3.headNumber(store, c())
      for await (const s of v3.readLog(store, c(), 1, head)) {
        const files = v3.commitFiles(s.commit)
        out({
          number: s.commit.number,
          semver: s.commit.semver,
          id: s.id,
          createdAt: s.commit.createdAt,
          message: s.commit.changes[0]?.message ?? null,
          files: files.length,
          entries: files.reduce((n, f) => n + f.entries, 0),
        })
      }
      break
    }
    case 'read': {
      const view = await v3.openView(store, c(), version())
      const r = await v3.getRecord(
        store,
        view,
        need('a type', args._[1]),
        need('an id', args._[2]),
        { cache },
      )
      if (!r) {
        console.error('not found')
        process.exitCode = 1
      } else
        process.stdout.write(
          (r.line ? dec.decode(r.line) : JSON.stringify({ withheld: r.hash })) + '\n',
        )
      break
    }
    case 'page': {
      const view = await v3.openView(store, c(), version())
      const type = flag('type')
      const after = flag('after')
      const rows = await v3.page(
        store,
        view,
        {
          limit: Number(flag('limit') ?? 50),
          ...(type ? { type } : {}),
          ...(after && type ? { after: { type, id: after } } : {}),
        },
        { cache },
      )
      for (const r of rows) process.stdout.write((r.line ? dec.decode(r.line) : '') + '\n')
      break
    }
    case 'export': {
      const view = await v3.openView(store, c(), version())
      const type = flag('type')
      for await (const r of v3.exportAll(store, view, type ? { type } : {}, { cache })) {
        if (r.line && !process.stdout.write(Buffer.concat([r.line, Buffer.from('\n')]))) {
          await new Promise<void>((res) => process.stdout.once('drain', res))
        }
      }
      break
    }
    case 'diff': {
      const view = await v3.openView(store, c(), version())
      const since = Number(need('--since', flag('since')))
      for await (const ch of v3.changes(
        store,
        view,
        since,
        { before: args.before === true },
        { cache },
      )) {
        out({
          type: ch.type,
          id: ch.id,
          ...(ch.before !== undefined ? { before: ch.before?.hash ?? null } : {}),
          after: ch.after?.hash ?? null,
        })
      }
      break
    }
    case 'history': {
      const view = await v3.openView(store, c(), version())
      for (const h of await v3.history(
        store,
        view,
        need('a type', args._[1]),
        need('an id', args._[2]),
        { cache },
      )) {
        out(h)
      }
      break
    }
    case 'counts': {
      const view = await v3.openView(store, c(), version())
      out(Object.fromEntries(await v3.counts(store, view, {}, { cache })))
      break
    }
    case 'rebuild': {
      const retain = flag('retain')
      let rounds = 0
      for (;;) {
        const r = await v3.rebuild(store, c(), {
          ...(args.all && rounds === 0 ? { plan: v3.planAll } : {}),
          ...(flag('ratio') ? { tiers: { ratio: Number(flag('ratio')) } } : {}),
          ...(retain && rounds === 0
            ? {
                retained: retain
                  .split(',')
                  .map((r) => r.split('-').map(Number) as [number, number]),
              }
            : {}),
        })
        if (!r.layout) {
          if (rounds === 0) out({ layout: null, lost: r.lost })
          break
        }
        rounds++
        out({
          layout: r.layout.number,
          through: r.layout.through,
          merges: r.merges,
          filesIn: r.filesIn,
          filesOut: r.filesOut,
          written: r.written,
          skipped: r.skipped,
          dropped: r.dropped,
          files: r.layout.files.length,
        })
        if (args.all || retain) break
      }
      break
    }
    case 'recreate': {
      const { files } = await v3.currentFiles(store, c())
      const head = await v3.headNumber(store, c())
      const only = flag('commit')
      let ok = 0
      let bad = 0
      for await (const s of v3.readLog(
        store,
        c(),
        only ? Number(only) : 1,
        only ? Number(only) : head,
      )) {
        const made = await v3.recreate(store, files, s.commit, {
          cache,
          ...(args.write ? { target: v3.storeTarget(store) } : {}),
        })
        const matches = made.every((m) => m.matches)
        if (matches) ok++
        else bad++
        if (!matches || only)
          out({
            commit: s.commit.number,
            matches,
            files: made.map((m) => ({ want: m.want.id, got: m.id })),
          })
      }
      out({ commits: ok + bad, match: ok, differ: bad })
      if (bad > 0) process.exitCode = 1
      break
    }
    case 'fork': {
      const at = flag('at')
      const f = await v3.forkCollection(
        store,
        c(),
        need('--to', flag('to')),
        at ? { at: Number(at) } : {},
      )
      out({
        fork: f.description.id,
        forkedFrom: f.description.forkedFrom,
        objects: f.objects,
        bytes: f.bytes,
      })
      break
    }
    case 'delete': {
      out({ deleted: await v3.deleteCollection(store, c()) })
      break
    }
    case 'sweep': {
      const HOUR = 3_600_000
      const s = await v3.sweep(store, {
        graceMs: Number(flag('grace-hours') ?? 24) * HOUR,
        trashMs: Number(flag('trash-hours') ?? 168) * HOUR,
      })
      out({ ...s, logical: Object.fromEntries(s.logical) })
      break
    }
    case 'verify': {
      const description = await v3.readDescription(store, c())
      const head = await v3.verifyLog(store, c(), {
        files: true,
        ...(description?.lineage ? { lineage: description.lineage } : {}),
      })
      let files = 0
      let entries = 0
      if (args.deep) {
        for (const f of (await v3.currentFiles(store, c())).files) {
          const v = await v3.verifyFile(store, v3.recordKey(f.id), {
            id: f.id,
            labeled: f.labeled,
            canonical: true,
          })
          files++
          entries += v.content.entries
        }
      }
      out({
        ok: true,
        head: head?.commit.number ?? 0,
        id: head?.id ?? null,
        ...(args.deep ? { files, entries } : {}),
      })
      break
    }
    case 'stats': {
      if (collection) out(await v3.collectionStats(store, collection))
      else {
        let collections = 0
        let last = ''
        for await (const key of listAll(store, 'collections/')) {
          const id = key.split('/')[1]!
          if (id !== last) collections++
          last = id
        }
        out({ collections, disk: await diskUsage(dir) })
      }
      break
    }
    default:
      console.error(`Unknown command "${command}".\n\n${HELP}`)
      process.exit(2)
  }
  if (args.requests) {
    const n = store.snapshot()
    console.error(
      `requests: ${n.classA} class A, ${n.classB} class B, ${n.deletes} deletes; ` +
        `${n.bytesIn} bytes in, ${n.bytesOut} out; $${costOf(n).toFixed(6)}`,
    )
  }
}

main().catch((err: unknown) => {
  if (err instanceof v3.UploadError) {
    for (const p of err.problems) console.error(`refused: ${p}`)
  } else console.error(err instanceof Error ? `${err.name}: ${err.message}` : err)
  process.exit(1)
})
