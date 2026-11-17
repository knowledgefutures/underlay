/**
 * The Underlay CLI's commands (src/cli.ts runs them). Kept apart so the site can build the
 * command reference from them (scripts/site-assets.tsx) without running anything.
 *
 * underlay: the Underlay CLI. One program, used three ways (local-tool.md): commands, a
 * terminal UI (plain `underlay` in a terminal), and `underlay serve`. The commands and the
 * UI call the library in src/core directly.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { v3 } from '@underlay/protocol'
import { Command, Option } from 'commander'

import { askHidden, confirm, confirmTyped } from './commands/prompt.js'
import {
  addCollection,
  collectionStatus,
  forget,
  keep,
  KEEP_MARK,
  listPublic,
  listRemote,
  newCollection,
} from './core/collections.js'
import {
  addSource,
  type Keep,
  loadSettings,
  personalPath,
  removeRule,
  removeSource,
  SETTINGS,
  setRule,
  setSetting,
  getSetting,
} from './core/config.js'
import { coll, type Ctx, openColl, openCtx } from './core/context.js'
import { CliError, defaultEnv, type Env, expandPath, tildePath } from './core/env.js'
import { ago, bytes, count, diffVersions, duration, shortId } from './core/format.js'
import { Home, keyOf } from './core/home.js'
import {
  addFile,
  defaultOptions,
  eject,
  readTable,
  readTables,
  runImport,
  saveImport,
} from './core/importers.js'
import { Remote } from './core/remote.js'
import { listRuns, readLog, readRun, runScript, signalRun, startDetached } from './core/runs.js'
import { findScript, listScripts, type ScriptInfo } from './core/scripts.js'
import { secretKey, SOURCE_FILE, SOURCE_HEADER } from './core/sources.js'
import { isLoud, pull, push, pushPlan, type PushPlan, remoteHead, StaleError } from './core/sync.js'
import { update } from './core/update.js'
import { cidOf, logOf, reword, saveVersion, squash, undo, viewOf } from './core/versions.js'
import { openInBrowser, serveView } from './core/views.js'

/** Set by scripts/build.mjs to the commit the bundle was built from; absent when run from source. */
declare const UNDERLAY_BUILD: string | undefined

export const VERSION = '0.3.0'
/** The version with its build: `0.3.0 (c52aea4)`. */
export const FULL_VERSION =
  typeof UNDERLAY_BUILD === 'string' ? `${VERSION} (${UNDERLAY_BUILD})` : VERSION
const say = (line = '') => console.log(line)
export const env: Env = defaultEnv()
const ctx = (): Ctx => openCtx(env, say)
const json = (v: unknown) => say(JSON.stringify(v, null, 2))
const keepOpt = () =>
  new Option('--keep <keep>', 'how much to keep here').choices(['all', 'some', 'none'])
const kindLabel = (s: ScriptInfo) =>
  s.kind === 'script' ? '' : s.kind === 'view' ? (s.view === 'server' ? 'serves' : 'view') : s.kind
const list = (v: string) =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

export const program = new Command()
  .name('underlay')
  .description(
    'The Underlay CLI: collections on your machine, scripts that make versions, and push.\nPlain `underlay` in a terminal opens the terminal UI.',
  )
  .version(FULL_VERSION)
  .showHelpAfterError()

// --- Home, script folders, and config ---

program
  .command('init')
  .description('Make your home: collections, scripts, inputs, and AGENTS.md (default ~/Underlay)')
  .argument('[dir]', 'folder (default: home in config.toml, or ~/Underlay)')
  .action((dir: string | undefined) => {
    const s = loadSettings(env)
    const root = dir ? expandPath(env, dir) : s.home
    const home = Home.init(root)
    if (root !== s.home) {
      if (env.homeDir) say(`UNDERLAY_HOME is set: it still wins over config.toml`)
      setSetting(env, 'home', tildePath(env, home.root))
    }
    say(`Home in ${tildePath(env, home.root)}`)
    say(`Next: underlay login, then underlay ls, then underlay add <authority>/<org>/<name>`)
    say(`Shared scripts: underlay sources add <folder>`)
  })

const sources = program
  .command('sources')
  .description('Script folders: home’s scripts/, the ones in config.toml, and the one you are in')
sources
  .command('ls', { isDefault: true })
  .description('Each script folder and how many scripts it has')
  .option('--json')
  .action((o: { json?: boolean }) => {
    const c = ctx()
    const scripts = listScripts(c)
    const rows = c.sources.map((x) => ({
      ...x,
      scripts: scripts.filter((s) => s.source === x.name).length,
    }))
    if (o.json) return json(rows)
    for (const r of rows)
      say(
        `${r.name.padEnd(16)} ${tildePath(env, r.root).padEnd(48)} ${r.exists ? `${r.scripts} scripts` : 'not on this machine'}${r.how === 'here' ? '  (the folder you are in)' : ''}${r.need.length ? `  needs ${r.need.join(', ')}` : ''}`,
      )
  })
sources
  .command('add')
  .description(
    'List a script folder in config.toml (a git repo of scripts, such as underlay-scrapers)',
  )
  .argument('<path>')
  .option('--name <name>', 'its short name in script names (default: the folder’s)')
  .action((path: string, o: { name?: string }) => {
    const s = addSource(env, path, o.name)
    const has = existsSync(join(s.path, SOURCE_FILE))
    say(
      `${s.name}: ${tildePath(env, s.path)}${has ? '' : `  (no ${SOURCE_FILE}: the whole folder is searched)`}`,
    )
  })
sources
  .command('rm')
  .description('Take a script folder out of config.toml (its files stay)')
  .argument('<name>')
  .action((name: string) =>
    say(removeSource(env, name) ? `Removed ${name}` : `No script folder ${name}`),
  )
sources
  .command('init')
  .description(`Write an ${SOURCE_FILE} in a folder, so it is a script folder when you are in it`)
  .argument('[dir]', 'folder', '.')
  .action((dir: string) => {
    const path = join(expandPath(env, dir), SOURCE_FILE)
    if (existsSync(path)) return say(`${tildePath(env, path)} is there already`)
    writeFileSync(
      path,
      SOURCE_HEADER +
        `\n# scripts = ["sources"]          # where to look (default: the whole folder)\n` +
        `# authority = "underlay.org"     # for collections named org/name\n\n` +
        `# [runners]                      # how to run a file, by extension\n# ".ts" = "pnpm exec tsx"\n\n` +
        `# [env]                          # secrets its scripts need: names only\n# need = ["ORCID_TOKEN"]\n`,
    )
    say(`Wrote ${tildePath(env, path)}`)
  })

const secret = program
  .command('secret')
  .description(
    'Secrets that script folders need (their underlay.toml [env] need), kept in the keychain',
  )
secret
  .command('set')
  .argument('<name>')
  .option('--value <value>', 'the value (otherwise asked for, without echo)')
  .action(async (name: string, o: { value?: string }) => {
    const v = o.value ?? (await askHidden(`${name}: `))
    if (!v) throw new CliError('No value given')
    env.keys.set(secretKey(name), v)
    say(`${name} kept in the ${env.keys.kind}`)
  })
secret
  .command('rm')
  .argument('<name>')
  .action((name: string) => {
    env.keys.delete(secretKey(name))
    say(`Forgot ${name}`)
  })

const config = program.command('config').description('Settings, in ~/.config/underlay/config.toml')
config
  .command('list', { isDefault: true })
  .description('Every setting, its value, and whether it is set')
  .option('--json')
  .action((o: { json?: boolean }) => {
    const s = loadSettings(env)
    const keys = [...SETTINGS.map((d) => d.key), ...s.remotes.map((r) => `remotes.${r.name}.url`)]
    const rows = keys.map((k) => ({ key: k, ...getSetting(env, k) }))
    if (o.json)
      return json({ settings: rows, rules: s.rules, sources: s.sources, file: personalPath(env) })
    for (const r of rows)
      say(`${r.key.padEnd(34)} ${r.value}${r.from === 'default' ? '  (default)' : ''}`)
    if (env.homeDir) say(`${'home'.padEnd(34)} ${tildePath(env, env.homeDir)}  (UNDERLAY_HOME)`)
    if (s.rules.length) {
      say('\nStore rules (most specific wins):')
      for (const r of s.rules)
        say(
          `  ${r.match.padEnd(32)} ${r.path ? `path ${tildePath(env, r.path)} ` : ''}${r.keep ? `keep ${r.keep}` : ''}`,
        )
    }
    if (s.sources.length) {
      say('\nScript folders:')
      for (const x of s.sources) say(`  ${x.name.padEnd(16)} ${tildePath(env, x.path)}`)
    }
  })
config
  .command('get')
  .description('A setting’s value')
  .argument('<key>')
  .action((key: string) => say(getSetting(env, key).value))
config
  .command('set')
  .description('Change a setting')
  .argument('<key>')
  .argument('<value>')
  .action((key: string, value: string) => {
    const path = setSetting(env, key, value)
    say(`${key} = ${value}  (${tildePath(env, path)})`)
  })
config
  .command('unset')
  .description('Put a setting back to its default')
  .argument('<key>')
  .action((key: string) => {
    setSetting(env, key, undefined)
    say(`${key} reset to its default`)
  })
config
  .command('edit')
  .description('Open config.toml in $EDITOR')
  .action(() => {
    spawnSync(process.env.EDITOR ?? 'vi', [personalPath(env)], { stdio: 'inherit' })
  })
const rule = config
  .command('rule')
  .description('Where records go, and what is kept, by authority, org or collection')
rule
  .command('add')
  .description('Send a collection’s records somewhere else, or set how much of it is kept')
  .argument('<match>', 'authority/org/name, with * at the end (underlay.org/mitp/*)')
  .option('--path <path>', 'a store of its own')
  .addOption(keepOpt())
  .action((match: string, o: { path?: string; keep?: Keep }) => {
    const path = setRule(env, { match, ...o })
    say(`Rule for ${match} in ${tildePath(env, path)}`)
  })
rule
  .command('rm')
  .description('Remove a store rule')
  .argument('<match>')
  .action((match: string) => say(removeRule(env, match) ? `Removed ${match}` : `No rule ${match}`))

// --- Remotes ---

program
  .command('login')
  .description('Sign in to a remote with an API key from its settings page')
  .argument('[remote]', 'underlay.org, staging.underlay.org, localhost:3000')
  .option('--key <key>', 'the key (otherwise asked for, without echo)')
  .action(async (name: string | undefined, o: { key?: string }) => {
    const s = loadSettings(env)
    const remote = name ?? s.defaultRemote
    const url = Remote.open(env, s, remote).url
    const key = o.key ?? (await askHidden(`Make a key at ${url}/settings/keys and paste it: `))
    if (!key) throw new CliError('No key given')
    const r = new Remote(remote, url, key, env.fetch)
    const me = await r.me()
    env.keys.set(remote, key)
    say(`Signed in to ${remote} as ${me.name} (${me.email}); key kept in the ${env.keys.kind}`)
    say(`Your orgs: ${me.orgs.map((x) => x.slug).join(', ') || 'none'}`)
  })
program
  .command('logout')
  .description('Forget the key for a remote')
  .argument('[remote]')
  .action((name: string | undefined) => {
    const remote = name ?? loadSettings(env).defaultRemote
    env.keys.delete(remote)
    say(`Signed out of ${remote}`)
  })
program
  .command('remotes')
  .description(
    'Remotes, whether you are signed in, and how many of your orgs’ collections are here',
  )
  .option('--json')
  .action(async (o: { json?: boolean }) => {
    const c = ctx()
    const rows = []
    for (const r of c.settings.remotes) {
      const here = c.home.collections().filter((x) => x.authority === r.name).length
      let total: number | null = null
      let user: string | null = null
      const signedIn = env.keys.get(r.name) !== null
      if (signedIn) {
        try {
          const l = await listRemote(c, r.name)
          total = l.orgs.reduce((n, x) => n + x.collections.length, 0)
          user = l.user?.name ?? null
        } catch (err) {
          user = `unreachable: ${(err as Error).message.slice(0, 60)}`
        }
      }
      rows.push({ name: r.name, url: r.url, signedIn, user, here, total })
    }
    if (o.json) return json(rows)
    for (const r of rows)
      say(
        `${r.signedIn ? '●' : '○'} ${r.name.padEnd(24)} ${r.signedIn ? `${r.here} / ${r.total ?? '?'}` : 'signed out'}${r.user ? `   ${r.user}` : ''}`,
      )
  })
program
  .command('ls')
  .description('A remote’s collections: your orgs’, or public ones')
  .argument('[remote]')
  .option('--public [search]', 'public collections from any org')
  .option('--json')
  .action(async (name: string | undefined, o: { public?: string | boolean; json?: boolean }) => {
    const c = ctx()
    const remote = name ?? c.settings.defaultRemote
    if (o.public) {
      const rows = await listPublic(c, remote, typeof o.public === 'string' ? o.public : undefined)
      if (o.json) return json(rows)
      for (const r of rows)
        say(
          `${r.here ? KEEP_MARK[r.here.keep] : '+'} ${`${r.ownerSlug}/${r.slug}`.padEnd(36)} ${count(r.recordCount).padStart(12)} ${bytes(r.totalBytes).padStart(8)}  ${r.latestVersion ?? ''}`,
        )
      return
    }
    const l = await listRemote(c, remote)
    if (o.json) return json(l)
    if (!l.signedIn)
      throw new CliError(`Not signed in to ${remote}: underlay login ${remote} (or --public)`)
    for (const org of l.orgs) {
      const here = org.collections.filter((x) => x.here).length
      say(`${org.slug}  ${org.name}  (${here} of ${org.collections.length} here)`)
      for (const x of org.collections)
        say(
          `  ${x.here ? KEEP_MARK[x.here.keep] : '+'} ${x.slug.padEnd(32)} ${x.public ? 'public ' : 'private'} ${count(x.recordCount).padStart(12)} ${bytes(x.totalBytes).padStart(8)}  ${x.latestVersion ?? ''}`,
        )
    }
    say(`\n■ all here  ◧ some  □ metadata only  + not here: underlay add ${remote}/<org>/<name>`)
  })

// --- Collections ---

program
  .command('add')
  .description('Add a collection from its authority: authority/org/name')
  .argument('<collections...>')
  .addOption(keepOpt())
  .option('--types <types>', 'with --keep some: the types to keep', list)
  .action(async (refs: string[], o: { keep?: Keep; types?: string[] }) => {
    const c = ctx()
    for (const r of refs) {
      const { coll: added, pulled } = await addCollection(c, r, {
        ...(o.keep ? { keep: o.keep } : o.types ? { keep: 'some' as const } : {}),
        ...(o.types ? { types: o.types } : {}),
      })
      const head = await v3.findHead(added.store.fs, cidOf(added))
      say(
        `${KEEP_MARK[added.meta.keep]} ${added.key}: ${head ? head.commit.semver : 'no versions'}, ${pulled.fetched} versions, ${pulled.files} files fetched`,
      )
    }
  })
program
  .command('new')
  .description('Start a collection that is not on its authority yet; the first push creates it')
  .argument('<collection>', 'authority/org/name (localhost:3000/… for one only you need)')
  .option('--public', 'public once pushed (default private)')
  .option('--title <title>')
  .action((r: string, o: { public?: boolean; title?: string }) => {
    const c = ctx()
    const meta = newCollection(c, r, {
      access: o.public ? 'public' : 'private',
      ...(o.title ? { title: o.title } : {}),
    })
    say(
      `New: ${keyOf(meta)} (${meta.access}). Put its schemas in ${tildePath(env, c.home.collectionDir(meta))}/schemas/<Type>.json`,
    )
  })
program
  .command('keep')
  .description('Keep all of a collection here (or some types), fetching what is missing')
  .argument('<collection>')
  .option('--types <types>', 'only these types', list)
  .action(async (name: string, o: { types?: string[] }) => {
    const n = await keep(ctx(), coll(ctx(), name), o.types)
    say(`Fetched ${n} files`)
  })
program
  .command('forget')
  .description('Keep only metadata here; files go unless something else needs them')
  .argument('<collection>')
  .action(async (name: string) => say(`Let go of ${await forget(ctx(), coll(ctx(), name))} files`))

program
  .command('status')
  .description('Collections here and how they stand, scripts, and runs')
  .option('--json')
  .option('--fetch', 'ask each authority for its newest version')
  .action(async (o: { json?: boolean; fetch?: boolean }) => {
    const c = ctx()
    const rows = []
    for (const meta of c.home.collections()) {
      const st = await collectionStatus(c, meta)
      let behind: number | null = null
      if (o.fetch && !meta.isNew) {
        try {
          const n = await remoteHead(openColl(c, meta))
          behind = n === null ? null : Math.max(0, n - (st.remote?.number ?? 0))
        } catch {
          behind = null
        }
      }
      rows.push({ ...st, behind })
    }
    const runs = listRuns(c)
    const all = listScripts(c)
    const scripts = all.map((s) => {
      const last = runs.find((r) => r.script === s.name)
      return {
        ...s,
        last: last
          ? { id: last.id, status: last.status, at: last.endedAt ?? last.startedAt }
          : null,
      }
    })
    if (o.json)
      return json({
        home: c.home.root,
        store: c.settings.storePath,
        sources: c.sources,
        collections: rows,
        scripts,
        runs: runs.slice(0, 20),
      })
    say(`Home ${tildePath(env, c.home.root)}   store ${tildePath(env, c.settings.storePath)}`)
    let last = ''
    for (const r of rows) {
      if (r.authority !== last) say(`${(last = r.authority)}`)
      const sync = [
        r.isNew ? 'new' : '',
        r.unpushed > 0 ? `↑${r.unpushed}` : '',
        r.behind ? `↓${r.behind}` : '',
        runs.some(
          (x) =>
            x.status === 'running' &&
            x.saved.length === 0 &&
            all.find((s) => s.name === x.script)?.writes.includes(keyOf(r.ref)),
        )
          ? '▶'
          : '',
      ]
        .filter(Boolean)
        .join(' ')
      say(
        `  ${KEEP_MARK[r.keep]} ${`${r.ref.org}/${r.ref.name}`.padEnd(34)} ${(r.head?.semver ?? '–').padEnd(8)} ${sync}`,
      )
    }
    if (rows.length === 0) say('No collections here yet: underlay ls, then underlay add')
    if (scripts.length) {
      say('Scripts')
      for (const s of scripts)
        say(
          `  ${s.last ? (s.last.status === 'ok' ? '✓' : s.last.status === 'running' ? '▶' : '✗') : ' '} ${s.name.padEnd(34)} ${kindLabel(s).padEnd(6)} ${s.last ? ago(s.last.at) : ''}`,
        )
    }
  })

program
  .command('pull')
  .description('Follow each collection’s authority; versions not yet pushed are replayed on top')
  .argument('[collections...]')
  .action(async (names: string[]) => {
    const c = ctx()
    const metas = names.length
      ? names.map((n) => c.home.resolve(n))
      : c.home.collections().filter((m) => !m.isNew)
    for (const meta of metas) {
      const r = await pull(c, openColl(c, meta))
      const parts = [
        `${r.fetched} new versions`,
        r.files ? `${r.files} files` : '',
        r.schemas.length ? `schemas: ${r.schemas.join(', ')}` : '',
      ]
      say(`${keyOf(meta)}: ${parts.filter(Boolean).join(', ')}`)
      for (const x of r.replayed)
        say(
          `  replayed ${x.from.commit.semver} (${x.from.commit.number}) → ${x.to.commit.semver} (${x.to.commit.number}), not pushed`,
        )
    }
  })

function describePlan(p: PushPlan) {
  const loud = isLoud(p)
  say(
    `${p.coll.key}  ${p.access === 'public' ? 'PUBLIC' : 'private'}${p.isNew ? '  (new: created on push)' : ''}  ${p.from?.semver ?? 'nothing'} → ${p.versions.at(-1)!.semver}${loud && p.removed ? `  REMOVES ${count(p.removed)}` : ''}`,
  )
  for (const v of p.versions) {
    const st = v.stats
      ? `+${count(v.stats.added)} ~${count(v.stats.changed)} -${count(v.stats.removed)}`
      : ''
    say(`  ${v.semver.padEnd(8)} ${shortId(v.id)}  ${st.padEnd(24)} ${v.message ?? ''}`)
  }
}

program
  .command('push')
  .description(
    'Copy versions not yet pushed to each collection’s authority, unchanged. Asks first.',
  )
  .argument('[collections...]')
  .option('--yes', 'skip the y/N question (never the typed one)')
  .action(async (names: string[], o: { yes?: boolean }) => {
    const c = ctx()
    const metas = names.length ? names.map((n) => c.home.resolve(n)) : c.home.collections()
    const plans = (await Promise.all(metas.map((m) => pushPlan(openColl(c, m))))).filter(
      (p): p is PushPlan => p !== null,
    )
    if (plans.length === 0) return say('Nothing to push')
    for (const p of plans) describePlan(p)
    const loud = plans.some(isLoud)
    const versions = plans.reduce((n, p) => n + p.versions.length, 0)
    const ok = loud
      ? await confirmTyped(
          `Push ${versions} versions${plans.some((p) => p.access === 'public') ? ', to a public collection' : ''}${plans.some((p) => p.removed >= 1000) ? ', removing many records' : ''}?`,
          'push',
        )
      : o.yes || (await confirm(`Push ${versions} versions?`))
    if (!ok) return say('Not pushed')
    for (const p of plans) {
      try {
        await push(c, p.coll)
      } catch (err) {
        if (err instanceof StaleError) {
          say(err.message)
          process.exitCode = 1
          continue
        }
        throw err
      }
    }
  })

// --- Scripts, runs, versions ---

program
  .command('run')
  .description('Run a script; save a version for each collection it changed')
  .argument('<script>', 'its name (scrapers/mitp/monthly, or monthly when unique) or its file')
  .argument('[args...]')
  .option('--detach', 'run in its own process and return (the terminal UI does this)')
  .addOption(new Option('--run-id <id>').hideHelp())
  .option('--quiet', 'do not echo the script’s output')
  .allowUnknownOption()
  .action(
    async (
      script: string,
      args: string[],
      o: { detach?: boolean; runId?: string; quiet?: boolean },
    ) => {
      const c = ctx()
      const info = findScript(c, script)
      if (o.detach) {
        const id = startDetached(c, info.path, args)
        return say(`Run ${id} started: underlay runs ${id}`)
      }
      const r = await runScript(c, info, args, {
        ...(o.runId ? { id: o.runId } : {}),
        ...(o.quiet ? {} : { onOutput: (t: string) => process.stdout.write(t) }),
        importer: (i, a, out, log) => runImport(c, i, a, out, log),
      })
      say(
        `\n${r.status === 'ok' ? '✓' : '✗'} ${info.name}  ${duration(r.startedAt, r.endedAt)}  run ${r.id}${r.error ? `: ${r.error}` : ''}`,
      )
      for (const s of r.saved)
        say(
          `  ${s.collection}  ${s.semver} · ${shortId(s.id)} · not pushed   +${count(s.added)} ~${count(s.changed)} -${count(s.removed)}`,
        )
      for (const u of r.unchanged) say(`  ${u}  no changes`)
      if (r.git)
        say(
          `  script at ${r.git.commit.slice(0, 7)}${r.git.dirty ? ' (with uncommitted changes)' : ''}`,
        )
      for (const i of r.inputs)
        say(`  read ${i.path} (${bytes(i.bytes)}, ${i.sha256.slice(0, 12)})`)
      say(`  log ${tildePath(env, r.log)}`)
      if (r.status !== 'ok') process.exitCode = 1
    },
  )
program
  .command('runs')
  .description('Every run, newest first; or one run and its log')
  .argument('[run]')
  .option('--json')
  .option('--follow', 'with a run: follow its log until it ends')
  .action(async (id: string | undefined, o: { json?: boolean; follow?: boolean }) => {
    const c = ctx()
    if (id) {
      let r = readRun(c, id)
      if (o.json) return json(r)
      let at = 0
      for (;;) {
        const chunk = readLog(r, at)
        process.stdout.write(chunk.text)
        at = chunk.next
        if (!o.follow || (r.status !== 'running' && r.status !== 'paused')) break
        await new Promise((res) => setTimeout(res, 500))
        r = readRun(c, id)
      }
      return say(`\n${r.status}  ${r.saved.map((s) => `${s.collection} ${s.semver}`).join(', ')}`)
    }
    const runs = listRuns(c)
    if (o.json) return json(runs)
    for (const r of runs.slice(0, 50))
      say(
        `${r.status === 'ok' ? '✓' : r.status === 'running' ? '▶' : r.status === 'paused' ? '‖' : '✗'} ${r.id}  ${r.script.padEnd(32)} ${duration(r.startedAt, r.endedAt).padStart(8)}  ${r.saved.map((s) => `${s.collection.split('/').slice(1).join('/')} ${s.semver}`).join(', ')}`,
      )
  })
for (const what of ['pause', 'resume', 'cancel'] as const)
  program
    .command(what)
    .description(`${what[0]!.toUpperCase() + what.slice(1)} a running script`)
    .argument('<run>')
    .action((id: string) => {
      signalRun(ctx(), id, what)
      say(`${what}: run ${id}`)
    })

program
  .command('log')
  .description('A collection’s versions, newest first')
  .argument('<collection>')
  .option('--json')
  .action(async (name: string, o: { json?: boolean }) => {
    const c = coll(ctx(), name)
    const state = c.store.state(cidOf(c))
    const rows = (await logOf(c)).reverse().map((s) => ({
      number: s.commit.number,
      semver: s.commit.semver,
      id: s.id,
      message: s.commit.changes[0]?.message ?? null,
      createdAt: s.commit.createdAt,
      pushed: s.commit.number <= (state.remote?.number ?? 0),
      note: state.versions[s.id] ?? null,
    }))
    if (o.json) return json(rows)
    for (const r of rows)
      say(
        `${r.semver.padEnd(8)} ${String(r.number).padStart(4)} ${shortId(r.id)}  ${r.pushed ? `✓ ${c.meta.authority}` : 'not pushed'}  ${ago(r.createdAt)}  ${r.message ?? ''}`,
      )
  })
program
  .command('diff')
  .description('What changed: by default, what a push would send (or the newest version)')
  .argument('<collection>')
  .argument('[from]', 'version number')
  .argument('[to]', 'version number')
  .option('--json')
  .action(
    async (
      name: string,
      fromS: string | undefined,
      toS: string | undefined,
      o: { json?: boolean },
    ) => {
      const c = coll(ctx(), name)
      const head = await v3.headNumber(c.store.fs, cidOf(c))
      const pushedTo = c.store.state(cidOf(c)).remote?.number ?? 0
      const to = toS ? Number(toS) : head
      const from = fromS ? Number(fromS) : pushedTo < head ? pushedTo : Math.max(0, head - 1)
      const d = await diffVersions(c, from, to)
      if (o.json) return json({ from, to, ...d })
      say(`${c.key}: ${from} → ${to}`)
      for (const [t, n] of Object.entries(d.byType))
        say(`  ${t.padEnd(24)} +${count(n.added)} ~${count(n.changed)} -${count(n.removed)}`)
      for (const r of d.rows) say(`${r.kind} ${r.type}/${r.id}`)
      if (d.more) say('…')
    },
  )
program
  .command('export')
  .description('A version’s records as NDJSON ({id, type, data})')
  .argument('<collection>')
  .option('--version <n>', 'a version number (default the newest)')
  .option('--type <type>')
  .action(async (name: string, o: { version?: string; type?: string }) => {
    const c = coll(ctx(), name)
    const view = await viewOf(c, o.version ? Number(o.version) : undefined)
    const dec = new TextDecoder()
    for await (const r of v3.exportAll(
      c.data,
      view,
      o.type ? { type: o.type } : { from: { type: '$\u{10FFFF}', id: '' } },
    )) {
      if (r.line && !process.stdout.write(dec.decode(r.line) + '\n'))
        await new Promise((res) => process.stdout.once('drain', res))
    }
  })
program
  .command('save')
  .description('Save a version by hand: schema edits, or records from an NDJSON file')
  .argument('<collection>')
  .option('-m, --message <message>')
  .option('--from <file>', 'NDJSON records: the whole collection, unless --additions')
  .option('--additions', 'the file holds additions and changes only')
  .action(async (name: string, o: { message?: string; from?: string; additions?: boolean }) => {
    const c = ctx()
    const cl = coll(c, name)
    let rows: AsyncIterable<v3.LineRow>
    let mode: 'set' | 'additions' = o.additions ? 'additions' : 'set'
    if (o.from) {
      const { createReadStream } = await import('node:fs')
      rows = v3.parseUpload(createReadStream(o.from) as AsyncIterable<Uint8Array>)
    } else {
      // Schemas only: the records stay as they are.
      rows = (async function* () {})()
      mode = 'additions'
    }
    const r = await saveVersion(cl, {
      rows,
      mode,
      schemas: c.home.schemas(cl.meta),
      message: o.message ?? null,
      now: env.now(),
    })
    say(
      r.version
        ? `${cl.key}: ${r.version.commit.semver} · ${shortId(r.version.id)} · not pushed  +${r.stats.added} ~${r.stats.changed} -${r.stats.removed}${r.stats.schemas ? `, ${r.stats.schemas} schemas` : ''}`
        : `${cl.key}: no changes`,
    )
  })
program
  .command('undo')
  .description('Drop the newest version not yet pushed')
  .argument('<collection>')
  .action(async (name: string) => {
    const s = await undo(coll(ctx(), name))
    say(`Dropped ${s.commit.semver} (${s.commit.number}) · ${shortId(s.id)}`)
  })
program
  .command('squash')
  .description('Merge versions not yet pushed into one, so the states between are never uploaded')
  .argument('<collection>')
  .option('--from <n>', 'the first version to merge (default the first not pushed)')
  .option('-m, --message <message>')
  .action(async (name: string, o: { from?: string; message?: string }) => {
    const s = await squash(
      coll(ctx(), name),
      o.from ? Number(o.from) : undefined,
      o.message ?? null,
      env.now(),
    )
    say(
      s
        ? `Squashed into ${s.commit.semver} (${s.commit.number}) · ${shortId(s.id)}`
        : 'They cancel out: nothing left to save',
    )
  })
program
  .command('reword')
  .description('Change the message of a version not yet pushed')
  .argument('<collection>')
  .argument('<message>')
  .option('--version <n>', 'default the newest')
  .action(async (name: string, message: string, o: { version?: string }) => {
    const s = await reword(
      coll(ctx(), name),
      o.version ? Number(o.version) : undefined,
      message,
      env.now(),
    )
    say(`${s.commit.semver} (${s.commit.number}) · ${shortId(s.id)}: ${message}`)
  })

// --- Files and imports ---

program
  .command('add-file')
  .description('Copy a file into inputs/, read its shape, and find the collection it matches')
  .argument('<path>')
  .option('--json')
  .action(async (path: string, o: { json?: boolean }) => {
    const c = ctx()
    const shape = await addFile(c, path)
    if (o.json) return json(shape)
    say(`${shape.path}  (${shape.format})`)
    for (const t of shape.tables) {
      say(`  ${t.name}: ${count(t.rows)} rows, ${t.columns.length} columns`)
      say(
        `    ${t.columns.map((col) => (t.idColumns.includes(col) ? `${col}*` : t.personal.includes(col) ? `${col}!` : col)).join(', ')}`,
      )
    }
    say('    * looks like an id   ! looks personal: left out unless asked for')
    for (const m of shape.matches.slice(0, 5))
      say(
        `  ${count(m.hits)} of ${count(m.of)} ${m.column} values are ${m.type} ids in ${m.collection}${shape.tables.length > 1 ? ` (${m.table})` : ''}`,
      )
    if (shape.scripts.length)
      say(`  Scripts that take it: ${shape.scripts.map((s) => s.name).join(', ')}`)
    const best = shape.matches[0]
    say(
      best
        ? `Import it: underlay import ${shape.path} --collection ${best.collection} --type ${best.type} --id ${best.column}${shape.tables.length > 1 ? ` --sheet ${JSON.stringify(best.table)}` : ''}`
        : `Import it: underlay import ${shape.path} --collection <authority/org/name> --type <Type> [--id <column>]`,
    )
  })
program
  .command('import')
  .description(
    'Import a sheet or table into one type of a collection, with the built-in importer; saves its options and runs it',
  )
  .argument('<file>')
  .requiredOption('--collection <collection>')
  .requiredOption('--type <type>')
  .option('--sheet <sheet>', 'sheet or table')
  .option('--query <sql>', 'SQLite: a query instead of a table')
  .option('--id <column>', 'the id column (default: the first that looks like one)')
  .addOption(
    new Option('--missing <what>', 'rows without an id').choices(['hold', 'skip']).default('hold'),
  )
  .option('--additions', 'the file holds additions and changes only (default: the whole set)')
  .option('--where <field=value...>', 'with a whole set: the part of the type it is the whole of')
  .option('--column <column=field...>', 'map a column to a field ("column=" leaves it out)')
  .option('--personal', 'keep columns that look personal')
  .option('--save <name>', 'name for home’s scripts/imports/<name>.toml (default: the file’s)')
  .option('--no-run', 'save the options without running')
  .action(async (file: string, o: Record<string, any>) => {
    const c = ctx()
    const t = await readTable(file, {
      ...(o.sheet ? { sheet: o.sheet } : {}),
      ...(o.query ? { query: o.query } : {}),
    })
    const opts = defaultOptions(c, file, t, {
      collection: o.collection,
      type: o.type,
      ...(o.id ? { id: o.id } : {}),
      ...(o.sheet ? { sheet: o.sheet } : {}),
      personal: !!o.personal,
    })
    if (o.query) opts.query = o.query
    opts.missing_id = o.missing
    if (o.additions) opts.mode = 'additions'
    if (o.where)
      opts.where = Object.fromEntries(
        (o.where as string[]).map((kv) => kv.split(/=(.*)/s).slice(0, 2)),
      )
    for (const kv of (o.column ?? []) as string[]) {
      const [col, field] = kv.split(/=(.*)/s) as [string, string]
      opts.columns[col] = field ?? ''
    }
    const name =
      o.save ??
      file
        .split('/')
        .pop()!
        .replace(/\.[^.]+$/, '')
        .replace(/[^A-Za-z0-9._-]/g, '-')
    const scriptName = saveImport(c, name, opts)
    say(`Saved ${scriptName}`)
    const mapped = Object.entries(opts.columns)
    say(
      `  ${opts.id} → id; ${mapped
        .filter(([, f]) => f)
        .map(([col, f]) => (col === f ? col : `${col} → ${f}`))
        .join(', ')}`,
    )
    const off = mapped.filter(([, f]) => !f).map(([col]) => col)
    if (off.length) say(`  left out: ${off.join(', ')}`)
    if (o.run === false) return
    const info = findScript(c, scriptName)
    const r = await runScript(c, info, [file], {
      onOutput: (text) => process.stdout.write(text),
      importer: (i, a, out, log) => runImport(c, i, a, out, log),
    })
    for (const s of r.saved)
      say(
        `  ${s.collection}  ${s.semver} · ${shortId(s.id)} · not pushed   +${count(s.added)} ~${count(s.changed)} -${count(s.removed)}`,
      )
    for (const u of r.unchanged) say(`  ${u}  no changes`)
    if (r.status !== 'ok') {
      say(`✗ ${r.error}`)
      process.exitCode = 1
    }
  })
program
  .command('read')
  .description(
    'A file’s rows as NDJSON objects, with the built-in readers (or its sheets, with --tables)',
  )
  .argument('<file>')
  .option('--sheet <sheet>')
  .option('--query <sql>')
  .option('--tables', 'list sheets or tables instead')
  .option('--limit <n>')
  .action(
    async (
      file: string,
      o: { sheet?: string; query?: string; tables?: boolean; limit?: string },
    ) => {
      if (o.tables) {
        for (const t of await readTables(file))
          say(`${t.name}\t${t.rows.length} rows\t${t.columns.join(', ')}`)
        return
      }
      const t = await readTable(file, {
        ...(o.sheet ? { sheet: o.sheet } : {}),
        ...(o.query ? { query: o.query } : {}),
      })
      const rows = o.limit ? t.rows.slice(0, Number(o.limit)) : t.rows
      for (const r of rows) say(JSON.stringify(r))
    },
  )
program
  .command('eject')
  .description('Turn an import into an editable script with its options written in')
  .argument('<import>')
  .action((name: string) => {
    const c = ctx()
    const info = findScript(c, name)
    if (info.kind !== 'import') throw new CliError(`${info.name} is not an import`)
    say(`Wrote ${eject(c, info)}; ${info.name} still runs the built-in until you remove it`)
  })

program
  .command('schema')
  .description(
    'A collection’s schemas as JSON, by type (or one type’s): for scripts that read them',
  )
  .argument('<collection>')
  .argument('[type]')
  .action((name: string, type: string | undefined) => {
    const c = ctx()
    const schemas = c.home.schemas(c.home.resolve(name))
    if (!type) return json(schemas)
    if (!(type in schemas))
      throw new CliError(
        `No schema for ${type} (types: ${Object.keys(schemas).join(', ') || 'none'})`,
      )
    json(schemas[type])
  })

program
  .command('view')
  .description(
    'Open a view: a page in the browser, or a script that serves one (stopped with Ctrl-C)',
  )
  .argument('<view>', 'its name, or its file')
  .option('--no-open', 'print the address without opening a browser')
  .action(async (name: string, o: { open: boolean }) => {
    const c = ctx()
    const info = findScript(c, name)
    if (info.kind !== 'view')
      throw new CliError(`${info.name} is a ${info.kind}, not a view: underlay run ${info.name}`)
    if (info.view === 'page') {
      if (o.open) openInBrowser(info.path)
      return say(info.path)
    }
    const v = await serveView(c, info, { onOutput: (t) => process.stdout.write(t) })
    say(`${info.name} at ${v.url}  (Ctrl-C stops it)`)
    if (o.open) openInBrowser(v.url)
    await new Promise<void>((done) => {
      const stop = () => {
        v.stop()
        done()
      }
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
      v.child.once('exit', () => done())
    })
  })

program
  .command('update')
  .description(
    'Update the CLI from where it was installed (staging or underlay.org), checked by its SHA-256',
  )
  .action(async () => {
    const r = await update(env)
    if (!r.changed) return say(`underlay ${FULL_VERSION} is the newest from ${r.origin}`)
    let now = 'the newest'
    try {
      now = execFileSync(process.execPath, [r.file, '--version'], { encoding: 'utf8' }).trim()
    } catch {
      // It is in place; its version shows next time.
    }
    say(`Updated underlay ${FULL_VERSION} → ${now}, from ${r.origin}`)
  })

program
  .command('ui', { hidden: true })
  .description('Open the terminal UI')
  .action(() => openUi())

export async function openUi() {
  const { runUi } = await import('./tui/main.js')
  await runUi(env)
}
