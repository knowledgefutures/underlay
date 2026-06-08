import { readConfig, writeConfig } from '../lib/config.js'
import { requireRoot } from '../lib/store.js'

export function remoteAdd(
  name: string,
  url: string,
  opts: { token?: string; collection?: string },
): void {
  const root = requireRoot()
  const config = readConfig(root)

  if (config.remotes[name]) {
    console.error(`Remote "${name}" already exists. Use \`underlay remote remove\` first.`)
    process.exit(1)
  }

  config.remotes[name] = {
    url: url.replace(/\/$/, ''),
    token: opts.token,
    collection: opts.collection,
  }
  writeConfig(root, config)
  console.log(`Remote "${name}" added: ${url}`)
}

export function remoteRemove(name: string): void {
  const root = requireRoot()
  const config = readConfig(root)

  if (!config.remotes[name]) {
    console.error(`Remote "${name}" not found.`)
    process.exit(1)
  }

  delete config.remotes[name]
  writeConfig(root, config)
  console.log(`Remote "${name}" removed.`)
}

export function remoteList(): void {
  const root = requireRoot()
  const config = readConfig(root)

  const names = Object.keys(config.remotes)
  if (names.length === 0) {
    console.log('No remotes configured.')
    return
  }

  for (const name of names) {
    const remote = config.remotes[name]!
    const parts = [remote.url]
    if (remote.collection) parts.push(`(${remote.collection})`)
    console.log(`${name}\t${parts.join(' ')}`)
  }
}
