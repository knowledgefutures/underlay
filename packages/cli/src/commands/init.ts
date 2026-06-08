import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { initStore } from '../lib/store.js'

export function init(dir?: string): void {
  const target = resolve(dir ?? '.')
  if (existsSync(join(target, '.underlay'))) {
    console.log('Already initialized.')
    return
  }
  initStore(target)
  console.log(`Initialized empty Underlay repository in ${target}/.underlay/`)
}
