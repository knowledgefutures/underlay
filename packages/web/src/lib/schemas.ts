import { apiFetch } from '~/lib/fetch-base'

export interface SchemaEntry {
  slug: string
  /** Global schema id and hash: null when built from a version (no schema API yet). */
  schemaId: string | null
  schemaHash: string | null
  schema: unknown
}

export interface SchemasData {
  semver: string | null
  schemas: SchemaEntry[]
}

/**
 * A version's schemas in the shape of GET /api/collections/:owner/:slug/schemas.
 *
 * v2 has no schema routes yet, but a version's detail carries its visible
 * schemas by type, so the page still shows every type's fields; only the links
 * to the global schema pages are missing. Once the schema route answers, it wins.
 */
export async function loadSchemas(
  url: (path: string) => URL,
  headers: Record<string, string>,
  prefix: string,
  version: string | null,
): Promise<SchemasData | null> {
  const query = version ? `?version=${encodeURIComponent(version)}` : ''
  const res = await apiFetch(url(`${prefix}/schemas${query}`), { headers })
  if (res.ok) return res.json()
  const v = await apiFetch(url(`${prefix}/versions/${version ?? 'latest'}`), { headers })
  if (!v.ok) return null
  const detail = (await v.json()) as { semver: string; schemas?: Record<string, unknown> }
  return {
    semver: detail.semver,
    schemas: Object.entries(detail.schemas ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([slug, schema]) => ({ slug, schemaId: null, schemaHash: null, schema })),
  }
}
