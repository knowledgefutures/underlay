export function deriveSemver(
  prevSemver: string | null,
  schemaChanged: boolean,
  recordsChanged: boolean,
): string {
  if (!prevSemver) return 'v1.0.0'
  const parts = prevSemver.replace(/^v/, '').split('.').map(Number)
  const [major, minor, patch] = [parts[0] ?? 1, parts[1] ?? 0, parts[2] ?? 0]
  if (schemaChanged) return `v${major + 1}.0.0`
  if (recordsChanged) return `v${major}.${minor + 1}.0`
  return `v${major}.${minor}.${patch + 1}`
}
