import { lazy, type ComponentType } from 'react'
import type { RouteObject } from 'react-router'

export interface RouteEntry {
  path: string
  filePath: string
}

function fileToRoutePath(file: string): string {
  let route = file.replace(/^\.\/routes\//, '').replace(/\.(tsx|data\.ts)$/, '')
  route = route.replace(/(^|\/)+index$/, '')
  route = route.replace(/\[([^\]]+)\]/g, ':$1')
  return '/' + route
}

function sortRoutes(routes: RouteEntry[]): RouteEntry[] {
  return routes.sort((a, b) => {
    const aParts = a.path.split('/').filter(Boolean)
    const bParts = b.path.split('/').filter(Boolean)

    const len = Math.max(aParts.length, bParts.length)
    for (let i = 0; i < len; i++) {
      const aP = aParts[i]
      const bP = bParts[i]

      if (!aP && !bP) continue
      if (!aP) return -1
      if (!bP) return 1

      const aDynamic = aP.startsWith(':')
      const bDynamic = bP.startsWith(':')

      if (!aDynamic && bDynamic) return -1
      if (aDynamic && !bDynamic) return 1

      if (aP < bP) return -1
      if (aP > bP) return 1
    }

    return 0
  })
}

export function buildRoutes(globResult: Record<string, () => Promise<unknown>>): RouteEntry[] {
  const entries: RouteEntry[] = Object.keys(globResult).map((filePath) => ({
    path: fileToRoutePath(filePath),
    filePath,
  }))

  return sortRoutes(entries)
}

export function buildDataRoutes(
  components: Record<string, () => Promise<{ default: ComponentType }>>,
  dataModules: Record<
    string,
    { loader?: RouteObject['loader']; handle?: unknown; middleware?: RouteObject['middleware'] }
  >,
): RouteObject[] {
  const entries = buildRoutes(components)

  return entries.map((entry) => {
    const dataPath = entry.filePath.replace('.tsx', '.data.ts')
    const data = dataModules[dataPath]

    const route: RouteObject = {
      path: entry.path,
      Component: lazy(components[entry.filePath]!),
    }
    if (data?.loader) route.loader = data.loader
    if (data?.handle) route.handle = data.handle
    if (data?.middleware) route.middleware = data.middleware
    return route
  })
}
