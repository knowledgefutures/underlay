/**
 * A schema drafted from a table's columns, for a type that has none yet: a field for each
 * column but the id, its type guessed from every value, required where no row leaves it blank,
 * and columns that look personal left out until someone keeps them. The importer skips blank
 * cells, so a field that isn't required is simply absent from those records.
 */
import { PERSONAL, type Table } from './importers.js'

export const TYPES = [
  'text',
  'number',
  'whole number',
  'true or false',
  'date',
  'date and time',
] as const
export type FieldType = (typeof TYPES)[number]

export interface ColumnDraft {
  column: string
  field: string
  type: FieldType
  keep: boolean
  required: boolean
  /** Why it was drafted so, in a few words. */
  why: string
}

const isBlank = (v: unknown) => v === null || v === undefined || v === ''
const DATE = /^\d{4}-\d{2}-\d{2}$/
const DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/
const BOOL = /^(true|false|yes|no)$/i

function guess(values: unknown[]): FieldType {
  if (!values.length) return 'text'
  const s = values.map((v) => (v instanceof Date ? v.toISOString() : v))
  if (s.every((v) => typeof v === 'boolean' || (typeof v === 'string' && BOOL.test(v))))
    return 'true or false'
  if (
    s.every(
      (v) =>
        typeof v === 'number' ||
        (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))),
    )
  )
    return s.every((v) => Number.isInteger(Number(v))) ? 'whole number' : 'number'
  if (s.every((v) => typeof v === 'string' && DATE.test(v))) return 'date'
  if (s.every((v) => typeof v === 'string' && (DATETIME.test(v) || DATE.test(v))))
    return 'date and time'
  return 'text'
}

/** A field name for a column: letters, numbers and underscores, starting with a letter. */
export const fieldOf = (column: string) =>
  column
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^(\d)/, 'f_$1') || 'field'

const n = (x: number) => x.toLocaleString('en-US')

/** Draft a field for each column of a table but its id column. */
export function draftColumns(t: Table, id: string): ColumnDraft[] {
  const rows = t.rows
  const out: ColumnDraft[] = []
  const idVals = rows.map((r) => r[id]).filter((v) => !isBlank(v))
  const idDistinct = new Set(idVals.map(String)).size
  out.push({
    column: id,
    field: id,
    type: 'text',
    keep: true,
    required: true,
    why: `the id: ${n(idVals.length)} values, ${idVals.length === rows.length ? 'none blank' : `${n(rows.length - idVals.length)} blank`}, ${idDistinct === idVals.length ? 'none repeated' : `${n(idVals.length - idDistinct)} repeated`}`,
  })
  for (const column of t.columns) {
    if (column === id) continue
    const values = rows.map((r) => r[column]).filter((v) => !isBlank(v))
    const blanks = rows.length - values.length
    const type = guess(values)
    const personal = PERSONAL.test(column)
    const distinct = [...new Set(values.map(String))]
    let why: string
    if (personal) why = 'looks personal; space keeps it'
    else if (!values.length) why = 'blank in every row'
    else if ((type === 'date' || type === 'date and time') && values.length) {
      const sorted = values.map(String).sort()
      why = `${sorted[0]} to ${sorted.at(-1)}`
    } else if ((type === 'number' || type === 'whole number') && values.length) {
      const nums = values.map(Number)
      why = `${n(Math.min(...nums))} to ${n(Math.max(...nums))}`
    } else if (distinct.length <= 6 && distinct.length < values.length)
      why = `${distinct.length} values: ${distinct.join(', ')}`
    else why = blanks ? `blank in ${n(blanks)} of ${n(rows.length)} rows` : 'required: never blank'
    if (blanks && !personal && !why.startsWith('blank'))
      why += blanks ? ` · blank in ${n(blanks)} of ${n(rows.length)}` : ''
    out.push({
      column,
      field: fieldOf(column),
      type,
      keep: !personal && values.length > 0,
      required: blanks === 0 && values.length > 0,
      why,
    })
  }
  return out
}

const SCHEMA_OF: Record<FieldType, Record<string, unknown>> = {
  text: { type: 'string' },
  number: { type: 'number' },
  'whole number': { type: 'integer' },
  'true or false': { type: 'boolean' },
  date: { type: 'string', format: 'date' },
  'date and time': { type: 'string', format: 'date-time' },
}

/** The JSON Schema for a type from its drafted columns (the id column is the record's id). */
export function schemaFrom(drafts: ColumnDraft[], id: string): Record<string, unknown> {
  const fields = drafts.filter((d) => d.keep && d.column !== id)
  return {
    type: 'object',
    properties: Object.fromEntries(fields.map((d) => [d.field, SCHEMA_OF[d.type]])),
    required: fields.filter((d) => d.required).map((d) => d.field),
  }
}
