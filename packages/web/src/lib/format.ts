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

export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1)
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}

/**
 * Byte size with one fixed decimal ("1.0 KB"), capped at GB — the style of the
 * explore and home listings. formatBytes trims the decimal ("1 KB").
 */
export function formatBytesFixed(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

/** Compact count: 999, 1.2k, 12k, 1.2M. */
export function formatCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
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
