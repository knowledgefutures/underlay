/** Small formatters shared by the commands and the terminal UI. */
import { v3 } from '@underlay/protocol'

import type { Coll } from './context.js'
import { viewOf } from './versions.js'

export function ago(iso: string | null, now = new Date()): string {
  if (!iso) return 'never'
  const s = Math.max(0, (now.getTime() - Date.parse(iso)) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`
  return iso.slice(0, 10)
}

export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '–'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000
    i++
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

export const count = (n: number | null | undefined) =>
  n === null || n === undefined ? '–' : n.toLocaleString('en-US')

export const shortId = (id: string) => id.replace(/^ul:ver:/, '').slice(0, 6)

export function duration(fromIso: string, toIso: string | null, now = new Date()): string {
  const s = Math.max(0, ((toIso ? Date.parse(toIso) : now.getTime()) - Date.parse(fromIso)) / 1000)
  if (s < 60) return `${Math.round(s)}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

export interface DiffRow {
  type: string
  id: string
  kind: '+' | '~' | '-'
  /** For a changed record: the top-level fields that changed (for the first few only). */
  fields?: string[]
}

/** What changed between two versions here: each key, and counts by type. */
export async function diffVersions(
  c: Coll,
  from: number,
  to: number,
  limit = 200,
  fieldsFor = 12,
): Promise<{
  rows: DiffRow[]
  byType: Record<string, { added: number; changed: number; removed: number }>
  more: boolean
}> {
  const view = await viewOf(c, to)
  const byType: Record<string, { added: number; changed: number; removed: number }> = {}
  const rows: DiffRow[] = []
  let more = false
  if (to === 0) return { rows, byType, more }
  const before = from > 0 ? await viewOf(c, from) : null
  let fieldsLeft = fieldsFor
  for await (const ch of v3.changes(c.data, view, from, { before: true })) {
    // Reserved rows ($schema, $asset, $meta) aren't records.
    if (ch.type.startsWith('$')) continue
    const kind = !ch.before ? '+' : !ch.after ? '-' : '~'
    const t = (byType[ch.type] ??= { added: 0, changed: 0, removed: 0 })
    if (kind === '+') t.added++
    else if (kind === '-') t.removed++
    else t.changed++
    if (rows.length >= limit) {
      more = true
      continue
    }
    const row: DiffRow = { type: ch.type, id: ch.id, kind }
    if (kind === '~' && before && fieldsLeft > 0) {
      fieldsLeft--
      row.fields = changedFields(
        await ch.line(),
        (await v3.getRecord(c.data, before, ch.type, ch.id))?.line ?? null,
      )
    }
    rows.push(row)
  }
  return { rows, byType, more }
}

const dec = new TextDecoder()
/** The top-level fields of a record's data that differ between two of its lines. */
function changedFields(a: Uint8Array | null, b: Uint8Array | null): string[] {
  if (!a || !b) return []
  const da = (JSON.parse(dec.decode(a)) as { data?: Record<string, unknown> }).data ?? {}
  const db = (JSON.parse(dec.decode(b)) as { data?: Record<string, unknown> }).data ?? {}
  const keys = new Set([...Object.keys(da), ...Object.keys(db)])
  return [...keys].filter((k) => JSON.stringify(da[k]) !== JSON.stringify(db[k]))
}

/** A count and its noun, singular for one: `counted(1, 'asset')` is "1 asset". */
export const counted = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
