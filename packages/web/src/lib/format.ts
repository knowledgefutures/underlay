/**
 * Stored semvers carry a leading 'v' ("v1.0.0"). Page URLs use the bare form
 * (/v/1.0.0); the API normalizes both via parseSemver, so either resolves.
 */
export function bareSemver(semver: string): string {
  return semver.replace(/^v/, '')
}

/**
 * A hash with its algorithm prefix. v2 version hashes carry one (`ulv2:<hex>`);
 * v1's were bare SHA-256 hex, so those get `sha256:`.
 */
export function prefixedHash(hash: string): string {
  return hash.includes(':') ? hash : `sha256:${hash}`
}

/** The prefix and the first `n` hex digits of a hash, for display. */
export function shortHash(hash: string, n: number): string {
  const full = prefixedHash(hash)
  return `${full.slice(0, full.indexOf(':') + 1 + n)}…`
}

/** A URL slug typed or derived from a name: lowercase, hyphens, a-z0-9 only. */
export function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
}

/** Byte sizes in decimal units, as labelled: 1 KB = 1,000 bytes, 1 MB = 1,000,000. */
export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '0 B'
  const k = 1000
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1)
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

/**
 * Byte size with one fixed decimal ("1.0 KB"), capped at GB — the style of the
 * explore and home listings. formatBytes trims the decimal ("1 KB").
 */
export function formatBytesFixed(bytes: number): string {
  if (bytes < 1e3) return `${bytes} B`
  if (bytes < 1e6) return `${(bytes / 1e3).toFixed(1)} KB`
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(1)} MB`
  return `${(bytes / 1e9).toFixed(1)} GB`
}

const SMALL_WORDS = new Set(['a', 'an', 'and', 'for', 'in', 'of', 'on', 'or', 'the', 'to'])

/**
 * A tag for display. Tags are publishers' data: "Cultural Heritage" stays as
 * written; a slug like "revive-and-restore" reads "Revive and Restore", and a
 * short one like "ncbi" reads as the acronym it usually is ("NCBI").
 */
export function tagLabel(tag: string): string {
  if (!/^[a-z0-9-_]+$/.test(tag)) return tag
  if (/^[a-z]{2,4}$/.test(tag)) return tag.toUpperCase()
  return tag
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w, i) => (i > 0 && SMALL_WORDS.has(w) ? w : w[0]!.toUpperCase() + w.slice(1)))
    .join(' ')
}

/** A count, compact once it's large: 1,284 / 12.9K / 4.2M / 1.2B. One style everywhere. */
export function formatCount(n: number): string {
  if (n < 10_000) return n.toLocaleString('en-US')
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}K`
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  return `${(n / 1_000_000_000).toFixed(1)}B`
}

/** "1 version", "3 versions", "12.9K versions". */
export const plural = (n: number, one: string, many = `${one}s`) =>
  `${formatCount(n)} ${n === 1 ? one : many}`

const DATE_PARTS = {
  day: { month: 'short', day: 'numeric', year: 'numeric' },
  monthDay: { month: 'short', day: 'numeric' },
  month: { month: 'short', year: 'numeric' },
} as const

/**
 * A date as "Oct 4, 2026", in UTC with a fixed locale, so the server's render
 * and the browser's agree (a local time zone would change the day).
 */
export function formatDate(
  value: string | number | Date,
  parts: keyof typeof DATE_PARTS = 'day',
): string {
  return new Date(value).toLocaleDateString('en-US', { ...DATE_PARTS[parts], timeZone: 'UTC' })
}

/** A date and time as "Oct 4, 2026, 14:05 UTC". */
export function formatDateTime(value: string | number | Date): string {
  return `${new Date(value).toLocaleString('en-US', {
    ...DATE_PARTS.day,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  })} UTC`
}

export function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}
