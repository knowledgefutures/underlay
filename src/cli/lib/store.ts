import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { compareSemver } from '../../lib/core/index.js'
import { parseJsonOrExit } from './json.js'

const UNDERLAY_DIR = '.underlay'

export function findRoot(startDir: string = process.cwd()): string | null {
  let dir = startDir
  while (true) {
    if (existsSync(join(dir, UNDERLAY_DIR))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export function requireRoot(): string {
  const root = findRoot()
  if (!root) {
    console.error('Not an Underlay repository. Run `underlay init` first.')
    process.exit(1)
  }
  return root
}

export function underlayDir(root: string): string {
  return join(root, UNDERLAY_DIR)
}

export function initStore(dir: string): void {
  const ud = join(dir, UNDERLAY_DIR)
  mkdirSync(join(ud, 'objects'), { recursive: true })
  mkdirSync(join(ud, 'schemas'), { recursive: true })
  mkdirSync(join(ud, 'versions'), { recursive: true })
  mkdirSync(join(ud, 'staging'), { recursive: true })
  writeFileSync(join(ud, 'HEAD'), '', 'utf-8')
  if (!existsSync(join(ud, 'config.json'))) {
    writeFileSync(join(ud, 'config.json'), JSON.stringify({ remotes: {} }, null, 2), 'utf-8')
  }
}

function objectPath(root: string, hash: string): string {
  return join(underlayDir(root), 'objects', hash.slice(0, 2), hash.slice(2, 4), hash)
}

function schemaPath(root: string, hash: string): string {
  return join(underlayDir(root), 'schemas', hash.slice(0, 2), hash.slice(2, 4), hash)
}

export function hasObject(root: string, hash: string): boolean {
  return existsSync(objectPath(root, hash))
}

export function readObject(root: string, hash: string): string | null {
  const p = objectPath(root, hash)
  if (!existsSync(p)) return null
  return readFileSync(p, 'utf-8')
}

export function writeObject(root: string, hash: string, content: string): void {
  const p = objectPath(root, hash)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content, 'utf-8')
}

export function hasSchema(root: string, hash: string): boolean {
  return existsSync(schemaPath(root, hash))
}

export function readSchema(root: string, hash: string): string | null {
  const p = schemaPath(root, hash)
  if (!existsSync(p)) return null
  return readFileSync(p, 'utf-8')
}

export function writeSchema(root: string, hash: string, content: string): void {
  const p = schemaPath(root, hash)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content, 'utf-8')
}

export function getHead(root: string): string {
  return readFileSync(join(underlayDir(root), 'HEAD'), 'utf-8').trim()
}

export function setHead(root: string, semver: string): void {
  writeFileSync(join(underlayDir(root), 'HEAD'), semver, 'utf-8')
}

export type VersionManifest = {
  semver: string
  hash: string
  message: string
  metadata: Record<string, unknown> | null
  schemas: Record<string, string>
  records: string[]
  files: string[]
  createdAt: string
}

export function readVersion(root: string, semver: string): VersionManifest | null {
  const p = join(underlayDir(root), 'versions', `${semver}.json`)
  if (!existsSync(p)) return null
  return parseJsonOrExit<VersionManifest>(
    readFileSync(p, 'utf-8'),
    `version manifest ${p}`,
    'The file is corrupt. Restore it from a backup, or delete it and re-pull from the remote.',
  )
}

export function writeVersion(root: string, manifest: VersionManifest): void {
  const p = join(underlayDir(root), 'versions', `${manifest.semver}.json`)
  writeFileSync(p, JSON.stringify(manifest, null, 2), 'utf-8')
}

export function listVersions(root: string): string[] {
  const dir = join(underlayDir(root), 'versions')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace('.json', ''))
    .sort(compareSemver)
}
