/**
 * A v1 database read through `docker exec … psql` on a remote host, for a v1
 * database with no reachable port and too big to copy (dev is 18 GB).
 *
 * One long-lived `ssh host docker exec -i <container> psql` session; queries run
 * one at a time. Each query is wrapped as `SELECT row_to_json(q)::text FROM (…) q`
 * so every row comes back as one line of JSON, followed by a sentinel line that
 * carries psql's SQLSTATE. Columns come back as postgres.js would give them to
 * the converter: json/jsonb as values, booleans, numbers, and timestamp and date
 * columns as Date (found per query shape with `\gdesc`). Ordered reads go through
 * server-side cursors in a read-only transaction, so a big type is sorted once
 * rather than once per page.
 *
 * The container is found by name on the host and must be exactly one match.
 * POSTGRES_USER and POSTGRES_DB are expanded inside the container, so no
 * credentials leave the box. Read-only: the session is opened with
 * `default_transaction_read_only`.
 *
 * Parameters are inlined as literals (strings and finite numbers only, which is
 * all the converter binds); `$n` must not appear in the query text otherwise.
 */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'

import type { V1Db } from './convert.js'

export interface SshPsqlOptions {
  /** ssh arguments before the remote command, e.g. ['-i', key, '-o', 'BatchMode=yes', 'deploy@host']. */
  ssh: string[]
  /** A `docker ps --filter name=` value that matches exactly one container. */
  container: string
  /** Refuse unless the matched container's name starts with this (a guard against prod). */
  requirePrefix?: string
  /** Replaces ssh for tests: run psql locally with these arguments prepended. */
  command?: string[]
}

const DATE_TYPES = /^(timestamp|date)/

function literal(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v === 'string') return `'${v.replaceAll("'", "''")}'`
  throw new Error(`sshPsql: unsupported parameter ${typeof v}`)
}

export function inlineParams(text: string, params: unknown[] = []): string {
  return text.replace(/\$(\d+)\b/g, (_, n: string) => {
    const i = Number(n) - 1
    if (i >= params.length) throw new Error(`sshPsql: no parameter $${n}`)
    return literal(params[i])
  })
}

export async function sshPsql(opts: SshPsqlOptions): Promise<V1Db & { close(): void }> {
  const filter = opts.container.replaceAll("'", '')
  const psql = `psql -X -q -At -v ON_ERROR_STOP=0 -U "$POSTGRES_USER" -d "$POSTGRES_DB"`
  const remote =
    `C=$(docker ps -q -f name='${filter}'); ` +
    `N=$(docker ps --format '{{.Names}}' -f name='${filter}'); ` +
    `[ "$(echo "$C" | grep -c .)" = 1 ] || { echo "matched: $N" >&2; exit 3; }; ` +
    (opts.requirePrefix
      ? `case "$N" in '${opts.requirePrefix.replaceAll("'", '')}'*) ;; *) echo "refusing $N" >&2; exit 4;; esac; `
      : '') +
    `exec docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on' "$C" sh -c '${psql}'`
  const proc: ChildProcessWithoutNullStreams = opts.command
    ? spawn(opts.command[0]!, [...opts.command.slice(1)], { stdio: 'pipe' })
    : spawn('ssh', [...opts.ssh, remote], { stdio: 'pipe' })

  let out = ''
  let err = ''
  let waiting: (() => void) | null = null
  let exited: string | null = null
  proc.stdout.setEncoding('utf8')
  proc.stderr.setEncoding('utf8')
  proc.stdout.on('data', (d: string) => {
    out += d
    waiting?.()
  })
  proc.stderr.on('data', (d: string) => {
    err += d
  })
  proc.on('exit', (code) => {
    exited = `psql session ended (${code}): ${err.trim()}`
    waiting?.()
  })

  let seq = 0
  /** Send a script and collect stdout lines up to its sentinel. */
  async function run(script: string): Promise<string[]> {
    const tag = `__ul_end_${++seq}__`
    err = ''
    // The error text rides on the sentinel: psql's stderr can arrive after stdout.
    proc.stdin.write(`${script}\n\\echo ${tag} :SQLSTATE :LAST_ERROR_MESSAGE\n`)
    const marker = `${tag} `
    for (;;) {
      const at = out.indexOf(marker)
      if (at !== -1) {
        const eol = out.indexOf('\n', at)
        if (eol !== -1) {
          const [state, ...message] = out
            .slice(at + marker.length, eol)
            .trim()
            .split(' ')
          const body = out.slice(0, at)
          out = out.slice(eol + 1)
          if (state !== '00000') {
            throw new Error(`v1 query failed (${state}): ${message.join(' ') || err.trim()}`)
          }
          return body.split('\n').filter((l) => l !== '')
        }
      }
      if (exited) throw new Error(exited)
      await new Promise<void>((r) => (waiting = r))
      waiting = null
    }
  }

  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    const p = queue.then(f, f)
    queue = p.catch(() => {})
    return p
  }

  const dateColumns = new Map<string, string[]>()
  async function dates(template: string, sql: string): Promise<string[]> {
    let cols = dateColumns.get(template)
    if (!cols) {
      const desc = await run(`${sql}\n\\gdesc`)
      cols = desc
        .map((l) => l.split('|'))
        .filter(([, type]) => DATE_TYPES.test(type ?? ''))
        .map(([name]) => name!)
      dateColumns.set(template, cols)
    }
    return cols
  }

  await serial(() => run('SELECT 1;'))

  const parse = <T>(lines: string[], cols: string[]) =>
    lines.map((l) => {
      const row = JSON.parse(l) as Record<string, unknown>
      for (const c of cols) if (typeof row[c] === 'string') row[c] = new Date(row[c] as string)
      return row as T
    })
  const prepare = (text: string, params?: unknown[]) =>
    inlineParams(text, params).trim().replace(/;$/, '')

  // Cursors live in one read-only transaction, open while any cursor is.
  let openCursors = 0
  let cursorSeq = 0

  return {
    query: <T>(text: string, params?: unknown[]) =>
      serial(async () => {
        const sql = prepare(text, params)
        const cols = await dates(text, sql)
        return parse<T>(await run(`SELECT row_to_json(q)::text FROM (${sql}) q;`), cols)
      }),
    cursor: <T>(text: string, params: unknown[], batch: number) =>
      serial(async () => {
        const sql = prepare(text, params)
        const cols = await dates(text, sql)
        const name = `ul_c${++cursorSeq}`
        if (openCursors === 0) await run('BEGIN READ ONLY;')
        openCursors++
        await run(
          `DECLARE ${name} NO SCROLL CURSOR FOR SELECT row_to_json(q)::text FROM (${sql}) q;`,
        )
        let closed = false
        return {
          next: () => serial(async () => parse<T>(await run(`FETCH ${batch} FROM ${name};`), cols)),
          close: () =>
            serial(async () => {
              if (closed) return
              closed = true
              await run(`CLOSE ${name};`)
              if (--openCursors === 0) await run('COMMIT;')
            }),
        }
      }),
    close: () => {
      proc.stdin.end()
    },
  }
}
