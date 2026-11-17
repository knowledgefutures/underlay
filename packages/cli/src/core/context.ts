/**
 * What a command works with: the machine (Env), home, the settings, the script folders, and
 * where to say things. And a collection opened in it: its store and its authority.
 */
import type { Store } from '@underlay/protocol'

import { loadSettings, type Settings } from './config.js'
import { ruleFor } from './config.js'
import { CliError, type Env, tildePath } from './env.js'
import { type CollectionMeta, Home, keyOf } from './home.js'
import { Remote } from './remote.js'
import { type Source, sourcesOf } from './sources.js'
import { FetchingStore, LocalStore } from './store.js'

export type Say = (line: string) => void

export interface Ctx {
  env: Env
  home: Home
  settings: Settings
  /** Home's scripts, the listed script folders, and the one the command runs in. */
  sources: Source[]
  /** The working directory the script folders were found from. */
  cwd: string
  say: Say
}

export function openCtx(env: Env, say: Say, cwd = process.cwd()): Ctx {
  const settings = loadSettings(env)
  if (!Home.exists(settings.home))
    throw new CliError(
      `No Underlay home at ${tildePath(env, settings.home)}: run \`underlay init\` to make one`,
    )
  const home = new Home(settings.home)
  return { env, home, settings, sources: sourcesOf(settings, home, cwd), cwd, say }
}

/** Settings and script folders read again: the settings screen or an editor may have changed them. */
export function refreshCtx(ctx: Ctx): void {
  ctx.settings = loadSettings(ctx.env)
  ctx.sources = sourcesOf(ctx.settings, ctx.home, ctx.cwd)
}

export interface Coll {
  meta: CollectionMeta
  key: string
  store: LocalStore
  /** The local store, fetching record files it lacks from the authority. */
  data: Store
  remote(): Remote
}

const stores = new Map<string, LocalStore>()

export function storeAt(root: string): LocalStore {
  let s = stores.get(root)
  if (!s) stores.set(root, (s = new LocalStore(root)))
  return s
}

export function openColl(ctx: Ctx, meta: CollectionMeta): Coll {
  const key = keyOf(meta)
  const store = storeAt(ruleFor(ctx.settings, key).path)
  let remote: Remote | null = null
  const remoteOf = () => (remote ??= Remote.open(ctx.env, ctx.settings, meta.authority, ctx.say))
  const data = new FetchingStore(
    store.fs,
    meta.isNew ? null : (id) => remoteOf().file(meta.org, meta.name, id),
  )
  return { meta, key, store, data, remote: remoteOf }
}

/** A collection by name, opened. */
export function coll(ctx: Ctx, name: string): Coll {
  return openColl(ctx, ctx.home.resolve(name))
}
