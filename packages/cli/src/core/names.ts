/**
 * What a server takes as a collection's name, checked here so the first push isn't where you
 * find out. The same rules as the reference server's (packages/server/src/lib/slug.ts,
 * RESERVED_COLLECTION_SLUGS and SLUG_RE): keep the two in step.
 */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
const RESERVED = new Set([
  'settings',
  'activity',
  'billing',
  'collections',
  'members',
  'new',
  'people',
  'usage',
])

/** What is wrong with a collection name for a server, or null. */
export function nameProblem(name: string, server: string): string | null {
  if (name.length < 2 || name.length > 64 || !SLUG_RE.test(name))
    return 'A name is lowercase letters, numbers, and hyphens'
  if (RESERVED.has(name)) return `${server} keeps "${name}" for itself; choose another name`
  return null
}

/** A name from a file's: lowercase, hyphens, and dates and version numbers taken off. */
export function nameFromFile(file: string): string {
  const base = file.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '')
  const words = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .split('-')
    .filter(Boolean)
  // Dates, years and versions at the end: roster-2026, export-2026-11-17, data-v2.
  while (words.length > 1 && /^(\d{1,4}|v\d+|final|copy)$/.test(words.at(-1)!)) words.pop()
  return words.join('-').slice(0, 64) || 'collection'
}

/** A type from a sheet's or file's name: singular, capitalized (members → Member). */
export function typeFromName(name: string): string {
  const w = name
    .replace(/\.[^.]+$/, '')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((x) => x && !/^\d+$/.test(x))
  const last = (w.at(-1) ?? 'Record').toLowerCase()
  const one = last.endsWith('ies')
    ? last.slice(0, -3) + 'y'
    : /(ss|us)$/.test(last)
      ? last
      : last.endsWith('s')
        ? last.slice(0, -1)
        : last
  return one.charAt(0).toUpperCase() + one.slice(1)
}
