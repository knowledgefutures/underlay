/** Shared helpers for the user- and org-level API key settings pages. */

export function isExpiringSoon(expiresAt: string | null): boolean {
  if (!expiresAt) return false
  const daysLeft = (new Date(expiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
  return daysLeft > 0 && daysLeft < 7
}

export function isExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false
  return new Date(expiresAt) < new Date()
}

export function getScope(permissions?: Record<string, string[]>): string {
  const perms = permissions?.['collections'] ?? []
  if (perms.includes('admin')) return 'admin'
  if (perms.includes('write')) return 'write'
  return 'read'
}
