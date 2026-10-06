import type { LoaderApi } from '~/lib/fetch-base'

export interface SchemaEntry {
  slug: string
  schemaId: string | null
  schemaHash: string | null
  schema: unknown
}

export interface SchemasData {
  semver: string | null
  schemas: SchemaEntry[]
}

/** A version's schemas (GET /api/collections/:owner/:slug/schemas), or null. */
export function loadSchemas(
  api: LoaderApi,
  prefix: string,
  version: string | null,
): Promise<SchemasData | null> {
  const query = version ? `?version=${encodeURIComponent(version)}` : ''
  return api.json(`${prefix}/schemas${query}`, null)
}
