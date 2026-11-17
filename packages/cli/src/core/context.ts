/**
 * What a command works with: the machine (Env), the workspace, the merged settings, and
 * where to say things. And a collection opened in it: its store and its authority.
 */
import { existsSync } from 'node:fs'

import type { Store } from '@underlay/protocol'

import { loadSettings, ruleFor, type Settings, workspaceConfigPath } from './config.js'
import { CliError, type Env } from './env.js'
import { Remote } from './remote.js'
import { FetchingStore, LocalStore } from './store.js'
import { type CollectionMeta, keyOf, Workspace } from './workspace.js'

export type Say = (line: string) => void

export interface Ctx {
  env: Env
  ws: Workspace
  settings: Settings
  say: Say
}

/** The workspace the command runs in: the one holding `cwd`, else the default one. */
export function findWorkspace(env: Env, cwd = process.cwd()): Workspace | null {
  const here = Workspace.find(cwd)
  if (here) return here
  const d = loadSettings(env, null).defaultWorkspace
  return d && existsSync(workspaceConfigPath(d)) ? new Workspace(d) : null
}

export function openCtx(env: Env, say: Say, cwd = process.cwd()): Ctx {
  const ws = findWorkspace(env, cwd)
  if (!ws) throw new CliError('Not in an Underlay workspace: run `underlay init` to make one here')
  return { env, ws, settings: loadSettings(env, ws.root), say }
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
  return openColl(ctx, ctx.ws.resolve(name))
}
