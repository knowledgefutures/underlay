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
 * A records page's version and first table in one call: `GET …/versions/:n
 * ?records=<type>` gives the version, a page of that type's records, and only
 * that type's schema (the type list is `typeCounts`).
 */
export async function loadVersionRecords(
  api: LoaderApi,
  prefix: string,
  n: string,
  requestUrl: string,
): Promise<{ version: any; records: RecordsPage } | null> {
  const params = new URL(requestUrl).searchParams
  const page = Math.max(1, parseInt(params.get('page') ?? '1', 10) || 1)
  const q = new URLSearchParams({
    records: params.get('type') ?? '',
    limit: String(RECORDS_PAGE_SIZE),
    offset: String((page - 1) * RECORDS_PAGE_SIZE),
  })
  const version = await api.json<any>(`${prefix}/versions/${n}?${q}`, null)
  if (!version) return null
  const r = version.recordsPage ?? { type: null, records: [], total: 0 }
  return { version, records: { type: r.type, page, records: r.records, total: r.total } }
}
