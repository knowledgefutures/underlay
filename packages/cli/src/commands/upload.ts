/**
 * `underlay upload`: build a v3 upload here and send it to a v3 collection
 * (docs/protocol-v3.md; the server side is packages/server/src/v3/uploads.ts).
 *
 * The rows (NDJSON: records `{id, type, data}`, removals `{id, type, removed: true}`, and
 * `$schema`, `$meta`, `$asset` rows as the spec gives them) are sorted and written as
 * sorted-record-files in a local folder, cut by key as the library cuts them, so the same
 * rows always give the same files. Each file goes to the bucket by presigned URL; the
 * commit names them and the server verifies and lands it.
 *
 * An interrupted upload is taken up again with `--upload <id>`: the files are built again
 * from the rows (the same rows give the same files), and those already in the bucket are
 * not sent twice. The message is given when the upload is opened, so `-m` has no effect
 * with `--upload`.
 */
import { createReadStream } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { fileStore, v3 } from '@underlay/protocol'

import { CliError } from '../local.js'

export interface UploadOptions {
  to: string
  collection: string
  token?: string
  message?: string
  sorted?: boolean
  upload?: string
  dir?: string
  /** Files sent at once. */
  parallel?: number
}

type Say = (line: string) => void

/**
 * Run a send again on a network error or a 5xx or 429, with backoff: 1, 2, 4, 8, 16
 * seconds. One dropped connection among many large files used to end the whole upload.
 */
export async function withRetry<T>(
  what: string,
  send: () => Promise<T>,
  say: Say = () => {},
  opts: { attempts?: number; baseMs?: number } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 6
  for (let attempt = 1; ; attempt++) {
    try {
      return await send()
    } catch (err) {
      const retryable = !(err instanceof CliError) || /: (5\d\d|429)\b/.test(err.message)
      if (!retryable || attempt >= attempts) throw err
      const wait = (opts.baseMs ?? 1000) * 2 ** (attempt - 1)
      say(`  ${what} failed (${(err as Error).message}); trying again in ${wait / 1000}s`)
      await new Promise((r) => setTimeout(r, wait))
    }
  }
}

async function* input(path: string): AsyncGenerator<Uint8Array> {
  for await (const chunk of path === '-' ? process.stdin : createReadStream(path)) {
    yield chunk as Uint8Array
  }
}

export async function upload(path: string, o: UploadOptions, say: Say): Promise<void> {
  let id = o.upload
  try {
    await uploadOnce(path, o, say, (opened) => (id = opened))
  } catch (err) {
    // Built files are made again from the same rows, and those already sent are skipped.
    if (id) {
      say(`The upload stopped. To take it up again:`)
      say(
        `  underlay upload ${path} --to ${o.to} --collection ${o.collection} --upload ${id}` +
          (o.dir ? ` --dir ${o.dir}` : ''),
      )
    }
    throw err
  }
}

async function uploadOnce(
  path: string,
  o: UploadOptions,
  say: Say,
  opened: (id: string) => void,
): Promise<void> {
  const token = o.token ?? process.env.UL_KEY
  if (!token) throw new CliError('An API key is needed: --token, or UL_KEY in the environment')
  const api = `${o.to.replace(/\/$/, '')}/api/collections/${o.collection}`
  const call = async (method: string, p: string, body?: unknown) => {
    for (let attempt = 0; ; attempt++) {
      const res = await withRetry(`${method} ${p}`, () =>
        fetch(`${api}${p}`, {
          method,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      )
      if ((res.status === 429 || res.status >= 500) && attempt < 5) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
        continue
      }
      const json = (await res.json().catch(() => ({}))) as Record<string, any>
      if (!res.ok) throw new CliError(`${method} ${p}: ${res.status} ${JSON.stringify(json)}`)
      return json
    }
  }

  // 1. Build: sort the rows and write the files, here.
  const dir = o.dir ?? '.underlay-upload'
  await mkdir(dir, { recursive: true })
  const local = fileStore(dir)
  const rows = v3.parseUpload(input(path))
  const sorted = o.sorted ? rows : v3.sortRows(rows, fileStore(join(dir, 'tmp-sort')))
  const session = 'build'
  const t0 = Date.now()
  const built = await v3.buildFiles(sorted, v3.uploadTarget(local, session))
  const files = built.map((f) => ({
    id: f.id,
    first: f.first,
    last: f.last,
    entries: f.entries,
    records: f.records,
    removals: f.removals,
    bytes: f.bytes,
  }))
  say(
    `Built ${files.length} files (${files.reduce((n, f) => n + f.entries, 0)} rows) in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  )

  // 2. Open an upload, or take one up again.
  let id = o.upload
  if (!id) {
    const made = await call('POST', '/uploads', o.message ? { message: o.message } : {})
    id = made.upload_id as string
    say(`Upload ${id}`)
  }
  opened(id)
  const status = await call('GET', `/uploads/${id}`)
  const present = new Set<string>((status.present as string[] | undefined) ?? [])

  // 3. Send each file not there yet, a few at a time.
  const todo = files.filter((f) => !present.has(f.id))
  let sent = 0
  const sendOne = async (f: (typeof files)[number]) => {
    const bytes = await readFile(join(dir, v3.uploadKey(session, f.id)))
    const target = await call('POST', `/uploads/${id}/files`, { id: f.id, size: bytes.byteLength })
    if (target.method === 'PUT') {
      await withRetry(
        `Sending ${f.id.slice(0, 12)}`,
        async () => {
          const res = await fetch(target.url, { method: 'PUT', body: bytes })
          if (!res.ok) throw new CliError(`PUT ${f.id}: ${res.status} ${await res.text()}`)
        },
        say,
      )
    } else {
      const parts: { n: number; etag: string }[] = []
      for (const p of target.parts as { n: number; url: string }[]) {
        const from = (p.n - 1) * target.part_bytes
        const etag = await withRetry(
          `Sending ${f.id.slice(0, 12)} part ${p.n}`,
          async () => {
            const res = await fetch(p.url, {
              method: 'PUT',
              body: bytes.subarray(from, from + target.part_bytes),
            })
            if (!res.ok) throw new CliError(`PUT ${f.id} part ${p.n}: ${res.status}`)
            return res.headers.get('etag') ?? ''
          },
          say,
        )
        parts.push({ n: p.n, etag })
      }
      await call('POST', `/uploads/${id}/files/${f.id}/complete`, {
        upload_id: target.upload_id,
        parts,
      })
    }
    sent++
    if (sent % 25 === 0 || sent === todo.length) say(`Sent ${sent} of ${todo.length} files`)
  }
  const queue = [...todo]
  await Promise.all(
    Array.from({ length: Math.min(o.parallel ?? 4, queue.length) }, async () => {
      for (let f = queue.shift(); f; f = queue.shift()) await sendOne(f)
    }),
  )

  // 4. Commit, and wait for the server to verify and land it.
  // A small commit is answered with its result; a large one is verified by jobs: poll it,
  // soon at first, then every 5 seconds.
  const sentAt = Date.now()
  say(`Sent in ${((sentAt - t0) / 1000).toFixed(1)}s from the start; committing…`)
  let s = await call('POST', `/uploads/${id}/commit`, { files })
  for (let wait = 1000; s.status !== 'committed'; wait = Math.min(5000, wait * 2)) {
    if (s.status === 'failed' || s.status === 'open') {
      throw new CliError(`Upload ${id} ${s.status}: ${JSON.stringify(s.error)}`)
    }
    if (s.files_named) say(`  ${s.status}: ${s.files_verified} of ${s.files_named} files verified`)
    await new Promise((r) => setTimeout(r, wait))
    s = await call('GET', `/uploads/${id}`)
  }
  say(
    `Committed ${s.result.semver} (${s.result.hash}): ${s.result.recordCount} records, ${((Date.now() - sentAt) / 1000).toFixed(1)}s after sending`,
  )
}
