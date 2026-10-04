/** Read-only commands: status, log, diff, and managing remotes. */
import { diffTrees, recordTree, RepoSource } from '@underlay/protocol'

import { CliError, type Local } from '../local.js'
import { versionState } from '../state.js'
import type { Say } from './stage.js'

export function status(local: Local, say: Say): void {
  const head = local.headVersion()
  say(head ? `On ${head.semver} (${head.hash.slice(0, 17)}…)` : 'No versions yet.')
  for (const name of Object.keys(local.remotes())) {
    const t = local.tracking(name)
    if (!t) say(`  ${name}: never synced`)
    else if (head && t.hash === head.hash) say(`  ${name}: up to date at ${t.semver}`)
    else say(`  ${name}: last synced at ${t.semver}; ${head?.semver ?? 'nothing'} not pushed`)
  }
  const schemas = local.stagedSchemas()
  const metadata = local.stagedMetadata()
  const ops = local.stagedOps()
  if (!schemas && metadata === undefined && ops.length === 0) {
    say('Nothing staged.')
    return
  }
  say('Staged:')
  if (schemas) say(`  schemas: ${Object.keys(schemas).join(', ')}`)
  if (metadata !== undefined) say(metadata === null ? '  metadata: cleared' : '  metadata')
  const puts = ops.filter((o) => o.op === 'put').length
  if (puts > 0) say(`  ${puts} upsert(s)`)
  if (ops.length > puts) say(`  ${ops.length - puts} delete(s)`)
}

export function log(local: Local, say: Say): void {
  const head = local.head()
  const versions = local.versions()
  if (versions.length === 0) say('No versions yet.')
  for (const v of versions.reverse()) {
    const mark = v.semver === head ? '*' : ' '
    const from = v.remote ? ` [${v.remote}]` : ''
    say(
      `${mark} ${v.semver}  ${v.createdAt.slice(0, 19)}  ${v.hash.slice(0, 17)}…${from}  ${v.message ?? ''}`,
    )
  }
}

/** Records added, changed and removed between two local versions, per type. */
export async function diff(local: Local, from: string, to: string, say: Say): Promise<void> {
  const a = local.version(from)
  const b = local.version(to)
  if (!a || !b) throw new CliError(`No local version ${!a ? from : to}`)
  const sa = await versionState(local, a)
  const sb = await versionState(local, b)
  const source = new RepoSource(recordTree, local.repo)
  const slugs = new Set([...Object.keys(sa.schemas), ...Object.keys(sb.schemas)])
  for (const slug of [...slugs].sort()) {
    const n = { added: 0, updated: 0, removed: 0 }
    const sample: string[] = []
    for (const set of ['public', 'private'] as const) {
      for await (const d of diffTrees(
        source,
        sa[set].types[slug]?.root ?? null,
        sb[set].types[slug]?.root ?? null,
      )) {
        const kind = !d.before ? 'added' : !d.after ? 'removed' : 'updated'
        n[kind]++
        if (sample.length < 5)
          sample.push(`${kind === 'added' ? '+' : kind === 'removed' ? '-' : '~'}${d.key}`)
      }
    }
    if (!sa.schemas[slug]) say(`${slug}: new type`)
    else if (!sb.schemas[slug]) say(`${slug}: removed`)
    if (n.added + n.updated + n.removed > 0) {
      say(`${slug}: +${n.added} ~${n.updated} -${n.removed}  ${sample.join(' ')}`)
    }
  }
  if (JSON.stringify(sa.root.metadata) !== JSON.stringify(sb.root.metadata)) say('metadata changed')
}

export function remoteAdd(
  local: Local,
  name: string,
  url: string,
  opts: { collection?: string; token?: string },
  say: Say,
): void {
  if (!opts.collection || !/^[^/]+\/[^/]+$/.test(opts.collection)) {
    throw new CliError('Give the collection as --collection owner/slug')
  }
  const remotes = local.remotes()
  if (remotes[name]) throw new CliError(`Remote "${name}" already exists`)
  remotes[name] = { url, collection: opts.collection, ...(opts.token ? { token: opts.token } : {}) }
  local.setRemotes(remotes)
  say(`Added ${name}: ${url} ${opts.collection}`)
}

export function remoteRemove(local: Local, name: string, say: Say): void {
  const remotes = local.remotes()
  if (!remotes[name]) throw new CliError(`No remote named "${name}"`)
  delete remotes[name]
  local.setRemotes(remotes)
  local.setTracking(name, null)
  say(`Removed ${name}`)
}

export function remoteList(local: Local, say: Say): void {
  for (const [name, r] of Object.entries(local.remotes())) {
    say(`${name}  ${r.url}  ${r.collection}${r.token ? '  (token)' : ''}`)
  }
}
