/**
 * Filesystem-based route generation.
 *
 * Converts file paths from import.meta.glob into React Router route patterns.
 * Follows Next.js/Astro conventions:
 *   - index.tsx  → parent path
 *   - [param].tsx → :param dynamic segment
 *   - static segments sort before dynamic ones
 */

export interface RouteEntry {
  path: string
  filePath: string
}

/**
 * Convert a glob key like "./routes/docs/api/[id].tsx"
 * into a route path like "/docs/api/:id".
 */
function fileToRoutePath(file: string): string {
  // Strip prefix and extension: "./routes/foo/bar.tsx" → "foo/bar"
  let route = file.replace(/^\.\/routes\//, '').replace(/\.tsx$/, '')

  // index files map to parent: "docs/index" → "docs", "index" → ""
  route = route.replace(/(^|\/)+index$/, '')

  // Convert [param] segments to :param
  route = route.replace(/\[([^\]]+)\]/g, ':$1')

  return '/' + route
}

/**
 * Sort routes so static segments come before dynamic ones (Next.js/Astro convention).
 * More specific routes first, catch-all dynamic routes last.
 */
function sortRoutes(routes: RouteEntry[]): RouteEntry[] {
  return routes.sort((a, b) => {
    const aParts = a.path.split('/').filter(Boolean)
    const bParts = b.path.split('/').filter(Boolean)

    // Compare segment by segment
    const len = Math.max(aParts.length, bParts.length)
    for (let i = 0; i < len; i++) {
      const aP = aParts[i]
      const bP = bParts[i]

      // Missing segment = shorter path, comes later for catch-all scenarios
      // But "/" (root) should come first
      if (!aP && !bP) continue
      if (!aP) return -1 // a is shorter → a first
      if (!bP) return 1 // b is shorter → b first

      const aDynamic = aP.startsWith(':')
      const bDynamic = bP.startsWith(':')

      // Static before dynamic at the same level
      if (!aDynamic && bDynamic) return -1
      if (aDynamic && !bDynamic) return 1

      // Both static or both dynamic: alphabetical
      if (aP < bP) return -1
      if (aP > bP) return 1
    }

    return 0
  })
}

/**
 * Build sorted route entries from a glob result.
 * Usage: buildRoutes(import.meta.glob('./routes/...*.tsx'))
 */
export function buildRoutes(globResult: Record<string, () => Promise<unknown>>): RouteEntry[] {
  const entries: RouteEntry[] = Object.keys(globResult).map((filePath) => ({
    path: fileToRoutePath(filePath),
    filePath,
  }))

  return sortRoutes(entries)
}
