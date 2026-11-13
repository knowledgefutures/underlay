/**
 * A record as a list of records shows it: each top-level value cut to what a table cell
 * can show. A records page sends previews (`?preview=1`), not whole records: a page of 50
 * Crossref book chapters was 1.6 MB, 1.47 MB of it records the table never showed (each
 * chapter's reference list), sent again for the browser to hydrate. A record's own page has
 * it whole.
 *
 * A string longer than `PREVIEW_CHARS` is cut and ends in `…`; an object or array whose
 * JSON is longer becomes `{"$preview": "<its JSON, cut>"}`; a file reference (`$file`) and
 * anything shorter are kept as they are.
 */
export const PREVIEW_CHARS = 200

function previewValue(v: unknown): unknown {
  if (typeof v === 'string') return v.length > PREVIEW_CHARS ? `${v.slice(0, PREVIEW_CHARS)}…` : v
  if (v === null || typeof v !== 'object') return v
  if (!Array.isArray(v) && '$file' in v) return v
  const json = JSON.stringify(v)
  return json.length > PREVIEW_CHARS ? { $preview: `${json.slice(0, PREVIEW_CHARS)}…` } : v
}

/** A record's data, previewed: a top-level object's values each cut. */
export function previewData(data: unknown): unknown {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return previewValue(data)
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(data)) out[k] = previewValue(v)
  return out
}

/** A record as the API returns it, previewed, and marked so. */
export const previewRecord = <T extends { data: unknown }>(r: T): T & { preview: true } => ({
  ...r,
  data: previewData(r.data),
  preview: true,
})
