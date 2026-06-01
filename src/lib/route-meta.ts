interface RouteMatch {
  params: Record<string, string>
  route: { handle?: unknown }
}

interface HandleMeta {
  title?: string | ((params: Record<string, string>, loaderData: unknown) => string)
  description?: string | ((params: Record<string, string>, loaderData: unknown) => string)
}

export function extractRouteMeta(
  matches: RouteMatch[],
  loaderData?: unknown,
): { title: string | undefined; description: string | undefined } {
  let title: string | undefined
  let description: string | undefined

  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i]!
    const handle = match.route.handle as HandleMeta | undefined

    if (handle?.title && !title) {
      title =
        typeof handle.title === 'function' ? handle.title(match.params, loaderData) : handle.title
    }
    if (handle?.description && !description) {
      description =
        typeof handle.description === 'function'
          ? handle.description(match.params, loaderData)
          : handle.description
    }
    if (title && description) break
  }

  return { title, description }
}
