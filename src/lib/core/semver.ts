export interface SemverComponents {
  semver: string
  major: number
  minor: number
  patch: number
}

export function parseSemver(semver: string): SemverComponents {
  const parts = semver.replace(/^v/, '').split('.').map(Number)
  const [major, minor, patch] = [parts[0] ?? 1, parts[1] ?? 0, parts[2] ?? 0]
  return { semver: `v${major}.${minor}.${patch}`, major, minor, patch }
}

export function deriveSemver(
  prevSemver: string | null,
  schemaChanged: boolean,
  recordsChanged: boolean,
  metadataChanged?: boolean,
): SemverComponents {
  if (!prevSemver) return { semver: 'v1.0.0', major: 1, minor: 0, patch: 0 }
  const { major, minor, patch } = parseSemver(prevSemver)
  if (schemaChanged) return { semver: `v${major + 1}.0.0`, major: major + 1, minor: 0, patch: 0 }
  if (recordsChanged)
    return { semver: `v${major}.${minor + 1}.0`, major, minor: minor + 1, patch: 0 }
  if (metadataChanged)
    return { semver: `v${major}.${minor}.${patch + 1}`, major, minor, patch: patch + 1 }
  return { semver: `v${major}.${minor}.${patch + 1}`, major, minor, patch: patch + 1 }
}
