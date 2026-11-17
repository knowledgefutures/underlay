/**
 * The new-collection form: one form used three ways, from n in Collections, from a file that
 * matches nothing here, and from a run that wrote a collection that isn't here. Those fill in
 * what they know.
 */
import { blank, C, caps, L, type Line, P, type Pane, S } from './lines.js'

export type NewField = 'server' | 'org' | 'name' | 'title' | 'type' | 'access'

export interface NewForm {
  servers: string[]
  server: string
  /** Your orgs on the server; null when signed out there (the org is typed instead). */
  orgs: string[] | null
  org: string
  name: string
  title: string
  /** The type its records take, when it starts from a file or a run. */
  type: string | null
  access: 'private' | 'public'
  field: NewField
  /** What it starts from, for the title's note: "from roster-2026.csv". */
  from: string | null
  /** What enter does after making it: "make it, then shape its schema". */
  then: string | null
}

export const fieldsOf = (f: NewForm): NewField[] => [
  'server',
  'org',
  'name',
  ...(f.type !== null ? (['type'] as const) : []),
  'title',
  'access',
]

/** Fields typed into, rather than chosen with ←→ or space. */
export const typedField = (f: NewForm, field: NewField) =>
  field === 'name' || field === 'title' || field === 'type' || (field === 'org' && !f.orgs)

export function newPane(f: NewForm, problem: string | null, width: number): Pane {
  const row = (field: NewField, value: string, hint: string, valueColor: string = C.fg): Line => {
    const on = f.field === field
    const shown = on && typedField(f, field) ? value + '▏' : value || (on ? '▏' : '')
    return L(
      [
        S(on ? '▌ ' : '  ', C.bl),
        S(P(field, 9), C.mu),
        S(P(shown, 24), on ? C.wh : valueColor, on),
        S(hint, C.mu),
      ],
      on ? C.sel : undefined,
    )
  }
  const lines: Line[] = [
    row('server', f.server, f.servers.length > 1 ? '←→ your servers' : '', C.bl),
    row(
      'org',
      f.org,
      f.orgs
        ? f.orgs.length > 1
          ? '←→ your orgs there'
          : ''
        : `sign in to choose: underlay login ${f.server}`,
      C.bl,
    ),
    row(
      'name',
      f.name,
      f.from ? `from ${f.from.includes('run') ? 'what the run named' : "the file's name"}` : '',
    ),
  ]
  if (f.type !== null)
    lines.push(row('type', f.type, `one type per sheet; its records are ${f.type || 'records'}s`))
  lines.push(
    row('title', f.title, `shown on ${f.server}; optional`),
    row('access', f.access, 'space: private or public', f.access === 'public' ? C.or : C.fg),
    blank(),
  )
  const key = `${f.server}/${f.org || '<org>'}/${f.name || '<name>'}`
  lines.push(
    L([S(`  Makes ${key} here. Nothing leaves this machine until you push;`, C.mu)]),
    L([S(`  the first push creates it on ${f.server}.`, C.mu)]),
  )
  if (problem) lines.push(blank(), L([S(`  ${problem}`, C.or)]))
  lines.push(
    blank(),
    ...caps(
      [
        { k: 'enter', l: f.then ?? 'make it' },
        { k: 'tab', l: 'next field' },
        { k: 'esc', l: 'cancel' },
      ],
      width - 2,
    ),
  )
  return {
    title: 'New collection',
    meta: f.from ? `from ${f.from}` : 'esc cancels',
    lines,
    keys: [
      { k: 'enter', l: f.then ?? 'make it' },
      { k: 'tab', l: 'next field' },
      { k: 'esc', l: 'cancel' },
    ],
  }
}
