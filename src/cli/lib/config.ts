import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { underlayDir } from './store.js'

export type Remote = {
  url: string
  token?: string | undefined
  collection?: string | undefined
}

export type Config = {
  remotes: Record<string, Remote>
}

export function readConfig(root: string): Config {
  const p = join(underlayDir(root), 'config.json')
  if (!existsSync(p)) return { remotes: {} }
  return JSON.parse(readFileSync(p, 'utf-8')) as Config
}

export function writeConfig(root: string, config: Config): void {
  const p = join(underlayDir(root), 'config.json')
  writeFileSync(p, JSON.stringify(config, null, 2), 'utf-8')
}
