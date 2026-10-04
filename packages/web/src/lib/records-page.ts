import type { LoaderApi } from '~/lib/fetch-base'

export const RECORDS_PAGE_SIZE = 100

export interface RecordsPage {
  /** The type being shown: ?type=, else the first type alphabetically. */
  type: string | null
  /** 1-based page number from ?page=. */
  page: number
  records: any[]
  total: number
}

/**
 * One page of a version's records, for the records pages' loaders.
 *
 * v1 fetched records from the browser after hydration, so a records page
 * rendered empty on the server. Loading the page here puts the first table in
 * the SSR HTML, and the loader re-runs when ?type= or ?page= changes. v2 makes
 * offsets cheap (O(tree height)) and uncapped, so page numbers stay offsets.
 */
export async function loadRecordsPage(
  api: LoaderApi,
  prefix: string,
  version: { semver: string; schemas?: Record<string, unknown> },
  requestUrl: string,
): Promise<RecordsPage> {
  const params = new URL(requestUrl).searchParams
  const types = Object.keys(version.schemas ?? {}).sort()
  const type = params.get('type') || types[0] || null
  const page = Math.max(1, parseInt(params.get('page') ?? '1', 10) || 1)
  if (!type) return { type, page, records: [], total: 0 }
  const q = new URLSearchParams({
    type,
    limit: String(RECORDS_PAGE_SIZE),
    offset: String((page - 1) * RECORDS_PAGE_SIZE),
  })
  const body = await api.json<{ records?: any[]; pagination?: { total?: number } }>(
    `${prefix}/versions/${version.semver}/records?${q}`,
    {},
  )
  return { type, page, records: body.records ?? [], total: body.pagination?.total ?? 0 }
}
