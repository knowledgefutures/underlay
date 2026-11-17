/**
 * Handing work to an agent (local-tool.md "Handing off to an agent"). The tool runs no agent:
 * `c` copies a prompt, and `C` sends it to the command `handoff.send` names (for example
 * `hopper draft new --project kf/underlay-scrapers -`), which takes it on stdin.
 */
import { spawnSync } from 'node:child_process'

import type { Ctx } from './context.js'
import { CliError } from './env.js'
import type { Shape } from './importers.js'
import type { RunRecord } from './runs.js'

export type HandoffTarget =
  | { kind: 'collection'; key: string }
  | {
      kind: 'file'
      shape: Shape
      /** A schema drafted for the import's type, to shape. */
      draft?: { collection: string; type: string; schema: unknown; path: string }
    }
  | { kind: 'run'; run: RunRecord }

export function handoffPrompt(ctx: Ctx, t: HandoffTarget): string {
  const lines = [`Work in the Underlay home at ${ctx.home.root}. Read AGENTS.md there first.`, '']
  if (t.kind === 'collection') {
    lines.push(
      `About the collection ${t.key} (collections/${t.key}/: collection.toml, README.md, schemas/).`,
      'Task: <say what you want done with it>',
      '',
      `\`underlay export ${t.key}\` prints its records as NDJSON; \`underlay log ${t.key}\` its versions.`,
    )
  } else if (t.kind === 'file' && t.draft) {
    // Shape the schema the importer drafted, from the file it was drafted from.
    const s = t.shape
    const d = t.draft
    const table = s.tables[0]
    lines.push(
      `Task: shape the schema for ${d.type} in ${d.collection} from ${s.path} (${table ? `${table.rows} rows, ${table.columns.length} columns` : s.format}).`,
      'The draft below was guessed from the columns: a field for each column but the id, required where no row is blank.',
      ...(table?.personal.length
        ? [
            `Columns that look personal were left out unless the data needs them: ${table.personal.join(', ')}.`,
          ]
        : []),
      `Write it to collections/${d.collection}/${d.path}, then tell me what you changed and why.`,
      '',
      'Draft:',
      JSON.stringify(d.schema, null, 2),
      '',
      'Sample rows:',
      ...(table?.sample ?? []).map((r) => JSON.stringify(r)),
    )
  } else if (t.kind === 'file') {
    const s = t.shape
    const m = s.matches[0]
    lines.push(
      `Task: write a script in ${ctx.home.root}/scripts/imports/ that imports ${s.path} (${s.format}).`,
      ...s.tables.map(
        (x) =>
          `- ${x.name}: ${x.rows} rows; columns ${x.columns.join(', ')}${x.personal.length ? `; looks personal, leave out unless needed: ${x.personal.join(', ')}` : ''}`,
      ),
      m
        ? `It matches ${m.collection}: ${m.hits} of ${m.of} ${m.column} values are ${m.type} ids there. Its schemas are in collections/${m.collection}/schemas/.`
        : 'No collection here shares its ids yet: say which it belongs in.',
      'The built-in importer could not handle it as one sheet to one type; the script can do what it needs.',
      'Hold back rows you are unsure of: write them to inputs/ in the home with the reason, rather than guessing.',
      'Run it with `underlay run`.',
    )
  } else {
    const r = t.run
    lines.push(
      `Task: the run ${r.id} of ${r.script}${r.path ? ` (${r.path})` : ''} ${r.status === 'failed' ? 'failed' : r.status}${r.error ? ` (${r.error})` : ''}. Find out why and fix the script.`,
      `Its log: ${r.log}`,
      r.args.length ? `It was run with: ${r.args.join(' ')}` : '',
      `Run it again with \`underlay run ${r.script}\`.`,
    )
  }
  lines.push('', 'Save versions; don’t push. Pushing is the person’s step.')
  return lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n')
}

/** Put text on the clipboard: pbcopy, wl-copy, or xclip. */
export function copyText(text: string): boolean {
  for (const [cmd, args] of [
    ['pbcopy', []],
    ['wl-copy', []],
    ['xclip', ['-selection', 'clipboard']],
  ] as const) {
    const r = spawnSync(cmd, args, { input: text })
    if (r.status === 0) return true
  }
  return false
}

/** Send a prompt to the handoff command, on its stdin. */
export function sendHandoff(ctx: Ctx, text: string): string {
  const cmd = ctx.settings.handoffSend
  if (!cmd)
    throw new CliError(
      'No handoff command: set handoff.send (for example: hopper draft new --project <key> -)',
    )
  const r = spawnSync('sh', ['-c', cmd], { input: text, cwd: ctx.home.root, encoding: 'utf8' })
  if (r.status !== 0)
    throw new CliError(
      `${cmd}: ${(r.stderr || r.stdout || `exit ${r.status}`).trim().slice(0, 200)}`,
    )
  return (r.stdout || '').trim()
}
